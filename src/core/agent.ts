import {
  agentLoop,
  type AgentHooks,
  type AgentLoopOptions,
} from "./agent-loop.js";
import type {
  AgentContext,
  AgentEvent,
  AssistantMessage,
  ModelProvider,
  Tool,
} from "./types.js";
import type { ModelCallPolicy } from "./model-call.js";

export type AgentOptions = {
  model: ModelProvider;
  systemPrompt?: string;
  tools?: Tool[];
  maxTurns?: number;
  hooks?: AgentHooks;
  modelCall?: ModelCallPolicy;
};

/**
 * Agent 是纯函数 agentLoop() 外面的一层“有状态外壳”。
 *
 * 初学时先看 agent-loop.ts；这个 class 只负责保存对话历史，让调用者不用每次手动
 * 传递 Context。`private` 表示字段只能在类内部访问，`readonly` 表示引用不能替换。
 */
export class Agent {
  readonly context: AgentContext;
  private readonly model: ModelProvider;
  private readonly maxTurns: number;
  private readonly hooks: AgentHooks | undefined;
  private readonly modelCall: ModelCallPolicy | undefined;

  constructor(options: AgentOptions) {
    // `??` 是空值合并：左边为 undefined 时才使用右边的默认值。
    this.model = options.model;
    this.maxTurns = options.maxTurns ?? 8;
    this.hooks = options.hooks;
    this.modelCall = options.modelCall;
    this.context = {
      systemPrompt: options.systemPrompt ?? "You are a helpful assistant.",
      messages: [],
      tools: options.tools ?? [],
    };
  }

  async *run(
    input: string,
    options: AgentLoopOptions = {},
  ): AsyncGenerator<AgentEvent, AssistantMessage> {
    // 每次 run() 先把用户消息追加到同一份历史中，因此 Agent 记得之前的对话。
    this.context.messages.push({ role: "user", content: input });
    const hooks = options.hooks ?? this.hooks;
    const modelCall = options.modelCall ?? this.modelCall;
    // yield* 把内部生成器产生的事件原样转发给外部调用者。
    return yield* agentLoop(this.context, this.model, {
      maxTurns: options.maxTurns ?? this.maxTurns,
      ...(hooks ? { hooks } : {}),
      ...(modelCall ? { modelCall } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  reset(): void {
    // 保留同一个数组对象，只把内容清空，已有引用不会失效。
    this.context.messages.length = 0;
  }
}
