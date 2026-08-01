"""结构化输出：parse、递归校验，以及次数受限的 repair。"""

from __future__ import annotations
import json
from dataclasses import dataclass
from typing import Any
from .types import ModelProvider


@dataclass
class StructuredOutputResult:
    value: Any
    message: dict[str, Any]
    repair_attempts: int


class StructuredOutputError(ValueError):
    def __init__(self, errors: list[str], raw_text: str) -> None:
        super().__init__("Structured output 校验失败：" + "; ".join(errors))
        self.errors = errors
        self.raw_text = raw_text


def generate_structured(model: ModelProvider, system_prompt: str,
                        messages: list[dict], schema: dict,
                        max_repair_attempts: int = 1,
                        repair_model: ModelProvider | None = None
                        ) -> StructuredOutputResult:
    if max_repair_attempts < 0:
        raise ValueError("max_repair_attempts 不能为负数")
    message = model.generate(
        system_prompt + "\n\nReturn JSON only matching schema:\n"
        + json.dumps(schema, ensure_ascii=False), messages, [],
    )
    raw = _message_text(message)
    for attempt in range(max_repair_attempts + 1):
        try:
            value = json.loads(_strip_fence(raw))
            errors = validate_structured_value(value, schema)
        except (ValueError, TypeError) as error:
            value, errors = None, [str(error)]
        if not errors:
            return StructuredOutputResult(value, message, attempt)
        if attempt >= max_repair_attempts:
            raise StructuredOutputError(errors, raw)
        fixer = repair_model or model
        message = fixer.generate(
            "Repair invalid JSON. Return JSON only.\nSchema: "
            + json.dumps(schema, ensure_ascii=False),
            [{"role": "user", "content": raw + "\nErrors:\n" + "\n".join(errors)}],
            [],
        )
        raw = _message_text(message)
    raise AssertionError("unreachable")


def validate_structured_value(value: Any, schema: dict, path: str = "$") -> list[str]:
    expected = schema.get("type")
    if not _matches_type(value, expected):
        return [f"{path} must be {expected}"]
    if "enum" in schema and value not in schema["enum"]:
        return [f"{path} must be one of {schema['enum']!r}"]
    if expected == "array" and isinstance(value, list) and "items" in schema:
        return [
            error for index, item in enumerate(value)
            for error in validate_structured_value(item, schema["items"], f"{path}[{index}]")
        ]
    if expected != "object" or not isinstance(value, dict):
        return []
    errors: list[str] = []
    properties = schema.get("properties", {})
    for name in schema.get("required", []):
        if name not in value:
            errors.append(f"{path}.{name} is required")
    if schema.get("additionalProperties") is False:
        errors.extend(f"{path}.{name} is not allowed" for name in value if name not in properties)
    for name, child_schema in properties.items():
        if name in value:
            errors.extend(validate_structured_value(
                value[name], child_schema, f"{path}.{name}"
            ))
    return errors


def _message_text(message: dict) -> str:
    return "\n".join(
        block.get("text", "") for block in message.get("content", [])
        if block.get("type") == "text"
    ).strip()


def _strip_fence(text: str) -> str:
    stripped = text.strip()
    fence = chr(96) * 3
    if stripped.startswith(fence) and stripped.endswith(fence):
        body = stripped[len(fence):-len(fence)].strip()
        if body.lower().startswith("json"):
            body = body[4:].strip()
        return body
    return stripped


def _matches_type(value: Any, expected: str) -> bool:
    if expected == "null":
        return value is None
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "string":
        return isinstance(value, str)
    if expected == "array":
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    return False
