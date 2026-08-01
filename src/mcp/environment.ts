import { McpClient } from "./client.js";
import { StdioMcpTransport } from "./stdio-transport.js";

/** 环境变量只由宿主读取；模型永远不能修改 command、args 或白名单。 */
export function createMcpClientFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): McpClient | undefined {
  const command = environment.AGENT_MCP_COMMAND?.trim();
  if (!command) return undefined;
  const serverName = environment.AGENT_MCP_SERVER_NAME?.trim() || "mcp";
  const allowedTools = splitList(environment.AGENT_MCP_TOOLS);
  if (allowedTools.length === 0) {
    throw new Error("AGENT_MCP_TOOLS must explicitly allow at least one tool.");
  }
  return new McpClient({
    serverName,
    allowedTools,
    transport: new StdioMcpTransport(
      command,
      parseArgs(environment.AGENT_MCP_ARGS),
      environment.AGENT_MCP_CWD?.trim() || undefined,
    ),
    timeoutMs: readPositive(environment.AGENT_MCP_TIMEOUT_MS, 30_000),
  });
}

function parseArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("AGENT_MCP_ARGS must be a JSON string array.");
  }
  return parsed;
}

function splitList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function readPositive(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("AGENT_MCP_TIMEOUT_MS must be positive.");
  }
  return parsed;
}
