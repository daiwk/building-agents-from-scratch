import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  ModelTimeoutError,
  RetryableModelError,
  callModelWithPolicy,
  type AssistantMessage,
  type ModelProvider,
  type ModelRequest,
  type Tool,
  validateToolInput,
} from "../src/core/index.js";

const finalMessage: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  stopReason: "stop",
};

const emptyRequest: ModelRequest = {
  systemPrompt: "",
  messages: [],
  tools: [],
};

describe("tool argument validation", () => {
  it("reports required, type, enum, and additional-property errors", () => {
    const errors = validateToolInput(
      {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["add", "multiply"] },
          left: { type: "number" },
        },
        required: ["operation", "left"],
        additionalProperties: false,
      },
      { operation: "delete", extra: true },
    );

    expect(errors).toEqual([
      "$.left is required",
      "$.extra is not allowed",
      '$.operation must be one of: "add", "multiply"',
    ]);
  });

  it("returns validation errors to the model without executing the tool", async () => {
    const execute = vi.fn(() => "should not run");
    const tool: Tool = {
      name: "weather",
      description: "Look up weather.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      execute,
    };
    let calls = 0;
    const model: ModelProvider = {
      name: "scripted",
      async generate() {
        calls += 1;
        if (calls === 1) {
          return {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "bad-input",
                name: "weather",
                arguments: { city: 123 },
              },
            ],
            stopReason: "toolUse",
          };
        }
        return finalMessage;
      },
    };
    const agent = new Agent({ model, tools: [tool] });

    for await (const _event of agent.run("weather")) {
      // Consume all events.
    }

    expect(execute).not.toHaveBeenCalled();
    expect(agent.context.messages[2]).toMatchObject({
      role: "tool",
      isError: true,
      content: "Invalid tool arguments: $.city must be string",
    });
  });
});

describe("model call policy", () => {
  it("retries transient errors with exponential backoff metadata", async () => {
    let calls = 0;
    const retries: number[] = [];
    const model: ModelProvider = {
      name: "flaky",
      async generate() {
        calls += 1;
        if (calls < 3) throw new RetryableModelError("temporary");
        return finalMessage;
      },
    };

    const result = await callModelWithPolicy(model, emptyRequest, {
      maxRetries: 2,
      retryDelayMs: 0,
      onRetry: ({ attempt }) => {
        retries.push(attempt);
      },
    });

    expect(result).toBe(finalMessage);
    expect(calls).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it("does not retry permanent errors", async () => {
    const generate = vi.fn(async () => {
      throw new Error("invalid API key");
    });
    const model: ModelProvider = { name: "broken", generate };

    await expect(
      callModelWithPolicy(model, emptyRequest, {
        maxRetries: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow("invalid API key");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("stops a model call after the configured timeout", async () => {
    const model: ModelProvider = {
      name: "stuck",
      generate: () => new Promise(() => undefined),
    };

    await expect(
      callModelWithPolicy(model, emptyRequest, {
        timeoutMs: 5,
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(ModelTimeoutError);
  });

  it("honors cancellation even when a provider ignores AbortSignal", async () => {
    const controller = new AbortController();
    const model: ModelProvider = {
      name: "stuck",
      generate: () => new Promise(() => undefined),
    };
    const pending = callModelWithPolicy(
      model,
      { ...emptyRequest, signal: controller.signal },
      { timeoutMs: 0 },
    );

    controller.abort(new Error("user stopped"));

    await expect(pending).rejects.toThrow("user stopped");
  });
});
