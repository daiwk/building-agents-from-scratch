import type { JsonSchema, JsonValue } from "./types.js";

/**
 * 校验模型生成的工具参数。
 *
 * 为什么 Agent 必须做这一步：
 * JSON Schema 会告诉模型“应该”怎样传参，但模型输出仍然是不可信的外部输入。
 * 宿主程序必须在执行工具前再次校验，不能把 prompt 当作安全边界。
 *
 * 教学版只实现当前工具需要的 JSON Schema 子集：
 * required、additionalProperties、type 和 enum。生产项目可以换成 Ajv 等完整实现。
 */
export function validateToolInput(
  schema: JsonSchema,
  input: Record<string, JsonValue>,
): string[] {
  const errors: string[] = [];
  const properties = schema.properties ?? {};

  for (const requiredName of schema.required ?? []) {
    if (!(requiredName in input)) {
      errors.push(`$.${requiredName} is required`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const name of Object.keys(input)) {
      if (!(name in properties)) {
        errors.push(`$.${name} is not allowed`);
      }
    }
  }

  for (const [name, value] of Object.entries(input)) {
    const propertySchema = properties[name];
    if (!isObject(propertySchema)) continue;

    const expectedType = propertySchema.type;
    if (
      typeof expectedType === "string" &&
      !matchesJsonType(value, expectedType)
    ) {
      errors.push(`$.${name} must be ${expectedType}`);
      continue;
    }

    const allowedValues = propertySchema.enum;
    if (
      Array.isArray(allowedValues) &&
      !allowedValues.some((allowed) => Object.is(allowed, value))
    ) {
      errors.push(
        `$.${name} must be one of: ${allowedValues
          .map((allowed) => JSON.stringify(allowed))
          .join(", ")}`,
      );
    }
  }

  return errors;
}

function isObject(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesJsonType(value: JsonValue, expected: string): boolean {
  if (expected === "string") return typeof value === "string";
  if (expected === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return isObject(value);
  if (expected === "null") return value === null;
  // 不认识的 Schema 关键字不能假装已验证。
  return false;
}
