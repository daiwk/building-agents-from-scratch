import type {
  AgentMessage,
  AssistantBlock,
  AssistantMessage,
  ModelProvider,
  ModelRequest,
  Tool,
} from "../core/index.js";

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
  error?: { message?: string };
  base_resp?: { status_code?: number; status_msg?: string };
};

/**
 * MiniMax Token Plan adapter using the official Anthropic-compatible endpoint.
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
    const response = await this.request(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        system: request.systemPrompt,
        messages: toApiMessages(request.messages),
        tools: request.tools.map(toApiTool),
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        stream: false,
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const body = (await response.json()) as ApiResponse;
    if (!response.ok || body.error || body.base_resp?.status_code) {
      const message =
        body.error?.message ??
        body.base_resp?.status_msg ??
        `${response.status} ${response.statusText}`;
      throw new Error(`MiniMax request failed: ${message}`);
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
}

function toApiTool(tool: Tool): object {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function toApiMessages(messages: readonly AgentMessage[]): object[] {
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
      // Thinking signatures are provider-specific, so history keeps only the
      // portable text and tool-call blocks.
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
