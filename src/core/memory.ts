import type { AgentMessage } from "./types.js";

/**
 * ConversationStore 只解决“保存整段消息历史”。
 *
 * 它不负责摘要、向量检索或决定哪些内容进入本轮 Context。把这些问题拆开，
 * 后续升级 memory 时才不会出现一个无所不包的巨型类。
 */
export type ConversationStore = {
  load(sessionId: string): Promise<AgentMessage[]>;
  save(
    sessionId: string,
    messages: readonly AgentMessage[],
  ): Promise<void>;
  clear(sessionId: string): Promise<void>;
};

export type AgentMemoryOptions = {
  sessionId: string;
  store: ConversationStore;
};

/**
 * 最简单的 memory 实现，适合测试和单进程应用；进程退出后数据消失。
 */
export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, AgentMessage[]>();

  async load(sessionId: string): Promise<AgentMessage[]> {
    validateSessionId(sessionId);
    return structuredClone(this.conversations.get(sessionId) ?? []);
  }

  async save(
    sessionId: string,
    messages: readonly AgentMessage[],
  ): Promise<void> {
    validateSessionId(sessionId);
    this.conversations.set(sessionId, structuredClone([...messages]));
  }

  async clear(sessionId: string): Promise<void> {
    validateSessionId(sessionId);
    this.conversations.delete(sessionId);
  }
}

export function validateSessionId(sessionId: string): void {
  if (!/^[\w-]{1,80}$/.test(sessionId)) {
    throw new Error(
      "sessionId must contain 1-80 letters, numbers, underscores, or hyphens.",
    );
  }
}
