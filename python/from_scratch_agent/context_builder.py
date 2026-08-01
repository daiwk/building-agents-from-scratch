"""ContextBuilder：按完整轮次裁剪，并可摘要旧历史。"""

import json
from html import escape
from dataclasses import dataclass
from typing import Protocol

from .types import AgentContext, Message
from .memory_index import MemoryIndex, MemoryKind


class TokenCounter(Protocol):
    def count(self, text: str) -> int: ...


class SummaryProvider(Protocol):
    def summarize(self, messages: list[Message]) -> str: ...


class ContextBuilder(Protocol):
    def build(self, context: AgentContext) -> AgentContext: ...


@dataclass
class TokenContextBuilder:
    """使用注入的 provider tokenizer 计算预算，不猜测模型切词规则。"""

    max_tokens: int
    token_counter: TokenCounter
    summarizer: SummaryProvider | None = None

    def build(self, context: AgentContext) -> AgentContext:
        if self.max_tokens <= 0:
            raise ValueError("max_tokens 必须为正整数")
        turns = _group_turns(context.messages)
        selected: list[list[Message]] = []
        tool_payload = [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
            }
            for tool in context.tools
        ]
        used = self.token_counter.count(context.system_prompt) + self.token_counter.count(
            json.dumps(tool_payload, ensure_ascii=False, separators=(",", ":"))
        )
        for turn in reversed(turns):
            cost = self.token_counter.count(
                json.dumps(turn, ensure_ascii=False, separators=(",", ":"))
            )
            if selected and used + cost > self.max_tokens:
                break
            selected.insert(0, turn)
            used += cost
        kept = sum(len(turn) for turn in selected)
        omitted = context.messages[: len(context.messages) - kept]
        raw_summary = (
            self.summarizer.summarize(omitted).strip()
            if omitted and self.summarizer
            else ""
        )
        wrapper = "\n\n<conversation_summary>\n\n</conversation_summary>"
        summary_budget = max(
            0,
            self.max_tokens - used - self.token_counter.count(wrapper),
        )
        summary = _fit_text(raw_summary, summary_budget, self.token_counter)
        prompt = context.system_prompt
        if summary:
            prompt += f"\n\n<conversation_summary>\n{summary}\n</conversation_summary>"
        return AgentContext(
            system_prompt=prompt,
            messages=[message for turn in selected for message in turn],
            tools=context.tools,
        )


@dataclass
class ExtractiveSummaryProvider:
    max_characters: int = 2000

    def summarize(self, messages: list[Message]) -> str:
        lines = []
        for message in messages:
            role = message.get("role", "unknown")
            content = message.get("content", "")
            if isinstance(content, list):
                content = " ".join(
                    str(block.get("text", ""))
                    for block in content
                    if isinstance(block, dict) and block.get("type") == "text"
                )
            lines.append(f"{role}: {content}")
        return "\n".join(lines)[-self.max_characters :]


@dataclass
class MemoryRecallContextBuilder:
    index: MemoryIndex
    delegate: ContextBuilder | None = None
    limit: int = 5
    kinds: list[MemoryKind] | None = None

    def build(self, context: AgentContext) -> AgentContext:
        built = self.delegate.build(context) if self.delegate else AgentContext(
            context.system_prompt, list(context.messages), context.tools
        )
        query = next(
            (str(message.get("content", "")) for message in reversed(context.messages)
             if message.get("role") == "user"),
            "",
        )
        memories = self.index.search(query, self.limit, self.kinds) if query else []
        if memories:
            section = "\n".join(
                f'<memory kind="{item.kind}" id="{escape(item.id)}">'
                f'{escape(item.content)}</memory>'
                for item in memories
            )
            built.system_prompt += f"\n\n# Relevant memories\n\n{section}"
        return built


def _group_turns(messages: list[Message]) -> list[list[Message]]:
    turns: list[list[Message]] = []
    for message in messages:
        if message.get("role") == "user" or not turns:
            turns.append([])
        turns[-1].append(message)
    return turns


def _fit_text(text: str, max_tokens: int, counter: TokenCounter) -> str:
    if not text or max_tokens <= 0:
        return ""
    low, high = 0, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if counter.count(text[:middle]) <= max_tokens:
            low = middle
        else:
            high = middle - 1
    return text[:low]
