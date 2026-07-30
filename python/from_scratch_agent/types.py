"""Agent 使用的数据结构。

Python 入门提示：
- ``@dataclass`` 会自动生成初始化方法，适合定义“只有数据”的对象。
- ``Protocol`` 表示接口：任何拥有相同方法的对象都可以使用，不要求继承。
- ``dict[str, Any]`` 表示 key 是字符串、value 可以是任意类型的字典。
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

# 为了让初学者能直接 print 和修改，Python 版用普通字典表示消息。
Message = dict[str, Any]
Event = dict[str, Any]


@dataclass
class Tool:
    """一个可以被模型请求、由宿主程序实际执行的工具。"""

    name: str
    description: str
    input_schema: dict[str, Any]
    execute: Callable[[dict[str, Any]], str]


class ModelProvider(Protocol):
    """所有模型后端都要实现的最小接口。"""

    name: str

    def generate(
        self,
        system_prompt: str,
        messages: list[Message],
        tools: list[Tool],
    ) -> Message:
        """根据当前上下文生成一条 assistant 消息。"""


@dataclass
class AgentContext:
    """Agent 的短期记忆：提示词、消息历史和工具列表。"""

    system_prompt: str
    messages: list[Message] = field(default_factory=list)
    tools: list[Tool] = field(default_factory=list)
