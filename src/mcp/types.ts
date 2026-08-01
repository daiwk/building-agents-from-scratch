import type { JsonSchema, JsonValue } from "../core/index.js";

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
};

export type McpRequestTransport = {
  request(
    method: string,
    params?: Record<string, JsonValue>,
    signal?: AbortSignal,
    requestId?: string | number,
  ): Promise<unknown>;
  notify?(method: string, params?: Record<string, JsonValue>): Promise<void> | void;
  close?(): Promise<void> | void;
};

export type McpClientOptions = {
  serverName: string;
  transport: McpRequestTransport;
  allowedTools: readonly string[];
  timeoutMs?: number;
  redactKeys?: readonly string[];
};
