"""工具注册表：注册工具不代表自动授权给模型。"""

from __future__ import annotations

from collections.abc import Iterable

from .types import Tool


class ToolRegistry:
    """集中注册工具，并按名称选择本次 Agent 可用的工具。"""

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> "ToolRegistry":
        if tool.name in self._tools:
            raise ValueError(f"工具已注册：{tool.name}")
        self._tools[tool.name] = tool
        return self

    def register_many(self, tools: Iterable[Tool]) -> "ToolRegistry":
        for tool in tools:
            self.register(tool)
        return self

    def list(self) -> list[Tool]:
        return list(self._tools.values())

    def select(self, names: Iterable[str]) -> list[Tool]:
        selected: list[Tool] = []
        for name in names:
            tool = self._tools.get(name)
            if tool is None:
                available = ", ".join(self._tools)
                raise ValueError(f"未知工具：{name}；可用工具：{available}")
            selected.append(tool)
        return selected


def create_builtin_tool_registry() -> ToolRegistry:
    """创建包含项目安全示例工具的 registry。"""

    # 放在函数内部 import，避免 tools.py 与 registry.py 循环导入。
    from .tools import calculator_tool, current_time_tool

    return ToolRegistry().register_many([calculator_tool, current_time_tool])
