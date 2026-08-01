"""最小 Agent loop。

建议先完整阅读本文件。这里没有网络协议、数据库或 UI，只有 Agent 最核心的
“模型 → 工具 → 结果 → 模型”反馈环。
"""

import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .budget import AgentBudget, BudgetTracker, BudgetUsageUnavailableError
from .context_builder import ContextBuilder
from .memory import ConversationStore
from .rate_limit import ModelRateLimiter
from .reliability import ModelCallPolicy, call_with_policy
from .types import AgentContext, Event, Message, ModelProvider, Tool
from .tracing import Span, Tracer
from .validation import validate_tool_input


def agent_loop(
    context: AgentContext,
    model: ModelProvider,
    max_turns: int = 8,
    model_policy: ModelCallPolicy | None = None,
    budget: AgentBudget | None = None,
    rate_limiter: ModelRateLimiter | None = None,
    tool_execution: str = "sequential",
    tracer: Tracer | None = None,
    context_builder: ContextBuilder | None = None,
) -> Iterator[Event]:
    """给核心循环包一层 root span；tracing 关闭时不会创建任何对象。"""

    run_span = (
        tracer.start_span(
            "agent.run",
            attributes={"gen_ai.provider.name": model.name},
        )
        if tracer
        else None
    )
    completed = False
    failure: BaseException | None = None
    try:
        yield from _run_agent_loop(
            context,
            model,
            max_turns,
            model_policy,
            budget,
            rate_limiter,
            tool_execution,
            tracer,
            run_span,
            context_builder,
        )
        completed = True
    except BaseException as error:
        failure = error
        raise
    finally:
        if run_span:
            run_span.end(
                "ERROR" if failure else "OK" if completed else "UNSET",
                error=failure,
            )


def _run_agent_loop(
    context: AgentContext,
    model: ModelProvider,
    max_turns: int = 8,
    model_policy: ModelCallPolicy | None = None,
    budget: AgentBudget | None = None,
    rate_limiter: ModelRateLimiter | None = None,
    tool_execution: str = "sequential",
    tracer: Tracer | None = None,
    run_span: Span | None = None,
    context_builder: ContextBuilder | None = None,
) -> Iterator[Event]:
    """运行 Agent，并逐个产生可观察事件。

    ``yield`` 和 TypeScript 版的 async generator 作用相同：函数不会一次性返回
    全部结果，而是每走一步就把一个事件交给 CLI、Notebook 或 Web UI。
    """

    yield {"type": "agent_start"}
    tracker = BudgetTracker(budget)
    _validate_tool_execution(tool_execution)

    # 一轮 = 调用一次模型 + 执行这次模型要求的全部工具。
    for turn in range(1, max_turns + 1):
        # usage 在上一轮响应结束后才可得，所以在下一次模型调用前检查。
        tracker.assert_can_start_model_call()
        yield {"type": "turn_start", "turn": turn}
        delay_seconds = rate_limiter.reserve() if rate_limiter else 0
        if delay_seconds > 0:
            yield {
                "type": "rate_limit_wait",
                "delay_seconds": delay_seconds,
            }
            # 同步教学版没有 AbortSignal；等待行为保持显式，便于替换为 asyncio.sleep。
            time.sleep(delay_seconds)

        # 模型只看见结构化的上下文，不会直接执行 Python 函数。
        policy = model_policy or ModelCallPolicy()
        model_span = (
            tracer.start_span(
                "gen_ai.chat",
                parent=run_span,
                kind="CLIENT",
                attributes={
                    "gen_ai.operation.name": "chat",
                    "gen_ai.provider.name": model.name,
                    "agent.turn": turn,
                },
            )
            if tracer
            else None
        )
        try:
            model_context = (
                context_builder.build(context) if context_builder else context
            )
            assistant = call_with_policy(
                lambda: model.generate(
                    model_context.system_prompt,
                    model_context.messages,
                    model_context.tools,
                ),
                policy,
                rate_limiter,
            )
            if model_span:
                model_span.end("OK", _usage_trace_attributes(assistant))
        except BaseException as error:
            if model_span:
                model_span.end("ERROR", error=error)
            raise
        context.messages.append(assistant)
        usage = assistant.get("usage")
        if isinstance(usage, dict) and usage:
            yield {
                "type": "usage",
                "usage": usage,
                "totals": tracker.record(usage),
            }
        elif tracker.requires_usage:
            raise BudgetUsageUnavailableError(
                "已配置预算，但模型响应没有 usage，无法安全继续计量。"
            )

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

        if tool_execution == "parallel":
            for call in tool_calls:
                yield {"type": "tool_start", "call": call}
            # future 同时运行，但下面仍按 tool_calls 原顺序读取并写回结果。
            with ThreadPoolExecutor(max_workers=len(tool_calls)) as executor:
                futures = [
                    executor.submit(
                        _execute_tool_traced,
                        call,
                        context.tools,
                        tracer,
                        run_span,
                    )
                    for call in tool_calls
                ]
                for call, future in zip(tool_calls, futures, strict=True):
                    result = future.result()
                    context.messages.append(result)
                    yield {"type": "tool_end", "call": call, "result": result}
        else:
            for call in tool_calls:
                yield {"type": "tool_start", "call": call}
                result = _execute_tool_traced(
                    call,
                    context.tools,
                    tracer,
                    run_span,
                )

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


