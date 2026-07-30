"""Python 命令行入口：python -m from_scratch_agent.cli。"""

import os
from pathlib import Path

from .agent import Agent
from .minimax import MiniMaxProvider
from .tools import calculator_tool, current_time_tool


def main() -> None:
    _load_local_env()
    model = MiniMaxProvider(
        api_key=os.environ.get("MINIMAX_API_KEY", ""),
        model=os.environ.get("MINIMAX_MODEL", "MiniMax-M2.7"),
        base_url=os.environ.get(
            "MINIMAX_BASE_URL",
            "https://api.minimaxi.com/anthropic/v1",
        ),
    )
    agent = Agent(
        model=model,
        tools=[calculator_tool, current_time_tool],
        system_prompt="你是一个简洁、可靠的助手；精确计算和时间必须使用工具。",
    )

    print("Python Agent · 输入 /reset 清空记忆，/exit 退出")
    while True:
        user_input = input("you> ").strip()
        if user_input == "/exit":
            break
        if user_input == "/reset":
            agent.reset()
            print("memory cleared")
            continue
        if not user_input:
            continue

        for event in agent.run(user_input):
            if event["type"] == "tool_start":
                print("  tool>", event["call"]["name"], event["call"]["arguments"])
            elif event["type"] == "tool_end":
                print("  result>", event["result"]["content"])
            elif event["type"] == "text":
                print("agent>", event["text"])


def _load_local_env() -> None:
    """读取项目根目录的简单 .env；已有系统环境变量拥有更高优先级。

    这里只实现教学项目需要的 ``KEY=value``，避免为了六行逻辑引入依赖。
    """

    env_file = Path(".env")
    if not env_file.exists():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


if __name__ == "__main__":
    main()
