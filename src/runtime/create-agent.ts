import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { Agent, type ModelProvider } from "../core/index.js";
import { CodexCliProvider, MiniMaxProvider } from "../providers/index.js";
import { calculatorTool, currentTimeTool } from "../tools/index.js";

// CLI 和 Web 共用这个“装配层”，避免两个界面各自创建一套 Agent。
export function loadLocalEnv(): void {
  if (existsSync(".env")) loadEnvFile(".env");
}

export function createAgentFromEnv(): Agent {
  const providerName = getProviderName();
  const model = createProvider(providerName);
  return new Agent({
    model,
    tools:
      providerName === "minimax" ? [calculatorTool, currentTimeTool] : [],
    systemPrompt:
      "你是一个简洁、可靠的助手。需要精确计算或当前时间时，必须使用工具。",
    modelCall: {
      timeoutMs: readNonNegativeNumber("AGENT_MODEL_TIMEOUT_MS", 120_000),
      maxRetries: readNonNegativeInteger("AGENT_MODEL_MAX_RETRIES", 1),
      retryDelayMs: readNonNegativeNumber("AGENT_RETRY_DELAY_MS", 500),
    },
  });
}

export function getProviderName(): string {
  // `??` 表示左边没有值（undefined/null）时才使用右边的默认值。
  return process.env.AGENT_PROVIDER ?? "minimax";
}

function createProvider(name: string): ModelProvider {
  // Provider 是可替换零件；新增模型后端时不需要修改 agent-loop.ts。
  if (name === "minimax") {
    return new MiniMaxProvider({
      apiKey: process.env.MINIMAX_API_KEY ?? "",
      model: process.env.MINIMAX_MODEL ?? "MiniMax-M2.7",
      baseUrl:
        process.env.MINIMAX_BASE_URL ??
        "https://api.minimaxi.com/anthropic/v1",
    });
  }
  if (name === "codex") {
    return new CodexCliProvider({
      cwd: process.cwd(),
      ...(process.env.AGENT_MODEL ? { model: process.env.AGENT_MODEL } : {}),
    });
  }
  throw new Error(`Unknown AGENT_PROVIDER: ${name}`);
}

function readNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = readNonNegativeNumber(name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}
