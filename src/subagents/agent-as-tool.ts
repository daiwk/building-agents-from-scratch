import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AssistantMessage,
  type Tool,
} from "../core/index.js";

export type HandoffResult = {
  status: "completed" | "failed" | "cancelled";
  task: string;
  output: string;
  agentId: string;
  parentAgentId?: string;
  depth: number;
  turns: number;
  totalTokens: number;
  durationMs: number;
  error?: string;
};

export type AgentEventEnvelope = {
  agentId: string;
  parentAgentId?: string;
  timestamp: number;
  event: AgentEvent;
};

/** 父子 Agent 共用事件总线，但不共享可变 messages。 */
export class AgentEventBus {
  private readonly listeners = new Set<(event: AgentEventEnvelope) => void>();

  constructor(
    private readonly onListenerError: (error: unknown) => void = () => undefined,
  ) {}

  subscribe(listener: (event: AgentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: AgentEventEnvelope): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}

export type SubagentPolicy = {
  maxDepth?: number;
  maxTurns?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

export type RunSubagentOptions = {
  task: string;
  createAgent: () => Agent | Promise<Agent>;
  agentId: string;
  parentAgentId?: string;
  depth?: number;
  policy?: SubagentPolicy;
  signal?: AbortSignal;
  eventBus?: AgentEventBus;
  /** 默认不传父历史；selector 返回的新数组才会成为 child 的只读上下文副本。 */
  selectContext?: (messages: readonly AgentMessage[]) => readonly AgentMessage[];
  parentMessages?: readonly AgentMessage[];
};

export async function runSubagent(
  options: RunSubagentOptions,
): Promise<HandoffResult> {
  const startedAt = Date.now();
  const depth = options.depth ?? 1;
  const maxDepth = options.policy?.maxDepth ?? 3;
  validatePolicy(options.policy);
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error("Sub-agent depth must be a non-negative integer.");
  }
  if (depth > maxDepth) {
    throw new Error(`Sub-agent depth ${depth} exceeds limit ${maxDepth}.`);
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();
  const timeout = options.policy?.timeoutMs === undefined
    ? undefined
    : setTimeout(
        () => controller.abort(new Error("Sub-agent time budget exceeded.")),
        options.policy.timeoutMs,
      );
  let turns = 0;
  let totalTokens = 0;
  try {
    const child = await options.createAgent();
    const selected = options.selectContext?.(options.parentMessages ?? []);
    if (selected) child.context.messages.push(...structuredClone([...selected]));
    let finalMessage: AssistantMessage | undefined;
    for await (const event of child.run(options.task, {
      signal: controller.signal,
      ...(options.policy?.maxTurns === undefined
        ? {}
        : { maxTurns: options.policy.maxTurns }),
      ...(options.policy?.maxTokens === undefined
        ? {}
        : { budget: { maxTotalTokens: options.policy.maxTokens } }),
    })) {
      if (event.type === "turnStart") turns = event.turn;
      if (event.type === "usage") totalTokens = event.totals.totalTokens;
      if (event.type === "agentEnd") finalMessage = event.message;
      options.eventBus?.publish({
        agentId: options.agentId,
        ...(options.parentAgentId ? { parentAgentId: options.parentAgentId } : {}),
        timestamp: Date.now(),
        event,
      });
    }
    if (!finalMessage) throw new Error("Sub-agent ended without a final message.");
    return result("completed", extractText(finalMessage), startedAt);
  } catch (error) {
    const cancelled = controller.signal.aborted;
    return result(cancelled ? "cancelled" : "failed", "", startedAt, error);
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }

  function result(
    status: HandoffResult["status"],
    output: string,
    start: number,
    error?: unknown,
  ): HandoffResult {
    return {
      status,
      task: options.task,
      output,
      agentId: options.agentId,
      ...(options.parentAgentId ? { parentAgentId: options.parentAgentId } : {}),
      depth,
      turns,
      totalTokens,
      durationMs: Date.now() - start,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    };
  }
}

export type AgentAsToolOptions = Omit<
  RunSubagentOptions,
  "task" | "signal" | "parentMessages" | "agentId"
> & {
  name: string;
  description: string;
  agentId?: string;
  structuredResult?: boolean;
};

export function agentAsTool(options: AgentAsToolOptions): Tool {
  return {
    name: options.name,
    description: options.description,
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "交给子 Agent 的具体任务" } },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (typeof input.task !== "string") {
        throw new Error("Sub-agent task must be a string.");
      }
      const handoff = await runSubagent({
        ...options,
        agentId: options.agentId ?? options.name,
        task: input.task,
        ...(context.signal ? { signal: context.signal } : {}),
        parentMessages: context.messages,
      });
      if (handoff.status !== "completed") {
        throw new Error(handoff.error ?? `Sub-agent ${handoff.status}.`);
      }
      return options.structuredResult
        ? JSON.stringify(handoff)
        : handoff.output || "Sub-agent completed without text output.";
    },
  };
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function validatePolicy(policy: SubagentPolicy | undefined): void {
  const integers = [
    ["maxDepth", policy?.maxDepth],
    ["maxTurns", policy?.maxTurns],
    ["maxTokens", policy?.maxTokens],
  ] as const;
  for (const [name, value] of integers) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
  if (
    policy?.timeoutMs !== undefined &&
    (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs < 0)
  ) {
    throw new Error("timeoutMs must be a non-negative number.");
  }
}
