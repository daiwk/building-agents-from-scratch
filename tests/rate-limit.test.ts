import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Agent,
  ModelRateLimiter,
  RetryableModelError,
  callModelWithPolicy,
  createRateLimiterFromEnvironment,
  waitForRateLimit,
  type ModelProvider,
} from "../src/core/index.js";

afterEach(() => vi.useRealTimers());

describe("ModelRateLimiter", () => {
  it("smooths requests across the configured window", () => {
    let now = 1_000;
    const limiter = new ModelRateLimiter(
      { maxRequests: 2, windowMs: 1_000 },
      () => now,
    );

    expect(limiter.reserve()).toBe(0);
    expect(limiter.reserve()).toBe(500);
    now = 2_000;
    expect(limiter.reserve()).toBe(0);
  });

  it("requires both environment values", () => {
    expect(() =>
      createRateLimiterFromEnvironment({
        AGENT_RATE_LIMIT_MAX_REQUESTS: "60",
      }),
    ).toThrow("must be configured together");

    expect(
      createRateLimiterFromEnvironment({
        AGENT_RATE_LIMIT_MAX_REQUESTS: "60",
        AGENT_RATE_LIMIT_WINDOW_MS: "60000",
      })?.options,
    ).toEqual({ maxRequests: 60, windowMs: 60000 });
  });

  it("keeps cancellation responsive while waiting", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = waitForRateLimit(10_000, controller.signal);

    controller.abort(new Error("user stopped"));

    await expect(waiting).rejects.toThrow("user stopped");
  });

  it("emits an observable wait event before calling the model", async () => {
    vi.useFakeTimers();
    const limiter = new ModelRateLimiter(
      { maxRequests: 2, windowMs: 1_000 },
      () => 0,
    );
    limiter.reserve(); // 模拟同一个 Agent 刚完成过一次模型调用。
    const generate = vi.fn(async () => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "ok" }],
      stopReason: "stop" as const,
    }));
    const model: ModelProvider = { name: "limited", generate };
    const iterator = new Agent({ model, rateLimiter: limiter }).run("hello");

    expect(await iterator.next()).toMatchObject({ value: { type: "agentStart" } });
    expect(await iterator.next()).toMatchObject({ value: { type: "turnStart" } });
    expect(await iterator.next()).toMatchObject({
      value: { type: "rateLimitWait", delayMs: 500 },
    });
    expect(generate).not.toHaveBeenCalled();

    const nextEvent = iterator.next();
    await vi.advanceTimersByTimeAsync(500);
    expect(await nextEvent).toMatchObject({ value: { type: "message" } });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("applies the same limiter to automatic retries", async () => {
    vi.useFakeTimers();
    const limiter = new ModelRateLimiter(
      { maxRequests: 2, windowMs: 1_000 },
      () => 0,
    );
    limiter.reserve(); // Agent loop 已为首次调用预留位置。
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new RetryableModelError("temporary"))
      .mockResolvedValueOnce({
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "ok" }],
        stopReason: "stop" as const,
      });
    const pending = callModelWithPolicy(
      { name: "retrying", generate },
      { systemPrompt: "", messages: [], tools: [] },
      { maxRetries: 1, retryDelayMs: 0 },
      limiter,
    );

    await vi.advanceTimersByTimeAsync(499);
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ stopReason: "stop" });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
