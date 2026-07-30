import type {
  AssistantMessage,
  ModelProvider,
  ModelRequest,
} from "./types.js";

export type ModelRetryInfo = {
  // attempt 从 1 开始；这里表示即将进行第几次重试。
  attempt: number;
  delayMs: number;
  error: unknown;
};

export type ModelCallPolicy = {
  // 单次模型请求的最长时间；设为 0 表示不限制。
  timeoutMs?: number;
  // 首次请求失败后最多再试几次。0 表示完全不重试。
  maxRetries?: number;
  // 第一次重试前等待多久，后续按 2 倍指数退避。
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (info: ModelRetryInfo) => Promise<void> | void;
};

/**
 * Provider 可以用这个错误标记“请求失败，但稍后重试可能成功”。
 *
 * 例如：429 限流、5xx 服务错误和网络超时。鉴权失败、参数错误不应重试。
 */
export class RetryableModelError extends Error {
  override readonly name: string = "RetryableModelError";
}

export class ModelTimeoutError extends RetryableModelError {
  override readonly name: string = "ModelTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`Model request timed out after ${timeoutMs} ms.`);
  }
}

/**
 * 给任意 ModelProvider 增加 timeout、retry 和 exponential backoff。
 *
 * 这个模块不修改 Agent 的消息历史：只有模型真正成功返回完整消息后，
 * agent-loop.ts 才会把消息写入 Context，失败的半成品不会污染记忆。
 */
export async function callModelWithPolicy(
  model: ModelProvider,
  request: ModelRequest,
  policy: ModelCallPolicy = {},
): Promise<AssistantMessage> {
  const maxRetries = nonNegativeInteger(policy.maxRetries ?? 0, "maxRetries");
  const retryDelayMs = nonNegativeNumber(
    policy.retryDelayMs ?? 500,
    "retryDelayMs",
  );
  const maxRetryDelayMs = nonNegativeNumber(
    policy.maxRetryDelayMs ?? 8_000,
    "maxRetryDelayMs",
  );
  const timeoutMs = nonNegativeNumber(
    policy.timeoutMs ?? 120_000,
    "timeoutMs",
  );
  const shouldRetry = policy.shouldRetry ?? isRetryableError;

  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(request.signal);
    try {
      return await callWithTimeout(model, request, timeoutMs);
    } catch (error) {
      throwIfAborted(request.signal);
      if (attempt >= maxRetries || !shouldRetry(error)) throw error;

      const delayMs = Math.min(
        retryDelayMs * 2 ** attempt,
        maxRetryDelayMs,
      );
      await policy.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await wait(delayMs, request.signal);
    }
  }
}

function isRetryableError(error: unknown): boolean {
  // fetch 在网络断开、DNS 失败等情况下通常抛出 TypeError。
  return error instanceof RetryableModelError || error instanceof TypeError;
}

async function callWithTimeout(
  model: ModelProvider,
  request: ModelRequest,
  timeoutMs: number,
): Promise<AssistantMessage> {
  const controller = new AbortController();
  const timeoutError = new ModelTimeoutError(timeoutMs);
  let rejectAbort: (reason: Error) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const forwardAbort = () => {
    const reason = abortReason(request.signal);
    controller.abort(reason);
    rejectAbort(reason);
  };
  request.signal?.addEventListener("abort", forwardAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout =
    timeoutMs === 0
      ? new Promise<never>(() => undefined)
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(timeoutError);
            reject(timeoutError);
          }, timeoutMs);
        });

  try {
    return await Promise.race([
      model.generate({ ...request, signal: controller.signal }),
      timeout,
      aborted,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    request.signal?.removeEventListener("abort", forwardAbort);
  }
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Model request aborted.");
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}
