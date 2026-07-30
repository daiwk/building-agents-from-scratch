import type {
  AssistantBlock,
  AssistantMessage,
  JsonValue,
  ModelStreamEvent,
  TokenUsage,
} from "../core/index.js";
import { RetryableModelError } from "../core/index.js";

type ApiStreamEvent = {
  type?: string;
  index?: number;
  message?: { usage?: ApiUsage };
  content_block?: ApiContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: ApiUsage;
  error?: { type?: string; message?: string };
};

type ApiUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
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

type PendingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      initialInput: Record<string, unknown>;
      partialJson: string;
    };

/**
 * 把 Anthropic-compatible SSE 转成临时 delta，并最终组装出完整消息。
 *
 * 网络分帧、SSE 事件和 content block 聚合都留在这里，MiniMaxProvider 因而只需要负责
 * HTTP 请求。以后增加另一个 Anthropic-compatible provider 时也可以复用这个解析器。
 */
export async function* parseAnthropicMessageStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ModelStreamEvent, AssistantMessage> {
  const blocks = new Map<number, PendingBlock>();
  let stopReason: string | undefined;
  let usage: TokenUsage | undefined;
  let completed = false;

  for await (const rawEvent of readSseData(body)) {
    if (rawEvent === "[DONE]") continue;
    const event = JSON.parse(rawEvent) as ApiStreamEvent;
    if (event.type === "error") throwStreamError(event);
    if (event.type === "message_start") {
      usage = mergeUsage(usage, event.message?.usage);
    }
    if (
      event.type === "content_block_start" &&
      event.index !== undefined &&
      event.content_block
    ) {
      const block = toPendingBlock(event.content_block);
      blocks.set(event.index, block);
      const initialDelta = initialBlockDelta(block);
      if (initialDelta) yield initialDelta;
    }
    if (
      event.type === "content_block_delta" &&
      event.index !== undefined &&
      event.delta
    ) {
      const delta = applyBlockDelta(blocks, event.index, event.delta);
      if (delta) yield delta;
    }
    if (event.type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? stopReason;
      usage = mergeUsage(usage, event.usage);
    }
    if (event.type === "message_stop") completed = true;
  }

  if (!completed) {
    throw new RetryableModelError(
      "Anthropic-compatible stream ended before message_stop.",
    );
  }
  const content = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, block]) => finishBlock(block));
  if (content.length === 0) {
    throw new Error("Model returned an empty assistant message.");
  }
  return {
    role: "assistant",
    content,
    stopReason: mapStopReason(stopReason),
    ...(usage ? { usage } : {}),
  };
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), {
        stream: !done,
      });
      // 一个 SSE event 以空行结束；data 甚至可能跨多个网络 chunk。
      const frames = buffer.replaceAll("\r\n", "\n").split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = extractData(frame);
        if (data) yield data;
      }
      if (done) break;
    }
    const finalData = extractData(buffer);
    if (finalData) yield finalData;
  } finally {
    reader.releaseLock();
  }
}

function extractData(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function toPendingBlock(block: ApiContentBlock): PendingBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thinking") {
    return { type: "thinking", thinking: block.thinking };
  }
  return {
    type: "toolCall",
    id: block.id,
    name: block.name,
    initialInput: block.input,
    partialJson: "",
  };
}

function initialBlockDelta(
  block: PendingBlock,
): ModelStreamEvent | undefined {
  if (block.type === "text" && block.text) {
    return { type: "textDelta", delta: block.text };
  }
  if (block.type === "thinking" && block.thinking) {
    return { type: "thinkingDelta", delta: block.thinking };
  }
  return undefined;
}

function applyBlockDelta(
  blocks: Map<number, PendingBlock>,
  index: number,
  delta: NonNullable<ApiStreamEvent["delta"]>,
): ModelStreamEvent | undefined {
  const block = blocks.get(index);
  if (!block) throw new Error(`Stream delta references unknown block ${index}.`);
  if (delta.type === "text_delta" && block.type === "text") {
    const text = delta.text ?? "";
    block.text += text;
    return text ? { type: "textDelta", delta: text } : undefined;
  }
  if (delta.type === "thinking_delta" && block.type === "thinking") {
    const thinking = delta.thinking ?? "";
    block.thinking += thinking;
    return thinking
      ? { type: "thinkingDelta", delta: thinking }
      : undefined;
  }
  if (delta.type === "input_json_delta" && block.type === "toolCall") {
    const partialJson = delta.partial_json ?? "";
    block.partialJson += partialJson;
    return partialJson
      ? {
          type: "toolArgumentsDelta",
          toolCallId: block.id,
          toolName: block.name,
          delta: partialJson,
        }
      : undefined;
  }
  return undefined;
}

function finishBlock(block: PendingBlock): AssistantBlock[] {
  if (block.type === "text") {
    return block.text ? [{ type: "text", text: block.text }] : [];
  }
  if (block.type === "thinking") {
    return block.thinking
      ? [{ type: "thinking", thinking: block.thinking }]
      : [];
  }
  let input = block.initialInput;
  if (block.partialJson.trim()) {
    try {
      input = JSON.parse(block.partialJson) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Model returned invalid tool arguments for ${block.name}.`,
        { cause: error },
      );
    }
  }
  return [
    {
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: sanitizeObject(input),
    },
  ];
}

function mergeUsage(
  current: TokenUsage | undefined,
  incoming: ApiUsage | undefined,
): TokenUsage | undefined {
  if (!incoming) return current;
  return {
    input: incoming.input_tokens ?? current?.input ?? 0,
    output: incoming.output_tokens ?? current?.output ?? 0,
    ...(incoming.cache_read_input_tokens !== undefined
      ? { cacheRead: incoming.cache_read_input_tokens }
      : current?.cacheRead !== undefined
        ? { cacheRead: current.cacheRead }
        : {}),
    ...(incoming.cache_creation_input_tokens !== undefined
      ? { cacheWrite: incoming.cache_creation_input_tokens }
      : current?.cacheWrite !== undefined
        ? { cacheWrite: current.cacheWrite }
        : {}),
  };
}

function throwStreamError(event: ApiStreamEvent): never {
  const message =
    `Model stream failed: ${event.error?.message ?? "unknown error"}`;
  if (
    event.error?.type === "overloaded_error" ||
    event.error?.type === "api_error"
  ) {
    throw new RetryableModelError(message);
  }
  throw new Error(message);
}

function sanitizeObject(
  input: Record<string, unknown>,
): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(input)) as Record<string, JsonValue>;
}

function mapStopReason(
  reason: string | undefined,
): AssistantMessage["stopReason"] {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "tool_use") return "toolUse";
  if (reason === "max_tokens") return "length";
  return "unknown";
}
