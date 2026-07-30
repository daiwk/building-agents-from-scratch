import { describe, expect, it, vi } from "vitest";
import { RetryableModelError } from "../src/core/index.js";
import { MiniMaxProvider } from "../src/providers/index.js";

describe("MiniMaxProvider", () => {
  it("maps Anthropic-compatible tool calls to core messages", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "calculator",
              input: { left: 1, right: 2, operation: "add" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
          base_resp: { status_code: 0, status_msg: "success" },
        }),
        { status: 200 },
      ),
    );
    const provider = new MiniMaxProvider({
      apiKey: "test-key",
      fetch: fakeFetch,
    });

    const message = await provider.generate({
      systemPrompt: "test",
      messages: [{ role: "user", content: "1+2" }],
      tools: [],
    });

    expect(message.stopReason).toBe("toolUse");
    expect(message.content[0]).toMatchObject({
      type: "toolCall",
      name: "calculator",
    });
    expect(message.usage).toEqual({ input: 10, output: 5 });
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://api.minimaxi.com/anthropic/v1/messages",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "test-key" }),
      }),
    );
  });

  it("marks rate limits as retryable", async () => {
    const provider = new MiniMaxProvider({
      apiKey: "test-key",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
        }),
    });

    await expect(
      provider.generate({
        systemPrompt: "test",
        messages: [],
        tools: [],
      }),
    ).rejects.toBeInstanceOf(RetryableModelError);
  });

  it("does not mark authentication failures as retryable", async () => {
    const provider = new MiniMaxProvider({
      apiKey: "bad-key",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
          status: 401,
        }),
    });

    await expect(
      provider.generate({
        systemPrompt: "test",
        messages: [],
        tools: [],
      }),
    ).rejects.not.toBeInstanceOf(RetryableModelError);
  });

  it("parses text, thinking, and tool argument SSE deltas", async () => {
    const sse = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 12 } },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "先计算" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "我来计算。" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "calculator",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: {
          type: "input_json_delta",
          partial_json: '{"left":6,',
        },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: {
          type: "input_json_delta",
          partial_json: '"right":7,"operation":"multiply"}',
        },
      },
      { type: "content_block_stop", index: 2 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 9 },
      },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const encoded = new TextEncoder().encode(sse);
    const fakeFetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      new Response(new ReadableStream({
        start(controller) {
          // 故意切在任意字节位置，验证 SSE parser 能跨网络 chunk 拼接。
          controller.enqueue(encoded.slice(0, 37));
          controller.enqueue(encoded.slice(37, 211));
          controller.enqueue(encoded.slice(211));
          controller.close();
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const provider = new MiniMaxProvider({
      apiKey: "test-key",
      fetch: fakeFetch,
    });
    const stream = provider.stream({
      systemPrompt: "test",
      messages: [{ role: "user", content: "6*7" }],
      tools: [],
    });
    const events = [];
    let message;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        message = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(events).toEqual([
      { type: "thinkingDelta", delta: "先计算" },
      { type: "textDelta", delta: "我来计算。" },
      {
        type: "toolArgumentsDelta",
        toolCallId: "tool-1",
        toolName: "calculator",
        delta: '{"left":6,',
      },
      {
        type: "toolArgumentsDelta",
        toolCallId: "tool-1",
        toolName: "calculator",
        delta: '"right":7,"operation":"multiply"}',
      },
    ]);
    expect(message).toMatchObject({
      stopReason: "toolUse",
      usage: { input: 12, output: 9 },
      content: [
        { type: "thinking", thinking: "先计算" },
        { type: "text", text: "我来计算。" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "calculator",
          arguments: { left: 6, right: 7, operation: "multiply" },
        },
      ],
    });
    const init = fakeFetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true });
  });
});
