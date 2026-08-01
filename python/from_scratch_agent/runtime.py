"""把环境变量装配成 Python Agent，供 CLI 和二次开发复用。"""

import os
from math import isfinite
from pathlib import Path

from .agent import Agent
from .budget import AgentBudget, TokenPricing
from .memory import JsonFileConversationStore
from .rate_limit import ModelRateLimiter
from .minimax import MiniMaxProvider
from .registry import create_builtin_tool_registry
from .reliability import ModelCallPolicy
from .skills import (
    SkillCatalog,
    apply_skills_to_system_prompt,
    load_skills_from_directory,
)
from .tracing import JsonlTraceExporter, Tracer


def load_local_env(file_path: str | Path = ".env") -> None:
    """读取简单 KEY=value；已有系统环境变量优先。"""

    env_file = Path(file_path)
    if not env_file.exists():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def create_agent_from_env(session_id: str | None = None) -> Agent:
    """使用与 TypeScript 版相同的 AGENT_* 配置创建 Python Agent。"""

    timeout_seconds = _read_non_negative_float(
        "AGENT_MODEL_TIMEOUT_MS", 120_000
    ) / 1000
    model = MiniMaxProvider(
        api_key=os.environ.get("MINIMAX_API_KEY", ""),
        model=os.environ.get("MINIMAX_MODEL", "MiniMax-M2.7"),
        base_url=os.environ.get(
            "MINIMAX_BASE_URL",
            "https://api.minimaxi.com/anthropic/v1",
        ),
        timeout_seconds=timeout_seconds,
    )
    tool_names = _read_list(
        "AGENT_TOOLS",
        ["calculator", "current_time"],
    )
    tools = create_builtin_tool_registry().select(tool_names)

    skill_names = _read_list("AGENT_SKILLS")
    selected_skills = []
    if skill_names:
        catalog = SkillCatalog().register_many(
            load_skills_from_directory(
                os.environ.get("AGENT_SKILLS_DIR", "skills")
            )
        )
        selected_skills = catalog.select(skill_names)

    memory_file = os.environ.get("AGENT_MEMORY_FILE", "").strip()
    memory_store = (
        JsonFileConversationStore(memory_file) if memory_file else None
    )
    base_prompt = (
        "你是一个简洁、可靠的助手。"
        "需要精确计算或当前时间时，必须使用工具。"
    )
    budget = _create_budget_from_env()
    rate_limiter = _create_rate_limiter_from_env()
    trace_file = os.environ.get("AGENT_TRACE_FILE", "").strip()
    tracer = Tracer(JsonlTraceExporter(trace_file)) if trace_file else None
    return Agent(
        model=model,
        tools=tools,
        system_prompt=apply_skills_to_system_prompt(
            base_prompt, selected_skills
        ),
        model_policy=ModelCallPolicy(
            timeout_seconds=timeout_seconds,
            max_retries=_read_non_negative_int(
                "AGENT_MODEL_MAX_RETRIES", 1
            ),
            retry_delay_seconds=_read_non_negative_float(
                "AGENT_RETRY_DELAY_MS", 500
            )
            / 1000,
            max_retry_delay_seconds=_read_non_negative_float(
                "AGENT_MAX_RETRY_DELAY_MS", 8_000
            )
            / 1000,
        ),
        memory_store=memory_store,
        session_id=session_id
        or os.environ.get("AGENT_SESSION_ID", "python-cli"),
        budget=budget,
        rate_limiter=rate_limiter,
        tool_execution=_read_tool_execution(),
        tracer=tracer,
    )


def _read_tool_execution() -> str:
    value = os.environ.get("AGENT_TOOL_EXECUTION", "sequential").strip()
    if value not in {"sequential", "parallel"}:
        raise ValueError("AGENT_TOOL_EXECUTION 必须是 sequential 或 parallel")
    return value


