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

/** Tokenizer 属于模型协议；注入后，ContextBuilder 不需要猜测供应商的切词规则。 */
export type TokenCounter = {
  count(text: string): number;
};

export type SummaryProvider = {
  summarize(messages: readonly AgentMessage[]): Promise<string> | string;
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

export type TokenContextBuilderOptions = {
  maxTokens: number;
  tokenCounter: TokenCounter;
  summarizer?: SummaryProvider;
};

/**
 * 按调用者提供的真实 tokenizer 保留完整轮次，并可把被裁掉的旧轮次压成摘要。
 * 摘要只进入本轮 system prompt；ConversationStore 中的原始消息不会被覆盖。
 */
export class TokenContextBuilder implements ContextBuilder {
  constructor(private readonly options: TokenContextBuilderOptions) {
    assertPositiveInteger("maxTokens", options.maxTokens);
  }

  async build(context: Readonly<AgentContext>): Promise<BuiltContext> {
    const turns = groupIntoTurns(context.messages);
    const selected: AgentMessage[][] = [];
    let used =
      this.options.tokenCounter.count(context.systemPrompt) +
      this.options.tokenCounter.count(JSON.stringify(context.tools));
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!turn) continue;
      const cost = this.options.tokenCounter.count(JSON.stringify(turn));
      if (selected.length > 0 && used + cost > this.options.maxTokens) break;
      selected.unshift(turn);
      used += cost;
    }
    const selectedCount = selected.reduce(
      (total, turn) => total + turn.length,
      0,
    );
    const omitted = context.messages.slice(
      0,
      context.messages.length - selectedCount,
    );
    const rawSummary = omitted.length > 0 && this.options.summarizer
      ? (await this.options.summarizer.summarize(omitted)).trim()
      : "";
    const summaryWrapper = "\n\n<conversation_summary>\n\n</conversation_summary>";
    const summaryBudget = Math.max(
      0,
      this.options.maxTokens -
        used -
        this.options.tokenCounter.count(summaryWrapper),
    );
    const summary = fitTextToTokenBudget(
      rawSummary,
      summaryBudget,
      this.options.tokenCounter,
    );
    return {
      systemPrompt: summary
        ? `${context.systemPrompt}\n\n<conversation_summary>\n${summary}\n</conversation_summary>`
        : context.systemPrompt,
      messages: selected.flat(),
      tools: context.tools,
    };
  }
}

function fitTextToTokenBudget(
  text: string,
  maxTokens: number,
  counter: TokenCounter,
): string {
  if (!text || maxTokens <= 0) return "";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (counter.count(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

/** 无模型、可预测的教学摘要器；生产环境可在同一接口接专用摘要模型。 */
export class ExtractiveSummaryProvider implements SummaryProvider {
  constructor(private readonly maxCharacters = 2_000) {
    assertPositiveInteger("maxCharacters", maxCharacters);
  }

  summarize(messages: readonly AgentMessage[]): string {
    const lines = messages.map((message) => {
      if (message.role === "user") {
        const content = typeof message.content === "string"
          ? message.content
          : message.content.map((block) =>
              block.type === "text" ? block.text : `[image: ${block.source.mediaType}]`
            ).join(" ");
        return `user: ${content}`;
      }
      if (message.role === "tool") {
        return `tool(${message.toolName}): ${message.content}`;
      }
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ");
      return `assistant: ${text || `[${message.stopReason}]`}`;
    });
    return lines.join("\n").slice(-this.maxCharacters);
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
export function groupIntoTurns(
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
