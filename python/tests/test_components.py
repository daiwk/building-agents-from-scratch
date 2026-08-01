"""Python 核心组件离线测试。"""

import tempfile
import unittest
from os import environ
from pathlib import Path
from unittest.mock import patch

from from_scratch_agent import (
    Agent,
    InMemoryConversationStore,
    JsonFileConversationStore,
    ModelCallPolicy,
    ModelTimeoutError,
    RetryableModelError,
    SkillCatalog,
    ToolRegistry,
    apply_skills_to_system_prompt,
    calculator_tool,
    create_builtin_tool_registry,
    create_agent_from_env,
    load_skills_from_directory,
)
from from_scratch_agent.reliability import call_with_policy
from from_scratch_agent.types import Message, Tool
from from_scratch_agent.validation import validate_tool_input


class ScriptedModel:
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


class ComponentTest(unittest.TestCase):
    def test_tool_registry_selects_explicit_tools(self) -> None:
        registry = create_builtin_tool_registry()
        self.assertEqual(
            [tool.name for tool in registry.select(["current_time"])],
            ["current_time"],
        )
        with self.assertRaisesRegex(ValueError, "未知工具"):
            registry.select(["shell"])
        with self.assertRaisesRegex(ValueError, "已注册"):
            ToolRegistry().register(calculator_tool).register(calculator_tool)

    def test_tool_validation_blocks_execution(self) -> None:
        errors = validate_tool_input(
            calculator_tool.input_schema,
            {"operation": "multiply", "left": "six", "right": 7},
        )
        self.assertEqual(errors, ["$.left must be number"])

        executed = False

        def execute(arguments: dict) -> str:
            nonlocal executed
            executed = True
            return str(arguments)

        model = ScriptedModel(
            [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_call",
                            "id": "invalid",
                            "name": "typed_tool",
                            "arguments": {"count": "three"},
                        }
                    ],
                },
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "参数错误"}],
                },
            ]
        )
        agent = Agent(
            model,
            tools=[
                Tool(
                    name="typed_tool",
                    description="typed",
                    input_schema={
                        "type": "object",
                        "properties": {"count": {"type": "number"}},
                        "required": ["count"],
                    },
                    execute=execute,
                )
            ],
        )
        list(agent.run("执行"))

        self.assertFalse(executed)
        self.assertTrue(agent.context.messages[2]["is_error"])

    def test_agent_loads_and_saves_memory(self) -> None:
        store = InMemoryConversationStore()
        store.save("lesson", [{"role": "user", "content": "旧消息"}])
        model = ScriptedModel(
            [
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "记得"}],
                }
            ]
        )
        agent = Agent(
            model,
            memory_store=store,
            session_id="lesson",
        )

        list(agent.run("新消息"))

        self.assertEqual(len(store.load("lesson")), 3)
        agent.reset()
        self.assertEqual(store.load("lesson"), [])

    def test_json_memory_survives_new_store_instance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "memory.json"
            JsonFileConversationStore(path).save(
                "python-1",
                [{"role": "user", "content": "持久化"}],
            )
            self.assertEqual(
                JsonFileConversationStore(path).load("python-1"),
                [{"role": "user", "content": "持久化"}],
            )

    def test_skill_loader_and_prompt_injection(self) -> None:
        skills = load_skills_from_directory("skills")
        selected = SkillCatalog().register_many(skills).select(["tool-first"])
        prompt = apply_skills_to_system_prompt("你是助手。", selected)

        self.assertIn('<skill name="tool-first">', prompt)
        self.assertIn("先检查可用工具", prompt)

    def test_retry_and_timeout(self) -> None:
        attempts = 0

        def flaky() -> str:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RetryableModelError("temporary")
            return "ok"

        self.assertEqual(
            call_with_policy(
                flaky,
                ModelCallPolicy(
                    timeout_seconds=1,
                    max_retries=1,
                    retry_delay_seconds=0,
                ),
            ),
            "ok",
        )
        self.assertEqual(attempts, 2)

        with self.assertRaises(ModelTimeoutError):
            call_with_policy(
                lambda: __import__("time").sleep(1),
                ModelCallPolicy(timeout_seconds=0.01),
            )

    def test_runtime_uses_shared_agent_environment_variables(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            memory_file = str(Path(directory) / "memory.json")
            with patch.dict(
                environ,
                {
                    "MINIMAX_API_KEY": "test-key",
                    "AGENT_TOOLS": "calculator",
                    "AGENT_MEMORY_FILE": memory_file,
                    "AGENT_SESSION_ID": "python-test",
                    "AGENT_SKILLS_DIR": "skills",
                    "AGENT_SKILLS": "tool-first",
                    "AGENT_MODEL_TIMEOUT_MS": "1000",
                    "AGENT_MODEL_MAX_RETRIES": "2",
                    "AGENT_RETRY_DELAY_MS": "0",
                    "AGENT_MAX_TOTAL_TOKENS": "1000",
                    "AGENT_RATE_LIMIT_MAX_REQUESTS": "60",
                    "AGENT_RATE_LIMIT_WINDOW_MS": "60000",
                },
                clear=True,
            ):
                agent = create_agent_from_env()

            self.assertEqual(
                [tool.name for tool in agent.context.tools],
                ["calculator"],
            )
            self.assertIn(
                '<skill name="tool-first">',
                agent.context.system_prompt,
            )
            self.assertEqual(agent.session_id, "python-test")
            self.assertIsNotNone(agent.memory_store)
            self.assertEqual(agent.budget.max_total_tokens, 1000)
            self.assertEqual(agent.rate_limiter.max_requests, 60)


if __name__ == "__main__":
    unittest.main()
