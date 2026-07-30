"""执行工具前校验模型生成的参数。"""

from typing import Any


def validate_tool_input(
    schema: dict[str, Any],
    arguments: dict[str, Any],
) -> list[str]:
    """校验教学工具使用的 JSON Schema 子集。"""

    errors: list[str] = []
    properties = schema.get("properties", {})
    if not isinstance(properties, dict):
        properties = {}

    for name in schema.get("required", []):
        if name not in arguments:
            errors.append(f"$.{name} is required")

    if schema.get("additionalProperties") is False:
        for name in arguments:
            if name not in properties:
                errors.append(f"$.{name} is not allowed")

    for name, value in arguments.items():
        property_schema = properties.get(name)
        if not isinstance(property_schema, dict):
            continue
        expected_type = property_schema.get("type")
        if isinstance(expected_type, str) and not _matches_type(
            value, expected_type
        ):
            errors.append(f"$.{name} must be {expected_type}")
            continue
        allowed = property_schema.get("enum")
        if isinstance(allowed, list) and value not in allowed:
            rendered = ", ".join(repr(item) for item in allowed)
            errors.append(f"$.{name} must be one of: {rendered}")

    return errors


def _matches_type(value: Any, expected: str) -> bool:
    # bool 是 int 的子类，所以数字判断必须显式排除 bool。
    if expected == "string":
        return isinstance(value, str)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "array":
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    if expected == "null":
        return value is None
    return False
