"""模型轮次的平滑限流器。"""

import time
from collections.abc import Callable
from math import isfinite


class ModelRateLimiter:
    """把 N 次/窗口换算成均匀间隔，并在多次 ``run()`` 间共享状态。"""

    def __init__(
        self,
        max_requests: int,
        window_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if (
            not isinstance(max_requests, int)
            or isinstance(max_requests, bool)
            or max_requests <= 0
        ):
            raise ValueError("max_requests 必须是正整数")
        if not isfinite(window_seconds) or window_seconds <= 0:
            raise ValueError("window_seconds 必须大于 0")
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._clock = clock
        self._spacing = window_seconds / max_requests
        self._next_available_at = 0.0

    def reserve(self) -> float:
        """预留下一次调用时刻，返回需要等待的秒数。"""

        now = self._clock()
        scheduled_at = max(now, self._next_available_at)
        self._next_available_at = scheduled_at + self._spacing
        return max(0.0, scheduled_at - now)
