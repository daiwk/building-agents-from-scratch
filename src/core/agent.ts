import {
  agentLoop,
  type AgentHooks,
  type AgentLoopOptions,
} from "./agent-loop.js";
import type {
  AgentContext,
  AgentBudget,
  AgentEvent,
  AssistantMessage,
  ModelProvider,
  Tool,
} from "./types.js";
import type { ModelCallPolicy } from "./model-call.js";
import type { AgentMemoryOptions } from "./memory.js";
import type { ContextBuilder } from "./context-builder.js";
import type { ModelRateLimiter } from "./rate-limit.js";

export type AgentOptions = {
  model: ModelProvider;
  systemPrompt?: string;
  tools?: Tool[];
  maxTurns?: number;
  hooks?: AgentHooks;
  modelCall?: ModelCallPolicy;
  memory?: AgentMemoryOptions;
  contextBuilder?: ContextBuilder;
  budget?: AgentBudget;
  rateLimiter?: ModelRateLimiter;
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
  private readonly memory: AgentMemoryOptions | undefined;
  private readonly contextBuilder: ContextBuilder | undefined;
  private readonly budget: AgentBudget | undefined;
  private readonly rateLimiter: ModelRateLimiter | undefined;
  private memoryLoaded = false;

  constructor(options: AgentOptions) {
    // `??` 是空值合并：左边为 undefined 时才使用右边的默认值。
    this.model = options.model;
    this.maxTurns = options.maxTurns ?? 8;
    this.hooks = options.hooks;
    this.modelCall = options.modelCall;
    this.memory = options.memory;
    this.contextBuilder = options.contextBuilder;
    this.budget = options.budget;
    this.rateLimiter = options.rateLimiter;
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
    // 首次运行时再异步加载 memory，constructor 因而仍保持同步、容易使用。
    await this.loadMemoryOnce();
    // 每次 run() 先把用户消息追加到同一份历史中，因此 Agent 记得之前的对话。
    this.context.messages.push({ role: "user", content: input });
    const hooks = options.hooks ?? this.hooks;
    const modelCall = options.modelCall ?? this.modelCall;
    const contextBuilder = options.contextBuilder ?? this.contextBuilder;
    const budget = options.budget ?? this.budget;
    const rateLimiter = options.rateLimiter ?? this.rateLimiter;
    // yield* 把内部生成器产生的事件原样转发给外部调用者。
    try {
      return yield* agentLoop(this.context, this.model, {
        maxTurns: options.maxTurns ?? this.maxTurns,
        ...(hooks ? { hooks } : {}),
        ...(modelCall ? { modelCall } : {}),
        ...(contextBuilder ? { contextBuilder } : {}),
        ...(budget ? { budget } : {}),
        ...(rateLimiter ? { rateLimiter } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } finally {
      // 成功、工具报错或用户取消后都保存当前一致的消息历史。
      await this.saveMemory();
    }
  }

  async reset(): Promise<void> {
    // 保留同一个数组对象，只把内容清空，已有引用不会失效。
    this.context.messages.length = 0;
    this.memoryLoaded = true;
    if (this.memory) {
      await this.memory.store.clear(this.memory.sessionId);
    }
  }

  private async loadMemoryOnce(): Promise<void> {
    if (!this.memory || this.memoryLoaded) return;
    const savedMessages = await this.memory.store.load(this.memory.sessionId);
    this.context.messages.push(...savedMessages);
    this.memoryLoaded = true;
  }

  private async saveMemory(): Promise<void> {
    if (!this.memory) return;
    await this.memory.store.save(
      this.memory.sessionId,
      this.context.messages,
    );
  }
}
