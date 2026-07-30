"""MiniMax 国内 Token Plan provider，只使用 Python 标准库。"""

import json
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .types import Message, Tool


class MiniMaxProvider:
    """把内部消息翻译为 MiniMax Anthropic-compatible API。"""

    name = "minimax"

    def __init__(
        self,
        api_key: str,
        model: str = "MiniMax-M2.7",
        base_url: str = "https://api.minimaxi.com/anthropic/v1",
        max_tokens: int = 8192,
    ) -> None:
        if not api_key:
            raise ValueError("需要 MINIMAX_API_KEY")
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.max_tokens = max_tokens

    def generate(
        self,
        system_prompt: str,
        messages: list[Message],
        tools: list[Tool],
    ) -> Message:
        payload = {
            "model": self.model,
            "system": system_prompt,
            "messages": [_to_api_message(message) for message in messages],
            "tools": [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                }
                for tool in tools
            ],
            "max_tokens": self.max_tokens,
            "temperature": 1,
            "stream": False,
        }
        request = Request(
            f"{self.base_url}/messages",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Api-Key": self.api_key,
                "Anthropic-Version": "2023-06-01",
            },
            method="POST",
        )

        try:
            with urlopen(request, timeout=120) as response:  # noqa: S310
                body = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            details = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"MiniMax 请求失败：{error.code} {details}") from error

        blocks = [_to_core_block(block) for block in body.get("content", [])]
        if not blocks:
            raise RuntimeError("MiniMax 返回了空消息")
        return {
            "role": "assistant",
            "content": blocks,
            "stop_reason": body.get("stop_reason", "unknown"),
            "usage": body.get("usage", {}),
        }


def _to_api_message(message: Message) -> dict[str, Any]:
    if message["role"] == "user":
        return {"role": "user", "content": message["content"]}
    if message["role"] == "tool":
        return {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": message["tool_call_id"],
                    "content": message["content"],
                    "is_error": message["is_error"],
                }
            ],
        }

    content = []
    for block in message.get("content", []):
        if block["type"] == "text":
            content.append({"type": "text", "text": block["text"]})
        elif block["type"] == "tool_call":
            content.append(
                {
                    "type": "tool_use",
                    "id": block["id"],
                    "name": block["name"],
                    "input": block["arguments"],
                }
            )
    return {"role": "assistant", "content": content}


def _to_core_block(block: dict[str, Any]) -> Message:
    if block["type"] == "text":
        return {"type": "text", "text": block["text"]}
    if block["type"] == "thinking":
        return {"type": "thinking", "thinking": block.get("thinking", "")}
    return {
        "type": "tool_call",
        "id": block["id"],
        "name": block["name"],
        "arguments": block.get("input", {}),
    }