def _execute_tool_traced(
    call: Message,
    tools: list[Tool],
    tracer: Tracer | None,
    parent: Span | None,
) -> Message:
    span = (
        tracer.start_span(
            f"execute_tool {call.get('name', '')}",
            parent=parent,
            attributes={
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": str(call.get("name", "")),
                "gen_ai.tool.call.id": str(call.get("id", "")),
            },
        )
        if tracer
        else None
    )
    result = _execute_tool(call, tools)
    if span:
        span.end(
            "ERROR" if result["is_error"] else "OK",
            {"gen_ai.tool.result.is_error": bool(result["is_error"])},
        )
    return result


def _usage_trace_attributes(
    assistant: Message,
) -> dict[str, str | int | float | bool]:
    usage = assistant.get("usage")
    if not isinstance(usage, dict):
        return {}
    mapping = {
        "input_tokens": "gen_ai.usage.input_tokens",
        "output_tokens": "gen_ai.usage.output_tokens",
        "cache_read_input_tokens": "gen_ai.usage.cache_read_tokens",
        "cache_creation_input_tokens": "gen_ai.usage.cache_write_tokens",
    }
    return {
        attribute: value
        for key, attribute in mapping.items()
        if isinstance((value := usage.get(key)), (int, float))
        and not isinstance(value, bool)
    }


def _tool_result(call: Message, content: str, is_error: bool) -> Message:
    return {
        "role": "tool",
        "tool_call_id": call.get("id", ""),
        "tool_name": call.get("name", ""),
        "content": content,
        "is_error": is_error,
    }


def _validate_tool_execution(value: str) -> None:
    if value not in {"sequential", "parallel"}:
        raise ValueError("tool_execution 必须是 sequential 或 parallel")


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
        budget: AgentBudget | None = None,
        rate_limiter: ModelRateLimiter | None = None,
        tool_execution: str = "sequential",
        tracer: Tracer | None = None,
        context_builder: ContextBuilder | None = None,
    ) -> None:
        self.model = model
        self.max_turns = max_turns
        self.model_policy = model_policy or ModelCallPolicy()
        self.memory_store = memory_store
        self.session_id = session_id
        self.budget = budget
        self.rate_limiter = rate_limiter
        _validate_tool_execution(tool_execution)
        self.tool_execution = tool_execution
        self.tracer = tracer
        self.context_builder = context_builder
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
                self.budget,
                self.rate_limiter,
                self.tool_execution,
                self.tracer,
                self.context_builder,
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
