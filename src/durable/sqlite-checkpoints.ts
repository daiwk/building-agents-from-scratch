import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GraphCheckpoint, GraphCheckpointStore, GraphState } from "../graph/index.js";

/** SQLite checkpoint 可以在进程退出后继续被同一个 checkpointId 找到。 */
export class SqliteGraphCheckpointStore<TState extends GraphState>
implements GraphCheckpointStore<TState> {
  readonly filePath: string;
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    this.filePath = preparePath(filePath);
    this.database = new DatabaseSync(this.filePath);
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS graph_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        checkpoint_json TEXT NOT NULL,
        updated_at_unix_ms INTEGER NOT NULL
      )
    `);
    chmodSync(this.filePath, 0o600);
  }

  async load(id: string): Promise<GraphCheckpoint<TState> | undefined> {
    const row = this.database.prepare(
      "SELECT checkpoint_json FROM graph_checkpoints WHERE checkpoint_id = ?",
    ).get(requiredId(id)) as { checkpoint_json: string } | undefined;
    return row ? JSON.parse(row.checkpoint_json) as GraphCheckpoint<TState> : undefined;
  }

  async save(id: string, checkpoint: GraphCheckpoint<TState>): Promise<void> {
    this.database.prepare(`
      INSERT INTO graph_checkpoints(checkpoint_id, checkpoint_json, updated_at_unix_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(checkpoint_id) DO UPDATE SET
        checkpoint_json = excluded.checkpoint_json,
        updated_at_unix_ms = excluded.updated_at_unix_ms
    `).run(requiredId(id), JSON.stringify(checkpoint), Date.now());
  }

  async clear(id: string): Promise<void> {
    this.database.prepare("DELETE FROM graph_checkpoints WHERE checkpoint_id = ?").run(requiredId(id));
  }

  close(): void { this.database.close(); }
}

function preparePath(filePath: string): string {
  if (!filePath.trim()) throw new Error("SQLite path is required.");
  const absolute = resolve(filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  return absolute;
}

function requiredId(id: string): string {
  if (!id.trim()) throw new Error("checkpointId is required.");
  return id;
}
