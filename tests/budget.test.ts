import { describe, expect, it } from "vitest";
import {
  Agent,
  BudgetExceededError,
  BudgetTracker,
  BudgetUsageUnavailableError,
  createBudgetFromEnvironment,
  type AgentEvent,
  type AssistantMessage,
  type ModelProvider,
} from "../src/core/index.js";
import { calculatorTool } from "../src/tools/index.js";

describe("BudgetTracker", () => {
  it("accumulates token usage and configurable estimated cost", () => {
    const tracker = new BudgetTracker({
      maxCost: 3,
      pricing: {
        currency: "CNY",
        inputCostPerMillionTokens: 1,
        outputCostPerMillionTokens: 2,
        cacheReadCostPerMillionTokens: 0.1,
        cacheWriteCostPerMillionTokens: 1.25,
      },
    });

    expect(
      tracker.record({
        input: 1_000_000,
        output: 500_000,
        cacheRead: 100_000,
        cacheWrite: 50_000,
      }),
    ).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 50_000,
      totalTokens: 1_650_000,
      estimatedCost: 2.0725,
      currency: "CNY",
    });
    expect(() => tracker.assertCanStartModelCall()).not.toThrow();
  });

  it("blocks the next model call when a limit has been reached", () => {
    const tracker = new BudgetTracker({ maxTotalTokens: 15 });
    tracker.record({ input: 10, output: 5 });

    expect(() => tracker.assertCanStartModelCall()).toThrow(
      BudgetExceededError,
    );
    try {
      tracker.assertCanStartModelCall();
    } catch (error) {
      expect(error).toMatchObject({
        metric: "totalTokens",
        actual: 15,
        limit: 15,
      });
    }
  });

  it("requires explicit provider pricing for a cost limit", () => {
    expect(() => new BudgetTracker({ maxCost: 1 })).toThrow(
      "maxCost requires provider-specific token pricing",
    );
  });

  it("reads generic currency and prices from environment values", () => {
    expect(
      createBudgetFromEnvironment({
        AGENT_MAX_TOTAL_TOKENS: "120000",
        AGENT_MAX_COST: "10",
        AGENT_COST_CURRENCY: "CNY",
        AGENT_INPUT_COST_PER_MILLION_TOKENS: "1.5",
        AGENT_OUTPUT_COST_PER_MILLION_TOKENS: "6",
      }),
    ).toEqual({
      maxTotalTokens: 120000,
      maxCost: 10,
      pricing: {
        currency: "CNY",
        inputCostPerMillionTokens: 1.5,
        outputCostPerMillionTokens: 6,
      },
    });
  });
});

describe("Agent budget", () => {
  it("emits usage and stops before a second model call", async () => {
    let calls = 0;
    const replies: AssistantMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "budget-call",
            name: "calculator",
            arguments: { operation: "add", left: 1, right: 2 },
          },
        ],
        stopReason: "toolUse",
        usage: { input: 10, output: 5 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "3" }],
        stopReason: "stop",
        usage: { input: 20, output: 1 },
      },
    ];
    const model: ModelProvider = {
      name: "budget-model",
      async generate() {
        const reply = replies[calls++];
        if (!reply) throw new Error("No reply.");
        return reply;
      },
    };
    const agent = new Agent({
      model,
      tools: [calculatorTool],
      budget: { maxTotalTokens: 15 },
    });
    const events: AgentEvent[] = [];

    await expect(async () => {
      for await (const event of agent.run("1+2")) events.push(event);
    }).rejects.toBeInstanceOf(BudgetExceededError);

    expect(calls).toBe(1);
    expect(events).toContainEqual({
      type: "usage",
      usage: { input: 10, output: 5 },
      totals: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
      },
    });
    // 第一轮完整 assistant 与 tool result 都保留，只有第二次模型调用被阻止。
    expect(agent.context.messages).toHaveLength(3);
  });

  it("fails closed when a limited provider omits usage", async () => {
    const model: ModelProvider = {
      name: "unmetered",
      async generate() {
        return {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          stopReason: "stop",
        };
      },
    };
    const agent = new Agent({
      model,
      budget: { maxTotalTokens: 100 },
    });

    await expect(async () => {
      for await (const _event of agent.run("question")) {
        // Consume events until budget validation fails.
      }
    }).rejects.toBeInstanceOf(BudgetUsageUnavailableError);
    // 响应是完整消息，所以即使 usage 缺失也不会留下半条 history。
    expect(agent.context.messages).toHaveLength(2);
  });
});
