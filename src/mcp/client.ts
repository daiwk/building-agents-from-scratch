import { randomUUID } from "node:crypto";
import type { JsonValue, Tool } from "../core/index.js";
import { ToolRegistry } from "../tools/index.js";
import type { McpClientOptions, McpToolDefinition } from "./types.js";

const DEFAULT_SECRET_KEYS = [
  "authorization", "token", "api_key", "apikey", "password", "secret",
];

/**
 * MCP 只负责“发现并调用远端工具”，最终仍转换成项目已有的 Tool。
 * allowedTools 是宿主白名单：server 声称拥有某个工具，不代表 Agent 自动获得权限。
 */
export class McpClient {
  private initialized = false;
  private readonly timeoutMs: number;
  private readonly allowedTools: Set<string>;
  private readonly redactKeys: Set<string>;

  constructor(private readonly options: McpClientOptions) {
    if (!options.serverName.trim()) throw new Error("MCP serverName is required.");
    this.timeoutMs = positive(options.timeoutMs ?? 30_000, "timeoutMs");
    this.allowedTools = new Set(options.allowedTools);
    this.redactKeys = new Set(
      [...DEFAULT_SECRET_KEYS, ...(options.redactKeys ?? [])].map((key) => key.toLowerCase()),
    );
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    await this.initialize(signal);
    const result = await this.call("tools/list", {}, signal);
    const tools = asRecord(result).tools;
    if (!Array.isArray(tools)) throw new Error("MCP tools/list must return a tools array.");
    return tools.map(parseTool).filter((tool) => this.allowedTools.has(tool.name));
  }

  async createRegistry(signal?: AbortSignal): Promise<ToolRegistry> {
    const definitions = await this.listTools(signal);
    return new ToolRegistry().registerMany(definitions.map((definition) => this.asTool(definition)));
  }

  async close(): Promise<void> {
    await this.options.transport.close?.();
  }

  private asTool(definition: McpToolDefinition): Tool {
    return {
      name: `${this.options.serverName}__${definition.name}`,
      description: definition.description ?? `MCP tool ${definition.name}`,
      inputSchema: definition.inputSchema,
      execute: async (input, context) => {
        try {
          const result = await this.call(
            "tools/call",
            { name: definition.name, arguments: input },
            context.signal,
          );
          return JSON.stringify(redactSecrets(result, this.redactKeys));
        } catch (error) {
          throw new Error(redactError(error, this.redactKeys), { cause: error });
        }
      },
    };
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "building-agents-from-scratch", version: "0.1.0" },
    }, signal);
    await this.options.transport.notify?.("notifications/initialized");
    this.initialized = true;
  }

  private async call(
    method: string,
    params: Record<string, JsonValue>,
    parentSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const requestId = randomUUID();
    const abort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(
      new Error(`MCP ${method} timed out after ${this.timeoutMs} ms.`),
    ), this.timeoutMs);
    try {
      return await this.options.transport.request(
        method,
        params,
        controller.signal,
        requestId,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        await this.options.transport.notify?.("notifications/cancelled", {
          requestId,
          reason: "cancelled or timed out",
        });
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error(`MCP ${method} cancelled.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    }
  }
}

function parseTool(value: unknown): McpToolDefinition {
  const tool = asRecord(value);
  if (typeof tool.name !== "string" || !tool.name.trim()) {
    throw new Error("MCP tool name must be a non-empty string.");
  }
  const inputSchema = asRecord(tool.inputSchema);
  if (inputSchema.type !== "object") {
    throw new Error(`MCP tool ${tool.name} must use an object inputSchema.`);
  }
  return {
    name: tool.name,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    inputSchema: inputSchema as McpToolDefinition["inputSchema"],
  };
}

function asRecord(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP response must be a JSON object.");
  }
  return value as Record<string, JsonValue>;
}

export function redactSecrets(value: unknown, secretKeys = new Set(DEFAULT_SECRET_KEYS)): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secretKeys));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    secretKeys.has(key.toLowerCase()) ? "[REDACTED]" : redactSecrets(item, secretKeys),
  ]));
}

function redactError(error: unknown, secretKeys: Set<string>): string {
  const text = error instanceof Error ? error.message : String(error);
  let safe = text;
  for (const key of secretKeys) {
    safe = safe.replace(new RegExp(`(${escapeRegex(key)}\\s*[=:]\\s*)[^\\s,;]+`, "gi"), "$1[REDACTED]");
  }
  return safe;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}
