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

export type AgentOptions = {
  model: ModelProvider;
  systemPrompt?: string;
  tools?: Tool[];
  maxTurns?: number;
  hooks?: AgentHooks;
};

/**
 * A convenient stateful shell around the pure agentLoop().
 */
export class Agent {
  readonly context: AgentContext;
  private readonly model: ModelProvider;
  private readonly maxTurns: number;
  private readonly hooks: AgentHooks | undefined;

  constructor(options: AgentOptions) {
    this.model = options.model;
    this.maxTurns = options.maxTurns ?? 8;
    this.hooks = options.hooks;
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
    this.context.messages.push({ role: "user", content: input });
    const hooks = options.hooks ?? this.hooks;
    return yield* agentLoop(this.context, this.model, {
      maxTurns: options.maxTurns ?? this.maxTurns,
      ...(hooks ? { hooks } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  reset(): void {
    this.context.messages.length = 0;
  }
}
