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
});
