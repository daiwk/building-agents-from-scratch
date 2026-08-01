"""给同步 Python ModelProvider 增加 timeout、retry 和指数退避。"""

from collections.abc import Callable
from dataclasses import dataclass
from math import isfinite
from queue import Empty, Queue
from threading import Thread
from time import sleep
from typing import TypeVar

from .rate_limit import ModelRateLimiter


T = TypeVar("T")


class RetryableModelError(RuntimeError):
    """临时故障：稍后重试可能成功。"""


class ModelTimeoutError(RetryableModelError):
    """单次模型调用超过配置时间。"""


@dataclass
class ModelCallPolicy:
    timeout_seconds: float = 120
    max_retries: int = 0
    retry_delay_seconds: float = 0.5
    max_retry_delay_seconds: float = 8

    def __post_init__(self) -> None:
        if not isfinite(self.timeout_seconds) or self.timeout_seconds < 0:
            raise ValueError("timeout_seconds 不能小于 0")
        if not isinstance(self.max_retries, int) or self.max_retries < 0:
            raise ValueError("max_retries 必须是非负整数")
        if (
            not isfinite(self.retry_delay_seconds)
            or self.retry_delay_seconds < 0
        ):
            raise ValueError("retry_delay_seconds 不能小于 0")
        if (
            not isfinite(self.max_retry_delay_seconds)
            or self.max_retry_delay_seconds < 0
        ):
            raise ValueError("max_retry_delay_seconds 不能小于 0")


def call_with_policy(
    operation: Callable[[], T],
    policy: ModelCallPolicy,
    retry_rate_limiter: ModelRateLimiter | None = None,
) -> T:
    """调用模型；只重试显式标记的临时错误。"""

    for attempt in range(policy.max_retries + 1):
        if attempt > 0 and retry_rate_limiter:
            sleep(retry_rate_limiter.reserve())
        try:
            return _call_with_timeout(operation, policy.timeout_seconds)
        except RetryableModelError:
            if attempt >= policy.max_retries:
                raise
            delay = min(
                policy.retry_delay_seconds * (2**attempt),
                policy.max_retry_delay_seconds,
            )
            sleep(delay)
    raise AssertionError("unreachable")


def _call_with_timeout(operation: Callable[[], T], timeout: float) -> T:
    if timeout == 0:
        return operation()

    result_queue: Queue[tuple[bool, object]] = Queue(maxsize=1)

    def worker() -> None:
        try:
            result_queue.put((True, operation()))
        except Exception as error:
            result_queue.put((False, error))

    # Python 无法安全地强杀线程。daemon=True 保证忽略取消的 provider 不会阻止退出；
    # 官方 HTTP provider 同时使用 socket timeout，能真正结束网络请求。
    Thread(target=worker, daemon=True).start()
    try:
        succeeded, value = result_queue.get(timeout=timeout)
    except Empty as error:
        raise ModelTimeoutError(
            f"模型请求超过 {timeout:g} 秒，已停止等待。"
        ) from error

    if succeeded:
        return value  # type: ignore[return-value]
    if isinstance(value, Exception):
        raise value
    raise RuntimeError(str(value))
