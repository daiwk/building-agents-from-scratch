import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "../core/index.js";

export type DurableTaskStatus = "pending" | "running" | "completed" | "failed";
export type DurableTask = {
  taskId: string; kind: string; payload: JsonValue; status: DurableTaskStatus;
  result?: JsonValue; error?: string; workerId?: string; leaseUntil?: number;
  createdAt: number; updatedAt: number;
};
export type DurableEvent = {
  id: number; taskId: string; type: string; payload: JsonValue; createdAt: number;
};
type TaskRow = {
  task_id: string; kind: string; payload_json: string; status: DurableTaskStatus;
  result_json: string | null; error: string | null; worker_id: string | null;
  lease_until_unix_ms: number | null; created_at_unix_ms: number; updated_at_unix_ms: number;
};

/** 持久化 task queue：幂等 taskId、单 worker lease、append-only event log。 */
export class SqliteDurableTaskStore {
  readonly filePath: string;
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    if (!filePath.trim()) throw new Error("SQLite task path is required.");
    this.filePath = resolve(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.database = new DatabaseSync(this.filePath);
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS durable_tasks (
        task_id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, result_json TEXT, error TEXT, worker_id TEXT,
        lease_until_unix_ms INTEGER, created_at_unix_ms INTEGER NOT NULL,
        updated_at_unix_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS durable_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at_unix_ms INTEGER NOT NULL
      );
    `);
    chmodSync(this.filePath, 0o600);
  }

  enqueue(kind: string, payload: JsonValue, taskId: string = randomUUID()): DurableTask {
    required(kind, "kind");
    required(taskId, "taskId");
    const payloadJson = stableJson(payload);
    const now = Date.now();
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO durable_tasks(
        task_id, kind, payload_json, status, created_at_unix_ms, updated_at_unix_ms
      ) VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(taskId, kind, payloadJson, now, now);
    const task = this.get(taskId)!;
    if (inserted.changes === 0 && (task.kind !== kind || stableJson(task.payload) !== payloadJson)) {
      throw new Error(`Idempotency conflict for taskId ${taskId}.`);
    }
    if (inserted.changes > 0) this.appendEvent(taskId, "enqueued", { kind });
    return this.get(taskId)!;
  }

  get(taskId: string): DurableTask | undefined {
    const row = this.database.prepare(
      "SELECT * FROM durable_tasks WHERE task_id = ?",
    ).get(required(taskId, "taskId")) as TaskRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  claim(workerId: string, leaseMs = 30_000): DurableTask | undefined {
    required(workerId, "workerId");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive.");
    const now = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const expired = this.database.prepare(`
        SELECT task_id, worker_id FROM durable_tasks
        WHERE status = 'running' AND lease_until_unix_ms < ?
      `).all(now) as { task_id: string; worker_id: string | null }[];
      this.database.prepare(`
        UPDATE durable_tasks SET status = 'pending', worker_id = NULL, lease_until_unix_ms = NULL,
          updated_at_unix_ms = ?
        WHERE status = 'running' AND lease_until_unix_ms < ?
      `).run(now, now);
      for (const task of expired) {
        this.appendEvent(task.task_id, "lease_expired", {
          previousWorkerId: task.worker_id ?? "unknown",
        });
      }
      const row = this.database.prepare(`
        SELECT * FROM durable_tasks WHERE status = 'pending'
        ORDER BY created_at_unix_ms, task_id LIMIT 1
      `).get() as TaskRow | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return undefined;
      }
      this.database.prepare(`
        UPDATE durable_tasks SET status = 'running', worker_id = ?,
          lease_until_unix_ms = ?, updated_at_unix_ms = ? WHERE task_id = ?
      `).run(workerId, now + leaseMs, now, row.task_id);
      this.appendEvent(row.task_id, "claimed", { workerId });
      this.database.exec("COMMIT");
      return this.get(row.task_id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  complete(taskId: string, workerId: string, result: JsonValue): DurableTask {
    return this.finish(taskId, workerId, "completed", result);
  }

  fail(taskId: string, workerId: string, error: string): DurableTask {
    return this.finish(taskId, workerId, "failed", null, error);
  }

  appendEvent(taskId: string, type: string, payload: JsonValue): DurableEvent {
    const now = Date.now();
    const result = this.database.prepare(`
      INSERT INTO durable_events(task_id, type, payload_json, created_at_unix_ms)
      VALUES (?, ?, ?, ?)
    `).run(required(taskId, "taskId"), required(type, "type"), JSON.stringify(payload), now);
    return { id: Number(result.lastInsertRowid), taskId, type, payload, createdAt: now };
  }

  events(taskId: string): DurableEvent[] {
    const rows = this.database.prepare(`
      SELECT id, task_id, type, payload_json, created_at_unix_ms
      FROM durable_events WHERE task_id = ? ORDER BY id
    `).all(required(taskId, "taskId")) as {
      id: number; task_id: string; type: string; payload_json: string; created_at_unix_ms: number;
    }[];
    return rows.map((row) => ({
      id: row.id, taskId: row.task_id, type: row.type,
      payload: JSON.parse(row.payload_json) as JsonValue, createdAt: row.created_at_unix_ms,
    }));
  }

  close(): void { this.database.close(); }

  private finish(
    taskId: string, workerId: string, status: "completed" | "failed",
    result: JsonValue, error?: string,
  ): DurableTask {
    const updated = this.database.prepare(`
      UPDATE durable_tasks SET status = ?, result_json = ?, error = ?,
        worker_id = NULL, lease_until_unix_ms = NULL, updated_at_unix_ms = ?
      WHERE task_id = ? AND status = 'running' AND worker_id = ?
    `).run(status, status === "completed" ? JSON.stringify(result) : null,
      error ?? null, Date.now(), required(taskId, "taskId"), required(workerId, "workerId"));
    if (updated.changes !== 1) throw new Error("Task is not owned by this worker.");
    this.appendEvent(taskId, status, status === "completed" ? { result } : { error: error ?? "failed" });
    return this.get(taskId)!;
  }
}

export type DurableTaskHandler = (
  payload: JsonValue,
  context: { taskId: string; appendEvent(type: string, payload: JsonValue): void },
) => Promise<JsonValue> | JsonValue;

export class DurableTaskRunner {
  constructor(
    private readonly store: SqliteDurableTaskStore,
    private readonly workerId: string,
    private readonly handlers: Readonly<Record<string, DurableTaskHandler>>,
  ) {}

  async runNext(): Promise<DurableTask | undefined> {
    const task = this.store.claim(this.workerId);
    if (!task) return undefined;
    const handler = this.handlers[task.kind];
    if (!handler) return this.store.fail(task.taskId, this.workerId, `No handler for ${task.kind}`);
    try {
      const result = await handler(task.payload, {
        taskId: task.taskId,
        appendEvent: (type, payload) => { this.store.appendEvent(task.taskId, type, payload); },
      });
      return this.store.complete(task.taskId, this.workerId, result);
    } catch (error) {
      return this.store.fail(
        task.taskId, this.workerId, error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function fromRow(row: TaskRow): DurableTask {
  return {
    taskId: row.task_id, kind: row.kind, payload: JSON.parse(row.payload_json) as JsonValue,
    status: row.status,
    ...(row.result_json ? { result: JSON.parse(row.result_json) as JsonValue } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.worker_id ? { workerId: row.worker_id } : {}),
    ...(row.lease_until_unix_ms ? { leaseUntil: row.lease_until_unix_ms } : {}),
    createdAt: row.created_at_unix_ms, updatedAt: row.updated_at_unix_ms,
  };
}

function required(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function stableJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key]!)]),
  );
}
