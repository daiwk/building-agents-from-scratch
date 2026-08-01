"""Python 版离线测试，不访问真实 MiniMax。"""

import unittest
from threading import Lock
from time import sleep
from typing import Any
from unittest.mock import patch

from from_scratch_agent import (
    Agent,
    AgentBudget,
    BudgetExceededError,
    BudgetTracker,
    ModelRateLimiter,
    TokenPricing,
    calculator_tool,
)
from from_scratch_agent.types import Message, Tool


class ScriptedModel:
    """按顺序返回预设消息的假模型，便于精确观察 Agent loop。"""

    name = "scripted"

    def __init__(self, replies: list[Message]) -> None:
        self.replies = replies
        self.calls = 0

    def generate(
        self,
        system_prompt: str,
        messages: list[Message],
        tools: list[Tool],
    ) -> Message:
        del system_prompt, messages, tools
        reply = self.replies[self.calls]
        self.calls += 1
        return reply


class AgentTest(unittest.TestCase):
    def test_tool_loop(self) -> None:
        model = ScriptedModel(
            [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_call",
                            "id": "call-1",
                            "name": "calculator",
                            "arguments": {
                                "operation": "multiply",
                                "left": 6,
                                "right": 7,
                            },
                        }
                    ],
                },
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "答案是 42"}],
                },
            ]
        )
        agent = Agent(model, tools=[calculator_tool])

        events = list(agent.run("6 × 7 是多少？"))

        self.assertEqual(model.calls, 2)
        self.assertIn("tool_start", [event["type"] for event in events])
        self.assertEqual(agent.context.messages[2]["content"], "42")
        self.assertEqual(events[-1]["type"], "agent_end")

    def test_unknown_tool_becomes_error_result(self) -> None:
        model = ScriptedModel(
            [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_call",
                            "id": "call-1",
                            "name": "missing",
                            "arguments": {},
                        }
                    ],
                },
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "工具不可用"}],
                },
            ]
        )
        agent = Agent(model)
        list(agent.run("执行工具"))

        self.assertTrue(agent.context.messages[2]["is_error"])
        self.assertIn("未知工具", agent.context.messages[2]["content"])

    def test_budget_emits_usage_and_blocks_the_next_model_call(self) -> None:
        model = ScriptedModel(
            [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_call",
                            "id": "budget-call",
                            "name": "calculator",
                            "arguments": {
                                "operation": "add",
                                "left": 1,
                                "right": 2,
                            },
                        }
                    ],
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                },
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "3"}],
                    "usage": {"input_tokens": 20, "output_tokens": 1},
                },
            ]
        )
        agent = Agent(
            model,
            tools=[calculator_tool],
            budget=AgentBudget(max_total_tokens=15),
        )

        with self.assertRaises(BudgetExceededError):
            list(agent.run("1+2"))

        self.assertEqual(model.calls, 1)
        self.assertEqual(len(agent.context.messages), 3)

    def test_budget_uses_configurable_currency_and_prices(self) -> None:
        tracker = BudgetTracker(
            AgentBudget(
                max_cost=3,
                pricing=TokenPricing(
                    currency="CNY",
                    input_per_million=1,
                    output_per_million=2,
                    cache_read_per_million=0.1,
                    cache_write_per_million=1.25,
                ),
            )
        )

        totals = tracker.record(
            {
                "input_tokens": 1_000_000,
                "output_tokens": 500_000,
                "cache_read_input_tokens": 100_000,
                "cache_creation_input_tokens": 50_000,
            }
        )

        self.assertEqual(totals["total_tokens"], 1_650_000)
        self.assertAlmostEqual(totals["estimated_cost"], 2.0725)
        self.assertEqual(totals["currency"], "CNY")

    def test_rate_limiter_emits_wait_before_model_call(self) -> None:
        limiter = ModelRateLimiter(2, 1, clock=lambda: 0)
        limiter.reserve()
        model = ScriptedModel(
            [
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "ok"}],
                }
            ]
        )
        agent = Agent(model, rate_limiter=limiter)

        with patch("from_scratch_agent.agent.time.sleep") as sleep:
            events = list(agent.run("hello"))

        wait_event = next(
            event
            for event in events
            if event["type"] == "rate_limit_wait"
        )
        self.assertEqual(wait_event["delay_seconds"], 0.5)
        sleep.assert_called_once_with(0.5)

    def test_parallel_tools_overlap_but_keep_model_order(self) -> None:
        active_tools = 0
        maximum_active_tools = 0
        lock = Lock()

        def delayed_tool(name: str, delay: float) -> Tool:
            def execute(_arguments: dict[str, Any]) -> str:
                nonlocal active_tools, maximum_active_tools
                with lock:
                    active_tools += 1
                    maximum_active_tools = max(
                        maximum_active_tools, active_tools
                    )
                sleep(delay)
                with lock:
                    active_tools -= 1
                return f"{name}-result"

            return Tool(
                name=name,
                description=f"{name} test tool",
                input_schema={"type": "object"},
                execute=execute,
            )

        model = ScriptedModel(
            [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_call",
                            "id": "slow-call",
                            "name": "slow",
                            "arguments": {},
                        },
                        {
                            "type": "tool_call",
                            "id": "fast-call",
                            "name": "fast",
                            "arguments": {},
                        },
                    ],
                },
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "done"}],
                },
            ]
        )
        agent = Agent(
            model,
            tools=[delayed_tool("slow", 0.02), delayed_tool("fast", 0.001)],
            tool_execution="parallel",
        )

        events = list(agent.run("run both"))

        self.assertEqual(maximum_active_tools, 2)
        self.assertEqual(
            [
                event["call"]["name"]
                for event in events
                if event["type"] == "tool_end"
            ],
            ["slow", "fast"],
        )
        self.assertEqual(
            [message["tool_name"] for message in agent.context.messages[2:4]],
            ["slow", "fast"],
        )


if __name__ == "__main__":
    unittest.main()
