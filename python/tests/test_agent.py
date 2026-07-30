"""Python 版离线测试，不访问真实 MiniMax。"""

import unittest
from typing import Any

from from_scratch_agent import Agent, calculator_tool
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


if __name__ == "__main__":
    unittest.main()
