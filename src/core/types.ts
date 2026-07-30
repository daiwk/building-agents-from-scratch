/**
 * The complete vocabulary of our tiny agent.
 *
 * Keep this file open while reading agent-loop.ts: the whole architecture is
 * just these values moving through one loop.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonSchema = {
  type: "object";
  properties?: Record<string, JsonValue>;
  required?: string[];
  additionalProperties?: boolean;
};

export type UserMessage = {
  role: "user";
  content: string;
};

export type TextBlock = {
  type: "text";
  text: string;
};

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
};

export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, JsonValue>;
};

export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export type AssistantMessage = {
  role: "assistant";
  content: AssistantBlock[];
  stopReason: "stop" | "toolUse" | "length" | "unknown";
  usage?: TokenUsage;
};

export type ToolResultMessage = {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
};

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

export type Tool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(
    input: Record<string, JsonValue>,
    context: ToolExecutionContext,
  ): Promise<string> | string;
};

export type AgentContext = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: Tool[];
};

export type ModelRequest = {
  systemPrompt: string;
  messages: readonly AgentMessage[];
  tools: readonly Tool[];
  signal?: AbortSignal;
};

/**
 * A model backend returns a complete assistant message. Streaming is exposed by
 * AgentEvent, so the core can later adopt token streaming without changing its
 * public control-flow API.
 */
export type ModelProvider = {
  readonly name: string;
  generate(request: ModelRequest): Promise<AssistantMessage>;
};

export type AgentEvent =
  | { type: "agentStart" }
  | { type: "turnStart"; turn: number }
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
