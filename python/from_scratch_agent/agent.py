"""最小 Agent loop。

建议先完整阅读本文件。这里没有网络协议、数据库或 UI，只有 Agent 最核心的
“模型 → 工具 → 结果 → 模型”反馈环。
"""

from collections.abc import Iterator
from typing import Any

from .memory import ConversationStore
from .reliability import ModelCallPolicy, call_with_policy
from .types import AgentContext, Event, Message, ModelProvider, Tool
from .validation import validate_tool_input


def agent_loop(
    context: AgentContext,
    model: ModelProvider,
    max_turns: int = 8,
    model_policy: ModelCallPolicy | None = None,
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
        policy = model_policy or ModelCallPolicy()
        assistant = call_with_policy(
            lambda: model.generate(
                context.system_prompt,
                context.messages,
                context.tools,
            ),
            policy,
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
        validation_errors = validate_tool_input(tool.input_schema, arguments)
        if validation_errors:
            return _tool_result(
                call,
                "工具参数无效：" + "; ".join(validation_errors),
                is_error=True,
            )
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
        model_policy: ModelCallPolicy | None = None,
        memory_store: ConversationStore | None = None,
        session_id: str = "default",
    ) -> None:
        self.model = model
        self.max_turns = max_turns
        self.model_policy = model_policy or ModelCallPolicy()
        self.memory_store = memory_store
        self.session_id = session_id
        self._memory_loaded = False
        self.context = AgentContext(
            system_prompt=system_prompt,
            tools=list(tools or []),
        )

    def run(self, user_input: str) -> Iterator[Event]:
        """追加用户消息，然后把底层 loop 的事件原样转发出去。"""

        self._load_memory_once()
        self.context.messages.append({"role": "user", "content": user_input})
        try:
            yield from agent_loop(
                self.context,
                self.model,
                self.max_turns,
                self.model_policy,
            )
        finally:
            if self.memory_store:
                self.memory_store.save(
                    self.session_id,
                    self.context.messages,
                )

    def reset(self) -> None:
        """清空短期记忆。"""

        self.context.messages.clear()
        self._memory_loaded = True
        if self.memory_store:
            self.memory_store.clear(self.session_id)

    def _load_memory_once(self) -> None:
        if not self.memory_store or self._memory_loaded:
            return
        self.context.messages.extend(self.memory_store.load(self.session_id))
        self._memory_loaded = True
