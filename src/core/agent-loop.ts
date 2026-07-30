import type {
  AgentContext,
  AgentEvent,
  AssistantMessage,
  ModelProvider,
  ToolCallBlock,
  ToolResultMessage,
} from "./types.js";

export type AgentLoopOptions = {
  maxTurns?: number;
  signal?: AbortSignal;
  hooks?: AgentHooks;
};

export type AgentHooks = {
  beforeModel?: (context: AgentContext) => Promise<void> | void;
  beforeTool?: (
    call: ToolCallBlock,
    context: AgentContext,
  ) => Promise<void> | void;
  afterTool?: (
    call: ToolCallBlock,
    result: ToolResultMessage,
    context: AgentContext,
  ) => Promise<void> | void;
};

/**
 * The agent algorithm, without a class and without hidden state.
 *
 * 1. Ask the model what to do.
 * 2. If it answers, stop.
 * 3. If it calls tools, execute them, append results, and go to step 1.
 */
export async function* agentLoop(
  context: AgentContext,
  model: ModelProvider,
  options: AgentLoopOptions = {},
): AsyncGenerator<AgentEvent, AssistantMessage> {
  const maxTurns = options.maxTurns ?? 8;
  let lastMessage: AssistantMessage | undefined;

  yield { type: "agentStart" };

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    throwIfAborted(options.signal);
    yield { type: "turnStart", turn };
    await options.hooks?.beforeModel?.(context);

    const assistant = await model.generate({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      tools: context.tools,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    lastMessage = assistant;
    context.messages.push(assistant);
    yield { type: "message", message: assistant };

    for (const block of assistant.content) {
      if (block.type === "text") yield { type: "text", text: block.text };
      if (block.type === "thinking") {
        yield { type: "thinking", thinking: block.thinking };
      }
    }

    const calls = assistant.content.filter(
      (block): block is ToolCallBlock => block.type === "toolCall",
    );

    if (calls.length === 0) {
      yield { type: "turnEnd", turn };
      yield { type: "agentEnd", message: assistant };
      return assistant;
    }

    for (const call of calls) {
      throwIfAborted(options.signal);
      await options.hooks?.beforeTool?.(call, context);
      yield { type: "toolStart", call };
      const result = await executeTool(call, context, options.signal);
      context.messages.push(result);
      await options.hooks?.afterTool?.(call, result, context);
      yield { type: "toolEnd", call, result };
    }

    yield { type: "turnEnd", turn };
  }

  throw new Error(
    `Agent stopped after ${maxTurns} turns to prevent an infinite loop.` +
      (lastMessage ? ` Last stop reason: ${lastMessage.stopReason}.` : ""),
  );
}

async function executeTool(
  call: ToolCallBlock,
  context: AgentContext,
  signal?: AbortSignal,
): Promise<ToolResultMessage> {
  const tool = context.tools.find((candidate) => candidate.name === call.name);

  if (!tool) {
    return {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: `Unknown tool: ${call.name}`,
      isError: true,
    };
  }

  try {
    const content = await tool.execute(call.arguments, {
      messages: context.messages,
      ...(signal ? { signal } : {}),
    });
    return {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content,
      isError: false,
    };
  } catch (error) {
    return {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Agent run aborted.");
  }
}
