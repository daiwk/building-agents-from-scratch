"""把环境变量装配成 Python Agent，供 CLI 和二次开发复用。"""

import os
from pathlib import Path

from .agent import Agent
from .memory import JsonFileConversationStore
from .minimax import MiniMaxProvider
from .registry import create_builtin_tool_registry
from .reliability import ModelCallPolicy
from .skills import (
    SkillCatalog,
    apply_skills_to_system_prompt,
    load_skills_from_directory,
)


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
