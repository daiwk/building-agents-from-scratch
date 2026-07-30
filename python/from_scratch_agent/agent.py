"""最小 Agent loop。

建议先完整阅读本文件。这里没有网络协议、数据库或 UI，只有 Agent 最核心的
“模型 → 工具 → 结果 → 模型”反馈环。
"""

from collections.abc import Iterator
from typing import Any

from .types import AgentContext, Event, Message, ModelProvider, Tool


def agent_loop(
    context: AgentContext,
    model: ModelProvider,
    max_turns: int = 8,
) -> Iterator[Event]:
    """运行 Agent，并逐个产生可观察事件。

    ``yield`` 和 TypeScript 版的 async generator 作用相同：函数不会一次性返回
    全部结果，而是每走一步就把一个事件交给 CLI、Notebook 或 Web UI。
    """

    yield {"type": "agent_start"}

    # 一轮 = 调用一次模型 + 执行这次模型要求的全部工具。
    for turn in range(1, max_turns + 1):
        yield {"type": "turn_start", "turn": turn}

        # 模型只看见结构化的上下文，不会直接执行 Python 函数。
        assistant = model.generate(
            context.system_prompt,
            context.messages,
            context.tools,
        )
        context.messages.append(assistant)

        # content 是列表，因为一条回复可以同时包含文本和多个工具调用。
        blocks = assistant.get("content", [])
        for block in blocks:
            if block.get("type") == "text":
                yield {"type": "text", "text": block.get("text", "")}

        tool_calls = [
            block for block in blocks if block.get("type") == "tool_call"
        ]

        # 没有工具调用，说明模型已经给出了最终答案。
        if not tool_calls:
            yield {"type": "turn_end", "turn": turn}
            yield {"type": "agent_end", "message": assistant}
            return

        for call in tool_calls:
            yield {"type": "tool_start", "call": call}
            result = _execute_tool(call, context.tools)

            # 这是 Agent 最关键的一步：工具结果成为下一轮模型能看到的消息。
            context.messages.append(result)
            yield {"type": "tool_end", "call": call, "result": result}

        yield {"type": "turn_end", "turn": turn}

    raise RuntimeError(
        f"Agent 已运行 {max_turns} 轮，主动停止以避免无限循环。"
    )


def _execute_tool(call: Message, tools: list[Tool]) -> Message:
    """按名称找到并执行工具，把成功或错误都包装成 tool_result。"""

    tool = next((item for item in tools if item.name == call.get("name")), None)
    if tool is None:
        return _tool_result(call, f"未知工具：{call.get('name')}", is_error=True)

    try:
        arguments = call.get("arguments", {})
        if not isinstance(arguments, dict):
            raise TypeError("工具参数必须是字典")
        return _tool_result(call, tool.execute(arguments), is_error=False)
    except Exception as error:  # 工具失败时让模型有机会根据错误自行修正。
        return _tool_result(call, str(error), is_error=True)


def _tool_result(call: Message, content: str, is_error: bool) -> Message:
    return {
        "role": "tool",
        "tool_call_id": call.get("id", ""),
        "tool_name": call.get("name", ""),
        "content": content,
        "is_error": is_error,
    }


class Agent:
    """保存对话历史的便捷外壳；真正的算法仍然在 agent_loop()。"""

    def __init__(
        self,
        model: ModelProvider,
        system_prompt: str = "你是一个有帮助的助手。",
        tools: list[Tool] | None = None,
        max_turns: int = 8,
    ) -> None:
        self.model = model
        self.max_turns = max_turns
        self.context = AgentContext(
            system_prompt=system_prompt,
            tools=list(tools or []),
        )

    def run(self, user_input: str) -> Iterator[Event]:
        """追加用户消息，然后把底层 loop 的事件原样转发出去。"""

        self.context.messages.append({"role": "user", "content": user_input})
        yield from agent_loop(self.context, self.model, self.max_turns)

    def reset(self) -> None:
        """清空短期记忆。"""

        self.context.messages.clear()
