/** 模型请求限流配置：在 windowMs 内平均最多发出 maxRequests 次请求。 */
export type ModelRateLimit = {
  maxRequests: number;
  windowMs: number;
};

/**
 * 一个适合教学的平滑限流器。
 *
 * 例如 60 次/分钟会被换算为每 1 秒最多启动一次请求。与“整分钟计数”相比，平滑间隔
 * 不会在分钟边界突然同时发出大量请求。Limiter 放在 Agent 上，因此多次 run() 共享状态。
 */
export class ModelRateLimiter {
  private readonly spacingMs: number;
  private nextAvailableAt = 0;

  constructor(
    readonly options: ModelRateLimit,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(options.maxRequests) || options.maxRequests <= 0) {
      throw new Error("rateLimit.maxRequests must be a positive integer.");
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error("rateLimit.windowMs must be a positive number.");
    }
    this.spacingMs = options.windowMs / options.maxRequests;
  }

  /** 预留下一次调用时刻，并返回调用者需要等待的毫秒数。 */
  reserve(): number {
    const currentTime = this.now();
    const scheduledAt = Math.max(currentTime, this.nextAvailableAt);
    this.nextAvailableAt = scheduledAt + this.spacingMs;
    return Math.max(0, Math.ceil(scheduledAt - currentTime));
  }
}

/** 等待限流窗口，同时继续响应用户的 AbortSignal。 */
export async function waitForRateLimit(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) return;
  if (signal?.aborted) throw abortReason(signal);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", cancel, { once: true });

    function finish(): void {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }

    function cancel(): void {
      clearTimeout(timer);
      reject(signal ? abortReason(signal) : new Error("Agent aborted."));
    }
  });
}

/** 从 CLI/Web 共用的环境变量创建限流器。 */
export function createRateLimiterFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ModelRateLimiter | undefined {
  const maxRaw = environment.AGENT_RATE_LIMIT_MAX_REQUESTS?.trim();
  const windowRaw = environment.AGENT_RATE_LIMIT_WINDOW_MS?.trim();
  if (!maxRaw && !windowRaw) return undefined;
  if (!maxRaw || !windowRaw) {
    throw new Error(
      "AGENT_RATE_LIMIT_MAX_REQUESTS and AGENT_RATE_LIMIT_WINDOW_MS must be configured together.",
    );
  }

  return new ModelRateLimiter({
    maxRequests: parsePositiveInteger(
      "AGENT_RATE_LIMIT_MAX_REQUESTS",
      maxRaw,
    ),
    windowMs: parsePositiveNumber("AGENT_RATE_LIMIT_WINDOW_MS", windowRaw),
  });
}

function parsePositiveNumber(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function parsePositiveInteger(name: string, raw: string): number {
  const value = parsePositiveNumber(name, raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason ? String(signal.reason) : "Agent aborted.");
}
