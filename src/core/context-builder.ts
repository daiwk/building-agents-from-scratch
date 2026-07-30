import type {
  AgentContext,
  AgentMessage,
  ModelRequest,
} from "./types.js";

/**
 * ContextBuilder 决定“完整历史中的哪些内容在本轮发给模型”。
 *
 * ConversationStore 仍然保存完整历史；ContextBuilder 只创建一次模型请求的只读快照。
 * 这样截断不会悄悄删除用户的 memory，也不会污染 AgentContext。
 */
export type BuiltContext = Pick<
  ModelRequest,
  "systemPrompt" | "messages" | "tools"
>;

export type ContextBuilder = {
  build(context: Readonly<AgentContext>): Promise<BuiltContext> | BuiltContext;
};

export type RecentContextBuilderOptions = {
  maxMessages?: number;
  maxCharacters?: number;
};

/**
 * 保留最近完整对话轮次的教学版 ContextBuilder。
 *
 * 它使用字符数近似 token 数，避免为了教学引入 tokenizer 依赖。真正的生产系统可以
 * 实现同一个 ContextBuilder 接口，换成精确 token 预算、摘要或检索结果。
 */
export class RecentContextBuilder implements ContextBuilder {
  private readonly maxMessages: number;
  private readonly maxCharacters: number;

  constructor(options: RecentContextBuilderOptions = {}) {
    this.maxMessages = options.maxMessages ?? 40;
    this.maxCharacters = options.maxCharacters ?? 50_000;
    assertPositiveInteger("maxMessages", this.maxMessages);
    assertPositiveInteger("maxCharacters", this.maxCharacters);
  }

  build(context: Readonly<AgentContext>): BuiltContext {
    return {
      systemPrompt: context.systemPrompt,
      messages: selectRecentTurns(
        context.messages,
        this.maxMessages,
        this.maxCharacters,
      ),
      tools: context.tools,
    };
  }
}

function selectRecentTurns(
  messages: readonly AgentMessage[],
  maxMessages: number,
  maxCharacters: number,
): AgentMessage[] {
  const turns = groupIntoTurns(messages);
  const selected: AgentMessage[][] = [];
  let messageCount = 0;
  let characterCount = 0;

  // 从最新轮次向前装填。即使最新轮本身超过预算，也必须完整保留，避免只留下
  // tool result，却丢掉对应的 assistant tool call。
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    const nextMessageCount = messageCount + turn.length;
    const nextCharacterCount =
      characterCount + turn.reduce(countMessageCharacters, 0);
    const exceedsBudget =
      nextMessageCount > maxMessages ||
      nextCharacterCount > maxCharacters;
    if (selected.length > 0 && exceedsBudget) break;
    selected.unshift(turn);
    messageCount = nextMessageCount;
    characterCount = nextCharacterCount;
  }

  return selected.flat();
}

/**
 * 一条 user message 开始一个新轮次；之后的 assistant/tool messages 属于同一轮。
 */
function groupIntoTurns(
  messages: readonly AgentMessage[],
): AgentMessage[][] {
  const turns: AgentMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns.at(-1)?.push(message);
  }
  return turns;
}

function countMessageCharacters(
  total: number,
  message: AgentMessage,
): number {
  return total + JSON.stringify(message).length;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}