def _create_rate_limiter_from_env() -> ModelRateLimiter | None:
    max_raw = os.environ.get("AGENT_RATE_LIMIT_MAX_REQUESTS", "").strip()
    window_raw = os.environ.get("AGENT_RATE_LIMIT_WINDOW_MS", "").strip()
    if not max_raw and not window_raw:
        return None
    if not max_raw or not window_raw:
        raise ValueError("限流次数和窗口必须一起配置")
    max_requests = _read_positive_int("AGENT_RATE_LIMIT_MAX_REQUESTS")
    window_ms = _read_positive_float("AGENT_RATE_LIMIT_WINDOW_MS")
    return ModelRateLimiter(max_requests, window_ms / 1000)


def _create_budget_from_env() -> AgentBudget | None:
    """只有出现预算上限时才启用计量；单独填写价格不会改变运行行为。"""

    limit_names = (
        "AGENT_MAX_INPUT_TOKENS",
        "AGENT_MAX_OUTPUT_TOKENS",
        "AGENT_MAX_TOTAL_TOKENS",
        "AGENT_MAX_COST",
    )
    if not any(os.environ.get(name, "").strip() for name in limit_names):
        return None

    input_rate = _read_optional_float(
        "AGENT_INPUT_COST_PER_MILLION_TOKENS"
    )
    output_rate = _read_optional_float(
        "AGENT_OUTPUT_COST_PER_MILLION_TOKENS"
    )
    if (input_rate is None) != (output_rate is None):
        raise ValueError("输入和输出 token 单价必须一起配置")

    pricing = None
    if input_rate is not None and output_rate is not None:
        currency = os.environ.get("AGENT_COST_CURRENCY", "").strip()
        if not currency:
            raise ValueError("成本计量需要 AGENT_COST_CURRENCY")
        pricing = TokenPricing(
            currency=currency,
            input_per_million=input_rate,
            output_per_million=output_rate,
            cache_read_per_million=_read_optional_float(
                "AGENT_CACHE_READ_COST_PER_MILLION_TOKENS"
            ),
            cache_write_per_million=_read_optional_float(
                "AGENT_CACHE_WRITE_COST_PER_MILLION_TOKENS"
            ),
        )
    max_cost = _read_optional_float("AGENT_MAX_COST")
    if max_cost is not None and pricing is None:
        raise ValueError("AGENT_MAX_COST 需要币种及输入/输出 token 单价")

    return AgentBudget(
        max_input_tokens=_read_optional_int("AGENT_MAX_INPUT_TOKENS"),
        max_output_tokens=_read_optional_int("AGENT_MAX_OUTPUT_TOKENS"),
        max_total_tokens=_read_optional_int("AGENT_MAX_TOTAL_TOKENS"),
        max_cost=max_cost,
        pricing=pricing,
    )


def _read_list(name: str, fallback: list[str] | None = None) -> list[str]:
    raw = os.environ.get(name)
    if raw is None:
        return list(fallback or [])
    return [item.strip() for item in raw.split(",") if item.strip()]


def _read_non_negative_float(name: str, fallback: float) -> float:
    raw = os.environ.get(name)
    value = float(fallback) if raw in {None, ""} else float(raw)
    if value < 0:
        raise ValueError(f"{name} 不能小于 0")
    return value


def _read_non_negative_int(name: str, fallback: int) -> int:
    value = _read_non_negative_float(name, fallback)
    if not value.is_integer():
        raise ValueError(f"{name} 必须是整数")
    return int(value)


def _read_optional_float(name: str) -> float | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    return _read_non_negative_float(name, 0)


def _read_optional_int(name: str) -> int | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    return _read_non_negative_int(name, 0)


def _read_positive_float(name: str) -> float:
    value = float(os.environ[name])
    if not isfinite(value) or value <= 0:
        raise ValueError(f"{name} 必须大于 0")
    return value


def _read_positive_int(name: str) -> int:
    value = _read_positive_float(name)
    if not value.is_integer():
        raise ValueError(f"{name} 必须是整数")
    return int(value)
