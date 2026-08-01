"""结构化 sub-agent handoff、事件总线和有界并行 scheduler。"""

import json
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from dataclasses import asdict, dataclass
from threading import Event
from typing import Callable

from .agent import Agent
from .budget import AgentBudget
from .types import Event as AgentEvent, Message, Tool


@dataclass
class HandoffResult:
    status: str
    task: str
    output: str
    agent_id: str
    parent_agent_id: str | None
    depth: int
    turns: int
    total_tokens: int
    duration_ms: int
    error: str | None = None


class AgentEventBus:
    def __init__(self) -> None:
        self.listeners: list[Callable[[dict], None]] = []

    def subscribe(self, listener: Callable[[dict], None]) -> Callable[[], None]:
        self.listeners.append(listener)
        return lambda: self.listeners.remove(listener)

    def publish(self, agent_id: str, parent_agent_id: str | None, event: AgentEvent) -> None:
        envelope = {
            "agent_id": agent_id,
            "parent_agent_id": parent_agent_id,
            "timestamp": time.time(),
            "event": event,
        }
        for listener in list(self.listeners):
            try:
                listener(envelope)
            except Exception:
                # 可观测 listener 失败不能改变 child 的业务结果。
                continue


def run_subagent(
    task: str,
    create_agent: Callable[[], Agent],
    agent_id: str,
    parent_agent_id: str | None = None,
    depth: int = 1,
    max_depth: int = 3,
    max_turns: int = 8,
    max_tokens: int | None = None,
    timeout_seconds: float | None = None,
    cancel_event: Event | None = None,
    event_bus: AgentEventBus | None = None,
    parent_messages: list[Message] | None = None,
    select_context: Callable[[list[Message]], list[Message]] | None = None,
) -> HandoffResult:
    started = time.monotonic()
    effective_cancel = cancel_event or Event()
    if depth < 0 or max_depth < 0:
        raise ValueError("depth 和 max_depth 不能为负数")
    if max_turns <= 0:
        raise ValueError("max_turns 必须大于 0")
    if max_tokens is not None and max_tokens <= 0:
        raise ValueError("max_tokens 必须大于 0")
    if timeout_seconds is not None and timeout_seconds < 0:
        raise ValueError("timeout_seconds 不能为负数")
    if depth > max_depth:
        raise ValueError(f"Sub-agent depth {depth} exceeds limit {max_depth}")
    if effective_cancel.is_set():
        return _handoff("cancelled", task, "", agent_id, parent_agent_id, depth, 0, 0, started)

    def execute() -> HandoffResult:
        child = create_agent()
        child.max_turns = max_turns
        if max_tokens is not None:
            child.budget = AgentBudget(max_total_tokens=max_tokens)
        if select_context:
            selected = select_context(list(parent_messages or []))
            child.context.messages.extend(json.loads(json.dumps(selected, ensure_ascii=False)))
        turns = 0
        total_tokens = 0
        output = ""
        for event in child.run(task):
            if effective_cancel.is_set():
                return _handoff("cancelled", task, "", agent_id, parent_agent_id, depth,
                                turns, total_tokens, started)
            if event["type"] == "turn_start":
                turns = int(event["turn"])
            elif event["type"] == "usage":
                total_tokens = int(event["totals"]["total_tokens"])
            elif event["type"] == "agent_end":
                blocks = event["message"].get("content", [])
                output = "\n".join(
                    str(block.get("text", ""))
                    for block in blocks if block.get("type") == "text"
                ).strip()
            if event_bus:
                event_bus.publish(agent_id, parent_agent_id, event)
        return _handoff("completed", task, output, agent_id, parent_agent_id, depth,
                        turns, total_tokens, started)

    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(execute)
    try:
        return future.result(timeout=timeout_seconds)
    except TimeoutError:
        effective_cancel.set()
        return _handoff("cancelled", task, "", agent_id, parent_agent_id, depth,
                        0, 0, started, "Sub-agent time budget exceeded")
    except Exception as error:
        return _handoff("failed", task, "", agent_id, parent_agent_id, depth,
                        0, 0, started, str(error))
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def agent_as_tool(name: str, description: str, create_agent: Callable[[], Agent],
                  **options) -> Tool:
    def execute(arguments: dict) -> str:
        task = arguments.get("task")
        if not isinstance(task, str):
            raise ValueError("Sub-agent task 必须是字符串")
        result = run_subagent(task, create_agent, name, **options)
        if result.status != "completed":
            raise RuntimeError(result.error or result.status)
        return json.dumps(asdict(result), ensure_ascii=False)

    return Tool(
        name=name,
        description=description,
        input_schema={
            "type": "object",
            "properties": {"task": {"type": "string"}},
            "required": ["task"],
            "additionalProperties": False,
        },
        execute=execute,
    )


class SubagentScheduler:
    def __init__(self, concurrency: int = 4) -> None:
        if concurrency <= 0:
            raise ValueError("concurrency 必须大于 0")
        self.concurrency = concurrency

    def run(self, jobs: list[dict]) -> list[HandoffResult]:
        with ThreadPoolExecutor(max_workers=self.concurrency) as executor:
            futures = [executor.submit(run_subagent, **job) for job in jobs]
            return [future.result() for future in futures]


def _handoff(status, task, output, agent_id, parent_agent_id, depth,
             turns, total_tokens, started, error=None) -> HandoffResult:
    return HandoffResult(
        status, task, output, agent_id, parent_agent_id, depth, turns,
        total_tokens, int((time.monotonic() - started) * 1000), error,
    )
