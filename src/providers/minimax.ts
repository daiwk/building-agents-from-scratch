import type {
  AgentMessage,
  AssistantBlock,
  AssistantMessage,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  Tool,
} from "../core/index.js";
import { RetryableModelError } from "../core/index.js";
import { parseAnthropicMessageStream } from "./anthropic-stream.js";

type MiniMaxProviderOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof globalThis.fetch;
};

type ApiContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

type ApiResponse = {
  content?: ApiContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { type?: string; message?: string };
  base_resp?: { status_code?: number; status_msg?: string };
};

/**
 * 把我们自己的 ModelRequest 翻译成 MiniMax Anthropic-compatible HTTP 请求。
 *
 * Provider 是“协议适配器”，不应该包含 Agent loop。换模型服务只需要换这个类，
 * core/agent-loop.ts 完全不用改。
 */
export class MiniMaxProvider implements ModelProvider {
  readonly name = "minimax";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly request: typeof globalThis.fetch;

  constructor(options: MiniMaxProviderOptions) {
    if (!options.apiKey) throw new Error("MiniMax API key is required.");
    this.apiKey = options.apiKey;
    this.model = options.model ?? "MiniMax-M2.7";
    this.baseUrl = (options.baseUrl ?? "https://api.minimaxi.com/anthropic/v1")
      .replace(/\/$/, "");
    this.maxTokens = options.maxTokens ?? 8192;
    this.temperature = options.temperature ?? 1;
    this.request = options.fetch ?? globalThis.fetch;
  }

  async generate(request: ModelRequest): Promise<AssistantMessage> {
    // Node 20+ 自带 fetch；测试会注入 fake fetch，因此不会访问真实 API。
    const response = await this.request(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(this.createRequestBody(request, false)),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    // `as ApiResponse` 只帮助 TypeScript 检查代码，不会修改服务器返回的数据。
    const body = (await response.json()) as ApiResponse;
    if (!response.ok || body.error || body.base_resp?.status_code) {
      const message =
        body.error?.message ??
        body.base_resp?.status_msg ??
        `${response.status} ${response.statusText}`;
      const errorMessage = `MiniMax request failed: ${message}`;
      // 429/5xx 通常是临时限流或服务故障；401/400 重试不会解决问题。
      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        throw new RetryableModelError(errorMessage);
      }
      throw new Error(errorMessage);
    }

    const content = (body.content ?? []).flatMap(toCoreBlock);
    if (content.length === 0) {
      throw new Error("MiniMax returned an empty assistant message.");
    }

    const usage = body.usage
      ? {
          input: body.usage.input_tokens ?? 0,
          output: body.usage.output_tokens ?? 0,
          ...(body.usage.cache_read_input_tokens !== undefined
            ? { cacheRead: body.usage.cache_read_input_tokens }
            : {}),
          ...(body.usage.cache_creation_input_tokens !== undefined
            ? { cacheWrite: body.usage.cache_creation_input_tokens }
            : {}),
        }
      : undefined;

    return {
      role: "assistant",
      content,
      stopReason: mapStopReason(body.stop_reason),
      ...(usage ? { usage } : {}),
    };
  }

  /**
   * MiniMax 国内 Anthropic-compatible 接口使用标准 SSE。
   *
   * delta 会立即 yield 给 UI；blocks 在 provider 内同步累积，只有 message_stop 后才
   * return 完整 AssistantMessage。
   */
  async *stream(
    request: ModelRequest,
  ): AsyncGenerator<ModelStreamEvent, AssistantMessage> {
    const response = await this.request(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(this.createRequestBody(request, true)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!response.ok) {
      throw await toHttpError(response);
    }
    if (!response.body) {
      throw new RetryableModelError("MiniMax stream has no response body.");
    }

    return yield* parseAnthropicMessageStream(response.body);
  }

  private createRequestBody(
    request: ModelRequest,
    stream: boolean,
  ): object {
    return {
      model: this.model,
      system: request.systemPrompt,
      messages: toApiMessages(request.messages),
      tools: request.tools.map(toApiTool),
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream,
    };
  }
}

async function toHttpError(response: Response): Promise<Error> {
  const text = await response.text();
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = JSON.parse(text) as ApiResponse;
    message =
      body.error?.message ??
      body.base_resp?.status_msg ??
      message;
  } catch {
    if (text.trim()) message = text.trim();
  }
  const error = new Error(`MiniMax request failed: ${message}`);
  if (
    response.status === 408 ||
    response.status === 409 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    return new RetryableModelError(error.message);
  }
  return error;
}

function toApiTool(tool: Tool): object {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function toApiMessages(messages: readonly AgentMessage[]): object[] {
  // 我们内部使用 role="tool"，Anthropic 协议将 tool_result 放在 user 消息中。
  return messages.map((message) => {
    if (message.role === "user") {
      return { role: "user", content: message.content };
    }
    if (message.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
            is_error: message.isError,
          },
        ],
      };
    }
    return {
      role: "assistant",
      // thinking signature 与 provider 绑定；历史中只发送可移植的文本和工具调用。
      content: toApiAssistantBlocks(message.content),
    };
  });
}

function toApiAssistantBlocks(blocks: AssistantBlock[]): object[] {
  const result: object[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      result.push({ type: "text", text: block.text });
    }
    if (block.type === "toolCall") {
      result.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.arguments,
      });
    }
  }
  return result;
}

function toCoreBlock(block: ApiContentBlock): AssistantBlock[] {
  if (block.type === "text") return [{ type: "text", text: block.text }];
  if (block.type === "thinking") {
    return [{ type: "thinking", thinking: block.thinking }];
  }
  return [
    {
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: sanitizeObject(block.input),
    },
  ];
}

function sanitizeObject(input: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(input)) as Record<
    string,
    import("../core/index.js").JsonValue
  >;
}

function mapStopReason(
  reason: string | undefined,
): AssistantMessage["stopReason"] {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "tool_use") return "toolUse";
  if (reason === "max_tokens") return "length";
  return "unknown";
}
