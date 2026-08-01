import type {
  AssistantMessage,
  JsonValue,
  ModelProvider,
  ModelRequest,
} from "../core/index.js";

export type OutputSchema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, OutputSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: OutputSchema;
  enum?: readonly JsonValue[];
};

export type StructuredOutputResult<T extends JsonValue> = {
  value: T;
  message: AssistantMessage;
  repairAttempts: number;
};

export class StructuredOutputError extends Error {
  constructor(readonly validationErrors: readonly string[], readonly rawText: string) {
    super(`Structured output validation failed: ${validationErrors.join("; ")}`);
  }
}

/** JSON 必须由宿主 parse + validate；repair 有上限，而且 repair 后仍要再次校验。 */
export async function generateStructured<T extends JsonValue>(
  model: ModelProvider,
  request: ModelRequest,
  schema: OutputSchema,
  options: { maxRepairAttempts?: number; repairModel?: ModelProvider } = {},
): Promise<StructuredOutputResult<T>> {
  const maxRepairAttempts = nonNegativeInteger(options.maxRepairAttempts ?? 1);
  let message = await model.generate(withSchema(request, schema));
  let rawText = textOf(message);
  for (let attempt = 0; ; attempt += 1) {
    const parsed = parseAndValidate(rawText, schema);
    if (parsed.ok) return { value: parsed.value as T, message, repairAttempts: attempt };
    if (attempt >= maxRepairAttempts) throw new StructuredOutputError(parsed.errors, rawText);
    const repairModel = options.repairModel ?? model;
    message = await repairModel.generate({
      systemPrompt: [
        "Repair invalid JSON. Return JSON only; do not add Markdown.",
        `Schema: ${JSON.stringify(schema)}`,
      ].join("\n"),
      messages: [{
        role: "user",
        content: `Invalid output:\n${rawText}\nValidation errors:\n${parsed.errors.join("\n")}`,
      }],
      tools: [],
      ...(request.signal ? { signal: request.signal } : {}),
    });
    rawText = textOf(message);
  }
}

export function validateStructuredValue(
  value: unknown,
  schema: OutputSchema,
  path = "$",
): string[] {
  if (!matchesType(value, schema.type)) return [`${path} must be ${schema.type}`];
  if (schema.enum && !schema.enum.some((item) => deepEqual(item, value))) {
    return [`${path} must be one of ${JSON.stringify(schema.enum)}`];
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    return value.flatMap((item, index) => validateStructuredValue(item, schema.items!, `${path}[${index}]`));
  }
  if (schema.type !== "object" || !isObject(value)) return [];
  const errors: string[] = [];
  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    if (!(name in value)) errors.push(`${path}.${name} is required`);
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(value)) {
      if (!(name in properties)) errors.push(`${path}.${name} is not allowed`);
    }
  }
  for (const [name, childSchema] of Object.entries(properties)) {
    if (name in value) errors.push(...validateStructuredValue(value[name], childSchema, `${path}.${name}`));
  }
  return errors;
}

function withSchema(request: ModelRequest, schema: OutputSchema): ModelRequest {
  return {
    ...request,
    systemPrompt: [
      request.systemPrompt,
      "Return one JSON value matching this schema. Do not add Markdown.",
      JSON.stringify(schema),
    ].join("\n\n"),
  };
}

function parseAndValidate(
  text: string,
  schema: OutputSchema,
): { ok: true; value: JsonValue } | { ok: false; errors: string[] } {
  try {
    const value = JSON.parse(stripFence(text)) as unknown;
    const errors = validateStructuredValue(value, schema);
    return errors.length === 0
      ? { ok: true, value: value as JsonValue }
      : { ok: false, errors };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fence = String.fromCharCode(96).repeat(3);
  if (!trimmed.startsWith(fence) || !trimmed.endsWith(fence)) return trimmed;
  const body = trimmed.slice(fence.length, -fence.length).trim();
  return body.replace(/^json(?=\s|[\[{])/i, "").trim();
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function matchesType(value: unknown, type: OutputSchema["type"]): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nonNegativeInteger(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("maxRepairAttempts must be a non-negative integer.");
  }
  return value;
}
