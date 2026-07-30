import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateSessionId,
  type AgentMessage,
} from "../core/index.js";

type MemoryFile<TMessage> = {
  version: 1;
  conversations: Record<string, TMessage[]>;
};

/**
 * 一个便于教学和本地调试的 JSON memory。
 *
 * - 写入先落到临时文件，再 rename，避免进程中断留下半个 JSON；
 * - 同一个 store 实例内的写入会排队，避免多个 Web 会话互相覆盖；
 * - 文件默认权限为 0600，因为消息历史可能包含敏感内容。
 *
 * 多进程或生产服务应换成 SQLite/PostgreSQL，而不是共享这个 JSON 文件。
 */
export class JsonFileConversationStore<TMessage = AgentMessage> {
  readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    if (!filePath.trim()) throw new Error("Memory file path is required.");
    this.filePath = resolve(filePath);
  }

  async load(sessionId: string): Promise<TMessage[]> {
    validateSessionId(sessionId);
    await this.writeQueue.catch(() => undefined);
    const data = await this.readData();
    return structuredClone(data.conversations[sessionId] ?? []);
  }

  save(
    sessionId: string,
    messages: readonly TMessage[],
  ): Promise<void> {
    validateSessionId(sessionId);
    const snapshot = structuredClone([...messages]);
    return this.enqueue(async () => {
      const data = await this.readData();
      data.conversations[sessionId] = snapshot;
      await this.writeData(data);
    });
  }

  clear(sessionId: string): Promise<void> {
    validateSessionId(sessionId);
    return this.enqueue(async () => {
      const data = await this.readData();
      delete data.conversations[sessionId];
      await this.writeData(data);
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    // 即使前一次写入失败，后续操作仍可继续尝试；当前调用者仍会收到本次错误。
    const task = this.writeQueue.catch(() => undefined).then(operation);
    this.writeQueue = task;
    return task;
  }

  private async readData(): Promise<MemoryFile<TMessage>> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<MemoryFile<TMessage>>;
      if (
        parsed.version !== 1 ||
        typeof parsed.conversations !== "object" ||
        parsed.conversations === null
      ) {
        throw new Error("Unsupported memory file format.");
      }
      for (const messages of Object.values(parsed.conversations)) {
        if (!Array.isArray(messages)) {
          throw new Error("Memory conversation must be an array.");
        }
      }
      return parsed as MemoryFile<TMessage>;
    } catch (error) {
      if (isFileNotFound(error)) {
        return { version: 1, conversations: {} };
      }
      throw error;
    }
  }

  private async writeData(data: MemoryFile<TMessage>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
