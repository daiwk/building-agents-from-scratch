import type {
  AgentContext,
  AgentEvent,
  AssistantMessage,
  ModelProvider,
  ToolCallBlock,
  ToolResultMessage,
} from "./types.js";
import {
  callModelWithPolicy,
  type ModelCallPolicy,
} from "./model-call.js";
import type { ContextBuilder } from "./context-builder.js";
import { validateToolInput } from "./tool-validation.js";

export type AgentLoopOptions = {
  // 最多允许调用模型多少次，防止模型和工具无限互相调用。
  maxTurns?: number;
  // AbortSignal 是浏览器和 Node 通用的取消信号。
  signal?: AbortSignal;
  // hooks 允许 memory、权限检查和日志插入循环，但不修改循环本身。
  hooks?: AgentHooks;
  // modelCall 把 timeout/retry 与 Agent 控制循环分离。
  modelCall?: ModelCallPolicy;
  // contextBuilder 只裁剪本轮模型输入，不删除 Agent 保存的完整消息历史。
  contextBuilder?: ContextBuilder;
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
 * 这就是完整的 Agent 算法：没有继承、没有隐藏状态。
 *
 * 1. 把 Context 交给模型。
 * 2. 模型直接回答：结束。
 * 3. 模型请求工具：执行工具，把结果写回 Context，再回到第 1 步。
 *
 * `async function*` 是“异步生成器”。普通函数只能 return 一次；生成器可以在运行
 * 过程中多次 yield 事件，因此 Web UI 能实时看到 Agent 走到了哪一步。
 */
export async function* agentLoop(
  context: AgentContext,
  model: ModelProvider,
  options: AgentLoopOptions = {},
): AsyncGenerator<AgentEvent, AssistantMessage> {
  const maxTurns = options.maxTurns ?? 8;
  let lastMessage: AssistantMessage | undefined;

  // yield 只是在广播事件，不会结束函数。
  yield { type: "agentStart" };

  // 一轮（turn）= 调用一次模型 + 执行这次模型要求的全部工具。
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    throwIfAborted(options.signal);
    yield { type: "turnStart", turn };
    // `?.` 称为可选链：hook 存在才调用，不存在就跳过。
    await options.hooks?.beforeModel?.(context);

    // Agent 本身不关心 MiniMax 的 HTTP 细节，只调用统一的 model.generate()。
    const builtContext = options.contextBuilder
      ? await options.contextBuilder.build(context)
      : context;
    const assistant = await callModelWithPolicy(
      model,
      {
        systemPrompt: builtContext.systemPrompt,
        messages: builtContext.messages,
        tools: builtContext.tools,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.modelCall,
    );
    // 模型消息必须先进入历史，下一轮模型才知道自己刚才请求了什么工具。
    lastMessage = assistant;
    context.messages.push(assistant);
    yield { type: "message", message: assistant };

    // 将完整消息拆成更适合 UI 消费的细粒度事件。
    for (const block of assistant.content) {
      if (block.type === "text") yield { type: "text", text: block.text };
      if (block.type === "thinking") {
        yield { type: "thinking", thinking: block.thinking };
      }
    }

    // `filter` 找出这一轮的全部工具调用；类型谓词告诉 TS 过滤后的具体类型。
    const calls = assistant.content.filter(
      (block): block is ToolCallBlock => block.type === "toolCall",
    );

    // 没有工具调用，说明模型已经给出最终答案，Agent 正常结束。
    if (calls.length === 0) {
      yield { type: "turnEnd", turn };
      yield { type: "agentEnd", message: assistant };
      return assistant;
    }

    // 教学版按顺序执行工具，执行顺序和日志顺序完全一致，最容易调试。
    for (const call of calls) {
      throwIfAborted(options.signal);
      await options.hooks?.beforeTool?.(call, context);
      yield { type: "toolStart", call };
      const result = await executeTool(call, context, options.signal);
      // 工具结果也是一条消息。关键反馈环在这一行闭合。
      context.messages.push(result);
      await options.hooks?.afterTool?.(call, result, context);
      yield { type: "toolEnd", call, result };
    }

    yield { type: "turnEnd", turn };
  }

  // 模型连续调用工具太多次时主动停止，避免死循环和额度失控。
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
  // 工具名来自模型输出，所以必须先确认宿主真的注册了这个工具。
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
    // Schema 是给模型的说明，也是宿主执行工具前的运行时安全检查。
    const validationErrors = validateToolInput(
      tool.inputSchema,
      call.arguments,
    );
    if (validationErrors.length > 0) {
      return {
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: `Invalid tool arguments: ${validationErrors.join("; ")}`,
        isError: true,
      };
    }

    // await 同时兼容同步工具（直接返回 string）和异步工具（返回 Promise）。
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
    // 工具失败不是整个 Agent 崩溃：把错误作为结果交回模型，让模型自行修正。
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
