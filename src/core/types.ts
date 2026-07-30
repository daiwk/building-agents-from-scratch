/**
 * 这个文件定义了 Agent 世界里的全部“名词”。
 *
 * TypeScript 入门提示：
 * - `type X = ...` 是在给一种数据形状起名字，不会在运行时产生新对象。
 * - `?` 表示字段可以没有，例如 `usage?: TokenUsage`。
 * - `A | B` 表示一个值可以是 A，也可以是 B，称为联合类型。
 *
 * 阅读 agent-loop.ts 时把这个文件放在旁边：整个 Agent 架构，本质上只是
 * 下面这些数据在一个循环中不断流动。
 */

// JSON 最基础的四种值。
export type JsonPrimitive = string | number | boolean | null;

// JSON 还可以递归地包含数组和对象。
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

// 工具参数使用 JSON Schema 描述，让模型知道该传哪些字段。
export type JsonSchema = {
  type: "object";
  properties?: Record<string, JsonValue>;
  required?: string[];
  additionalProperties?: boolean;
};

// 用户发给模型的一条消息。
export type UserMessage = {
  role: "user";
  content: string;
};

// 模型回答中的普通文本块。
export type TextBlock = {
  type: "text";
  text: string;
};

// 模型的思考块。UI 默认不展示它，但保留类型方便理解模型响应。
export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
};

// 模型不会直接执行函数，它只生成一个“希望宿主调用工具”的请求。
export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, JsonValue>;
};

// AssistantBlock 可以是三种形状。读取 `type` 字段就能区分它们。
export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock;

// 模型一次完整返回的消息。
export type AssistantMessage = {
  role: "assistant";
  content: AssistantBlock[];
  stopReason: "stop" | "toolUse" | "length" | "unknown";
  usage?: TokenUsage;
};

// 宿主执行工具后，把结果包装成这条消息再交回模型。
export type ToolResultMessage = {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
};

// 整段对话中允许出现的三类消息。
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type ToolExecutionContext = {
  messages: readonly AgentMessage[];
  signal?: AbortSignal;
};

// execute 就是一个普通函数：接收模型生成的参数，返回字符串结果。
export type Tool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(
    input: Record<string, JsonValue>,
    context: ToolExecutionContext,
  ): Promise<string> | string;
};

/**
 * AgentContext 是 Agent 的“短期记忆”。
 *
 * 它没有数据库，也没有魔法：system prompt、历史消息和可用工具都在这里。
 * 后续实现长期 memory 时，可以在调用模型前从数据库读取内容并加入 messages。
 */
export type AgentContext = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: Tool[];
};

// 每次调用模型时，Agent 会把 Context 转换成 ModelRequest。
export type ModelRequest = {
  systemPrompt: string;
  messages: readonly AgentMessage[];
  tools: readonly Tool[];
  signal?: AbortSignal;
};

/**
 * 所有模型后端都只需要实现 generate()。
 *
 * `Promise<AssistantMessage>` 可以理解为“现在还没有结果，未来会得到一条
 * AssistantMessage”。MiniMax、测试假模型或其他服务都能藏在这个统一接口后面。
 */
export type ModelProvider = {
  readonly name: string;
  generate(request: ModelRequest): Promise<AssistantMessage>;
  /**
   * 可选 streaming 接口。yield 只产生临时 delta，return 才交付完整消息。
   *
   * Agent loop 会等 return 后再把 AssistantMessage 写入历史，避免取消或网络失败留下
   * 半条消息。不支持 stream() 的 provider 会自动退回 generate()。
   */
  stream?(
    request: ModelRequest,
  ): AsyncGenerator<ModelStreamEvent, AssistantMessage>;
};

export type ModelStreamEvent =
  | { type: "textDelta"; delta: string }
  | { type: "thinkingDelta"; delta: string }
  | {
      type: "toolArgumentsDelta";
      toolCallId: string;
      toolName: string;
      delta: string;
    };

/**
 * AgentEvent 是给 CLI、Web UI 和日志系统看的运行轨迹。
 *
 * AsyncGenerator 会按顺序 yield 这些事件，所以界面可以边运行边更新，而不用等
 * 整个任务结束。
 */
export type AgentEvent =
  | { type: "agentStart" }
  | { type: "turnStart"; turn: number }
  | ModelStreamEvent
  | { type: "message"; message: AssistantMessage }
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolStart"; call: ToolCallBlock }
  | {
      type: "toolEnd";
      call: ToolCallBlock;
      result: ToolResultMessage;
    }
  | { type: "turnEnd"; turn: number }
  | { type: "agentEnd"; message: AssistantMessage };
