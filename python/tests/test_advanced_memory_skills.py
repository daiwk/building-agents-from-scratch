"""Stage 2/3 组件测试，不调用真实模型。"""

import tempfile
import unittest
from pathlib import Path

from from_scratch_agent import (
    Agent,
    ExtractiveSummaryProvider,
    InMemoryMemoryIndex,
    MemoryRecord,
    SkillCatalog,
    SqliteMemoryIndex,
    TokenContextBuilder,
)
from from_scratch_agent.skills import parse_skill_markdown
from from_scratch_agent.types import Message, Tool


class CharacterCounter:
    def count(self, text: str) -> int:
        return len(text)


class CaptureModel:
    name = "capture"

    def __init__(self) -> None:
        self.messages: list[Message] = []
        self.system_prompt = ""

    def generate(self, system_prompt: str, messages: list[Message], tools: list[Tool]) -> Message:
        del tools
        self.system_prompt = system_prompt
        self.messages = messages
        return {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}


class AdvancedMemorySkillTest(unittest.TestCase):
    def test_agent_uses_token_context_and_summary_without_deleting_history(self) -> None:
        model = CaptureModel()
        agent = Agent(
            model,
            context_builder=TokenContextBuilder(
                max_tokens=120,
                token_counter=CharacterCounter(),
                summarizer=ExtractiveSummaryProvider(),
            ),
        )
        agent.context.messages.extend([
            {"role": "user", "content": "很久以前的问题"},
            {"role": "assistant", "content": [{"type": "text", "text": "旧回答"}]},
        ])

        list(agent.run("新问题"))

        self.assertEqual(model.messages, [{"role": "user", "content": "新问题"}])
        self.assertIn("conversation_summary", model.system_prompt)
        self.assertEqual(len(agent.context.messages), 4)

    def test_memory_kinds_persist_and_filter(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "index.sqlite3"
            index = SqliteMemoryIndex(path)
            index.upsert(MemoryRecord("fact", "semantic", "用户喜欢蓝色"))
            index.upsert(MemoryRecord("event", "episodic", "昨天讨论红色"))
            restarted = SqliteMemoryIndex(path)
            self.assertEqual(
                restarted.search("喜欢什么颜色", kinds=["semantic"])[0].id,
                "fact",
            )
            restarted.remove("fact")
            self.assertEqual(restarted.search("蓝"), [])

        memory = InMemoryMemoryIndex()
        memory.upsert(MemoryRecord("rule", "procedural", "回答必须简洁"))
        self.assertEqual(memory.search("回答简洁")[0].kind, "procedural")

    def test_skill_version_dependencies_and_bm25_discovery(self) -> None:
        base = parse_skill_markdown(
            "---\nname: base\ndescription: 基础格式\nversion: 1.2.0\n---\n基础规则。",
            "virtual/base/SKILL.md",
        )
        child = parse_skill_markdown(
            "---\nname: child\ndescription: 专业分析\ndependencies: base\ntags: 分析, research\ntools: calculator\n---\n执行分析。",
            "virtual/child/SKILL.md",
        )
        catalog = SkillCatalog().register_many([base, child])
        self.assertEqual([item.name for item in catalog.select(["child"])], ["base", "child"])
        self.assertEqual(catalog.discover("请做专业分析", 1)[0].name, "child")
        self.assertEqual(base.version, "1.2.0")
        self.assertEqual(child.required_tools, ["calculator"])


if __name__ == "__main__":
    unittest.main()
