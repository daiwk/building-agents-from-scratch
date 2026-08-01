"""一次 Agent 任务的 token 与成本软预算。"""

from dataclasses import dataclass
from typing import Any


@dataclass
class TokenPricing:
    """每百万 token 的价格；币种和价格都由使用者填写。"""

    currency: str
    input_per_million: float
    output_per_million: float
    cache_read_per_million: float | None = None
    cache_write_per_million: float | None = None


@dataclass
class AgentBudget:
    """每次 ``Agent.run()`` 都会用一份新的预算计数器。"""

    max_input_tokens: int | None = None
    max_output_tokens: int | None = None
    max_total_tokens: int | None = None
    max_cost: float | None = None
    pricing: TokenPricing | None = None


class BudgetExceededError(RuntimeError):
    """已有消耗达到上限，不能再开始下一次模型调用。"""


class BudgetUsageUnavailableError(RuntimeError):
    """配置了预算，但模型没有提供可计量的 usage。"""


class BudgetTracker:
    """累计模型响应中的 usage；不调用模型，也不修改消息历史。"""

    def __init__(self, budget: AgentBudget | None = None) -> None:
        self.budget = budget or AgentBudget()
        for name in (
            "max_input_tokens",
            "max_output_tokens",
            "max_total_tokens",
        ):
            limit = getattr(self.budget, name)
            if limit is not None and (
                not isinstance(limit, int) or isinstance(limit, bool) or limit < 0
            ):
                raise ValueError(f"{name} 必须是非负整数")
        if self.budget.max_cost is not None and self.budget.max_cost < 0:
            raise ValueError("max_cost 不能小于 0")
        if self.budget.max_cost is not None and self.budget.pricing is None:
            raise ValueError("max_cost 必须同时配置 token pricing")
        if self.budget.pricing and not self.budget.pricing.currency.strip():
            raise ValueError("pricing.currency 不能为空")
        self.input_tokens = 0
        self.output_tokens = 0
        self.cache_read_tokens = 0
        self.cache_write_tokens = 0
        self.estimated_cost = 0.0

    @property
    def requires_usage(self) -> bool:
        return any(
            limit is not None
            for limit in (
                self.budget.max_input_tokens,
                self.budget.max_output_tokens,
                self.budget.max_total_tokens,
                self.budget.max_cost,
            )
        )

    def record(self, usage: dict[str, Any]) -> dict[str, Any]:
        """MiniMax Anthropic-compatible usage 使用 ``*_tokens`` 字段。"""

        input_tokens = _token_count(usage, "input_tokens")
        output_tokens = _token_count(usage, "output_tokens")
        cache_read = _token_count(usage, "cache_read_input_tokens")
        cache_write = _token_count(usage, "cache_creation_input_tokens")
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.cache_read_tokens += cache_read
        self.cache_write_tokens += cache_write

        pricing = self.budget.pricing
        if pricing:
            self.estimated_cost += (
                input_tokens * pricing.input_per_million
                + output_tokens * pricing.output_per_million
                + cache_read
                * (
                    pricing.cache_read_per_million
                    if pricing.cache_read_per_million is not None
                    else pricing.input_per_million
                )
                + cache_write
                * (
                    pricing.cache_write_per_million
                    if pricing.cache_write_per_million is not None
                    else pricing.input_per_million
                )
            ) / 1_000_000
        return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        total = (
            self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_write_tokens
        )
        result: dict[str, Any] = {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "total_tokens": total,
        }
        if self.budget.pricing:
            result["estimated_cost"] = self.estimated_cost
            result["currency"] = self.budget.pricing.currency
        return result

    def assert_can_start_model_call(self) -> None:
        snapshot = self.snapshot()
        checks = (
            ("input_tokens", self.budget.max_input_tokens),
            ("output_tokens", self.budget.max_output_tokens),
            ("total_tokens", self.budget.max_total_tokens),
            ("estimated_cost", self.budget.max_cost),
        )
        for metric, limit in checks:
            actual = snapshot.get(metric, self.estimated_cost)
            if limit is not None and actual >= limit:
                raise BudgetExceededError(
                    f"Agent budget exhausted: {metric} is {actual}, limit is {limit}."
                )


def _token_count(usage: dict[str, Any], key: str) -> int:
    value = usage.get(key, 0)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"usage.{key} 必须是非负整数")
    return value
