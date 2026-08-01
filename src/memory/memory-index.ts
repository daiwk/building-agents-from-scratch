import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentHooks,
  AgentMessage,
  BuiltContext,
  ContextBuilder,
  AgentContext,
} from "../core/index.js";

export type MemoryKind = "episodic" | "semantic" | "procedural";

export type MemoryRecord = {
  id: string;
  kind: MemoryKind;
  content: string;
  createdAtUnixMs: number;
  metadata?: Record<string, string>;
};

export type MemorySearchOptions = { limit?: number; kinds?: MemoryKind[] };

export type MemoryIndex = {
  upsert(record: MemoryRecord): Promise<void>;
  search(query: string, options?: MemorySearchOptions): Promise<MemoryRecord[]>;
  remove(id: string): Promise<void>;
};

export class InMemoryMemoryIndex implements MemoryIndex {
  private readonly records = new Map<string, MemoryRecord>();

  async upsert(record: MemoryRecord): Promise<void> {
    validateRecord(record);
    this.records.set(record.id, structuredClone(record));
  }

  async search(
    query: string,
    options: MemorySearchOptions = {},
  ): Promise<MemoryRecord[]> {
    return rankMemories([...this.records.values()], query, options);
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }
}

type MemoryRow = {
  id: string;
  kind: MemoryKind;
  content: string;
  created_at_unix_ms: number;
  metadata_json: string;
};

/** SQLite 只负责持久化；透明的 BM25-like 排序保持在代码里，便于初学者阅读和替换。 */
export class SqliteMemoryIndex implements MemoryIndex {
  readonly filePath: string;
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    if (!filePath.trim()) throw new Error("Memory index path is required.");
    this.filePath = resolve(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.database = new DatabaseSync(this.filePath);
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at_unix_ms INTEGER NOT NULL,
      metadata_json TEXT NOT NULL
    )`);
    chmodSync(this.filePath, 0o600);
  }

  async upsert(record: MemoryRecord): Promise<void> {
    validateRecord(record);
    this.database.prepare(`INSERT INTO memories
      (id, kind, content, created_at_unix_ms, metadata_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, content=excluded.content,
      created_at_unix_ms=excluded.created_at_unix_ms, metadata_json=excluded.metadata_json`
    ).run(
      record.id,
      record.kind,
      record.content,
      record.createdAtUnixMs,
      JSON.stringify(record.metadata ?? {}),
    );
  }

  async search(
    query: string,
    options: MemorySearchOptions = {},
  ): Promise<MemoryRecord[]> {
    const rows = this.database.prepare(
      "SELECT id, kind, content, created_at_unix_ms, metadata_json FROM memories",
    ).all() as unknown as MemoryRow[];
    return rankMemories(
      rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        content: row.content,
        createdAtUnixMs: row.created_at_unix_ms,
        metadata: JSON.parse(row.metadata_json) as Record<string, string>,
      })),
      query,
      options,
    );
  }

  async remove(id: string): Promise<void> {
    this.database.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  close(): void {
    this.database.close();
  }
}

export function createMemoryRecallHook(
  basePrompt: string,
  index: MemoryIndex,
  options: MemorySearchOptions = {},
): AgentHooks {
  return {
    async beforeModel(context) {
      const query = latestUserText(context.messages);
      const memories = query ? await index.search(query, options) : [];
      const section = memories.map((memory) =>
        `<memory kind="${memory.kind}" id="${escapeAttribute(memory.id)}">${escapeText(memory.content)}</memory>`,
      ).join("\n");
      context.systemPrompt = section
        ? `${basePrompt}\n\n# Relevant memories\n\n${section}`
        : basePrompt;
    },
  };
}

/** 包装任意 ContextBuilder，在不修改完整历史的前提下追加检索结果。 */
export class MemoryRecallContextBuilder implements ContextBuilder {
  constructor(
    private readonly index: MemoryIndex,
    private readonly delegate?: ContextBuilder,
    private readonly options: MemorySearchOptions = {},
  ) {}

  async build(context: Readonly<AgentContext>): Promise<BuiltContext> {
    const built = this.delegate
      ? await this.delegate.build(context)
      : {
          systemPrompt: context.systemPrompt,
          messages: context.messages,
          tools: context.tools,
        };
    const query = latestUserText(context.messages);
    const memories = query ? await this.index.search(query, this.options) : [];
    const section = memories.map((memory) =>
      `<memory kind="${memory.kind}" id="${escapeAttribute(memory.id)}">${escapeText(memory.content)}</memory>`,
    ).join("\n");
    return {
      ...built,
      systemPrompt: section
        ? `${built.systemPrompt}\n\n# Relevant memories\n\n${section}`
        : built.systemPrompt,
    };
  }
}

function rankMemories(
  records: readonly MemoryRecord[],
  query: string,
  options: MemorySearchOptions,
): MemoryRecord[] {
  const terms = tokenize(query);
  const allowed = options.kinds ? new Set(options.kinds) : undefined;
  const candidates = records.filter(
    (record) => !allowed || allowed.has(record.kind),
  );
  const documentFrequency = new Map<string, number>();
  for (const term of new Set(terms)) {
    documentFrequency.set(
      term,
      candidates.filter((record) => tokenize(record.content).includes(term)).length,
    );
  }
  return candidates.map((record, order) => {
    const words = tokenize(record.content);
    const score = terms.reduce((total, term) => {
      const frequency = words.filter((word) => word === term).length;
      const idf = Math.log(
        1 + (candidates.length + 1) /
          ((documentFrequency.get(term) ?? 0) + 1),
      );
      return total + frequency * idf / (words.length + 1);
    }, 0);
    return { record, order, score };
  }).filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.record.createdAtUnixMs - a.record.createdAtUnixMs ||
        a.order - b.order,
    )
    .slice(0, options.limit ?? 5)
    .map((item) => structuredClone(item.record));
}

function tokenize(text: string): string[] {
  return (
    text.toLocaleLowerCase().match(/\p{Script=Han}|[a-z0-9][a-z0-9_-]*/gu) ?? []
  );
}

function latestUserText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return typeof message.content === "string"
      ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
  }
  return "";
}

function validateRecord(record: MemoryRecord): void {
  if (!/^[\w-]{1,120}$/.test(record.id)) throw new Error("Invalid memory id.");
  if (!record.content.trim()) throw new Error("Memory content is required.");
  if (!["episodic", "semantic", "procedural"].includes(record.kind)) {
    throw new Error(`Invalid memory kind: ${record.kind}`);
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
