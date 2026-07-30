"""两个安全、容易观察的示例工具。"""

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .types import Tool


def _calculate(arguments: dict[str, Any]) -> str:
    operation = arguments.get("operation")
    left = arguments.get("left")
    right = arguments.get("right")
    if not isinstance(left, (int, float)) or not isinstance(right, (int, float)):
        raise ValueError("left 和 right 必须是数字")

    if operation == "add":
        return str(left + right)
    if operation == "subtract":
        return str(left - right)
    if operation == "multiply":
        return str(left * right)
    if operation == "divide":
        if right == 0:
            raise ValueError("不能除以 0")
        return str(left / right)
    raise ValueError(f"不支持的 operation：{operation}")


calculator_tool = Tool(
    name="calculator",
    description="对两个数字执行一次精确的四则运算。",
    input_schema={
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["add", "subtract", "multiply", "divide"],
            },
            "left": {"type": "number"},
            "right": {"type": "number"},
        },
        "required": ["operation", "left", "right"],
    },
    execute=_calculate,
)


def _current_time(arguments: dict[str, Any]) -> str:
    time_zone = arguments.get("time_zone")
    if not isinstance(time_zone, str):
        raise ValueError("time_zone 必须是字符串，例如 Asia/Shanghai")
    try:
        return datetime.now(ZoneInfo(time_zone)).isoformat(timespec="seconds")
    except ZoneInfoNotFoundError as error:
        raise ValueError(f"未知时区：{time_zone}") from error


current_time_tool = Tool(
    name="current_time",
    description="获取指定 IANA 时区的当前时间。",
    input_schema={
        "type": "object",
        "properties": {"time_zone": {"type": "string"}},
        "required": ["time_zone"],
    },
    execute=_current_time,
)
