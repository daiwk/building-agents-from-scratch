import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  validateSessionId,
  type AgentMessage,
} from "../core/index.js";

type ConversationRow = { messages_json: string };

/**
 * 使用 Node.js 内置 SQLite 的 ConversationStore，不增加第三方依赖。
 *
 * 每个 session 占一行，messages 仍保存成容易理解的 JSON 数组。SQLite 负责事务、
 * 多进程写入协调和按 session 查询；Agent loop 完全不知道底层从 JSON 文件换成了数据库。
 */
export class SqliteConversationStore<TMessage = AgentMessage> {
  readonly filePath: string;
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    if (!filePath.trim()) throw new Error("SQLite memory path is required.");
    this.filePath = resolve(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.database = new DatabaseSync(this.filePath);
    // 等待短暂的并发写锁，而不是立刻用 SQLITE_BUSY 让当前请求失败。
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        session_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        updated_at_unix_ms INTEGER NOT NULL
      )
    `);
    chmodSync(this.filePath, 0o600);
  }

  async load(sessionId: string): Promise<TMessage[]> {
    validateSessionId(sessionId);
    const row = this.database
      .prepare("SELECT messages_json FROM conversations WHERE session_id = ?")
      .get(sessionId) as ConversationRow | undefined;
    if (!row) return [];
    const messages: unknown = JSON.parse(row.messages_json);
    if (!Array.isArray(messages)) {
      throw new Error("SQLite memory conversation must be an array.");
    }
    return structuredClone(messages as TMessage[]);
  }

  async save(
    sessionId: string,
    messages: readonly TMessage[],
  ): Promise<void> {
    validateSessionId(sessionId);
    const payload = JSON.stringify(structuredClone([...messages]));
    this.database.prepare(`
      INSERT INTO conversations(session_id, messages_json, updated_at_unix_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        messages_json = excluded.messages_json,
        updated_at_unix_ms = excluded.updated_at_unix_ms
    `).run(sessionId, payload, Date.now());
  }

  async clear(sessionId: string): Promise<void> {
    validateSessionId(sessionId);
    this.database
      .prepare("DELETE FROM conversations WHERE session_id = ?")
      .run(sessionId);
  }

  /** 测试或短生命周期脚本可主动关闭；常驻 CLI/Web 让进程退出时统一回收。 */
  close(): void {
    this.database.close();
  }
}
