import { describe, expect, it } from "vitest";
import { Agent, type AssistantMessage, type ModelProvider } from "../src/core/index.js";
import { calculatorTool } from "../src/tools/index.js";

class ScriptedModel implements ModelProvider {
  readonly name = "scripted";
  calls = 0;

  constructor(private readonly replies: AssistantMessage[]) {}

  async generate(): Promise<AssistantMessage> {
    const reply = this.replies[this.calls++];
    if (!reply) throw new Error("No scripted reply.");
    return reply;
  }
}

describe("Agent", () => {
  it("returns a direct model answer", async () => {
    const model = new ScriptedModel([
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
        stopReason: "stop",
      },
    ]);
    const agent = new Agent({ model });
    const events = [];

    for await (const event of agent.run("Hi")) events.push(event);

    expect(events.some((event) => event.type === "agentEnd")).toBe(true);
    expect(agent.context.messages).toHaveLength(2);
  });

  it("streams deltas before committing the complete assistant message", async () => {
    const complete: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
      stopReason: "stop",
    };
    const model: ModelProvider = {
      name: "streamed",
      async generate() {
        return complete;
      },
      async *stream() {
        yield { type: "textDelta", delta: "Hel" };
        yield { type: "textDelta", delta: "lo!" };
        return complete;
      },
    };
    const agent = new Agent({ model });
    const events = [];

    for await (const event of agent.run("Hi")) {
      events.push(event);
      if (event.type === "textDelta") {
        // 此时历史里只有 user message，半条 assistant 尚未写入。
        expect(agent.context.messages).toHaveLength(1);
      }
    }

    expect(events.filter((event) => event.type === "textDelta")).toEqual([
      { type: "textDelta", delta: "Hel" },
      { type: "textDelta", delta: "lo!" },
    ]);
    expect(events.some((event) => event.type === "text")).toBe(false);
    expect(agent.context.messages[1]).toBe(complete);
  });

  it("executes a tool and gives its result back to the model", async () => {
    const model = new ScriptedModel([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "calculator",
            arguments: { operation: "multiply", left: 6, right: 7 },
          },
        ],
        stopReason: "toolUse",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The answer is 42." }],
        stopReason: "stop",
      },
    ]);
    const agent = new Agent({ model, tools: [calculatorTool] });
    const eventTypes = [];

    for await (const event of agent.run("6 * 7?")) {
      eventTypes.push(event.type);
    }

    expect(model.calls).toBe(2);
    expect(eventTypes).toContain("toolStart");
    expect(eventTypes).toContain("toolEnd");
    expect(agent.context.messages[2]).toMatchObject({
      role: "tool",
      content: "42",
      isError: false,
    });
  });

  it("turns an unknown tool call into an error result", async () => {
    const model = new ScriptedModel([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "bad-call",
            name: "missing",
            arguments: {},
          },
        ],
        stopReason: "toolUse",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I cannot do that." }],
        stopReason: "stop",
      },
    ]);
    const agent = new Agent({ model });

    for await (const _event of agent.run("Do it")) {
      // Consume the event stream.
    }

    expect(agent.context.messages[2]).toMatchObject({
      role: "tool",
      isError: true,
      content: "Unknown tool: missing",
    });
  });
});
