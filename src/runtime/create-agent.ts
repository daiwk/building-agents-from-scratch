import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import {
  Agent,
  RecentContextBuilder,
  createBudgetFromEnvironment,
  type AgentHooks,
  type ContextBuilder,
  type ModelProvider,
} from "../core/index.js";
import { JsonFileConversationStore } from "../memory/index.js";
import { CodexCliProvider, MiniMaxProvider } from "../providers/index.js";
import {
  SkillCatalog,
  applySkillsToSystemPrompt,
  createDynamicSkillHook,
  loadSkillsFromDirectory,
} from "../skills/index.js";
import { createBuiltinToolRegistry } from "../tools/index.js";

// 同一个文件只创建一个 store 实例，保证 Web 多会话写入经过同一条队列。
const memoryStores = new Map<string, JsonFileConversationStore>();

// CLI 和 Web 共用这个“装配层”，避免两个界面各自创建一套 Agent。
export function loadLocalEnv(): void {
  if (existsSync(".env")) loadEnvFile(".env");
}

export function createAgentFromEnv(sessionId = "default"): Agent {
  const providerName = getProviderName();
  const model = createProvider(providerName);
  const toolRegistry = createBuiltinToolRegistry();
  // Codex CLI 适配器本身已经是 Agent，当前不能接收这里注册的工具。
  const selectedToolNames =
    providerName === "minimax"
      ? readList("AGENT_TOOLS", ["calculator", "current_time"])
      : [];
  const basePrompt =
    "你是一个简洁、可靠的助手。需要精确计算或当前时间时，必须使用工具。";
  const skillConfiguration = configureSkills(basePrompt);
  const memoryFile = process.env.AGENT_MEMORY_FILE?.trim();
  const contextBuilder = createContextBuilderFromEnv();
  const budget = createBudgetFromEnvironment();
  if (budget && providerName !== "minimax") {
    throw new Error(
      `AGENT_* budget requires a provider with token usage; ${providerName} does not report it.`,
    );
  }

  return new Agent({
    model,
    tools: toolRegistry.select(selectedToolNames),
    systemPrompt: skillConfiguration.systemPrompt,
    ...(skillConfiguration.hooks
      ? { hooks: skillConfiguration.hooks }
      : {}),
    ...(contextBuilder ? { contextBuilder } : {}),
    ...(budget ? { budget } : {}),
    modelCall: {
      timeoutMs: readNonNegativeNumber("AGENT_MODEL_TIMEOUT_MS", 120_000),
      maxRetries: readNonNegativeInteger("AGENT_MODEL_MAX_RETRIES", 1),
      retryDelayMs: readNonNegativeNumber("AGENT_RETRY_DELAY_MS", 500),
    },
    ...(memoryFile
      ? {
          memory: {
            sessionId,
            store: getMemoryStore(memoryFile),
          },
        }
      : {}),
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

function readList(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function configureSkills(basePrompt: string): {
  systemPrompt: string;
  hooks?: AgentHooks;
} {
  const selectedNames = readList("AGENT_SKILLS");
  if (selectedNames.length === 0) return { systemPrompt: basePrompt };

  const directory = process.env.AGENT_SKILLS_DIR?.trim() || "skills";
  const catalog = new SkillCatalog().registerMany(
    loadSkillsFromDirectory(directory),
  );
  if (selectedNames.includes("auto")) {
    if (selectedNames.length !== 1) {
      throw new Error("AGENT_SKILLS=auto cannot be combined with skill names.");
    }
    return {
      systemPrompt: basePrompt,
      hooks: createDynamicSkillHook({ basePrompt, catalog }),
    };
  }
  return {
    systemPrompt: applySkillsToSystemPrompt(
      basePrompt,
      catalog.select(selectedNames),
    ),
  };
}

function createContextBuilderFromEnv(): ContextBuilder | undefined {
  const maxMessages = process.env.AGENT_CONTEXT_MAX_MESSAGES;
  const maxCharacters = process.env.AGENT_CONTEXT_MAX_CHARACTERS;
  if (maxMessages === undefined && maxCharacters === undefined) {
    return undefined;
  }
  return new RecentContextBuilder({
    maxMessages: readPositiveInteger(
      "AGENT_CONTEXT_MAX_MESSAGES",
      40,
    ),
    maxCharacters: readPositiveInteger(
      "AGENT_CONTEXT_MAX_CHARACTERS",
      50_000,
    ),
  });
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function getMemoryStore(filePath: string): JsonFileConversationStore {
  const absolutePath = resolve(filePath);
  let store = memoryStores.get(absolutePath);
  if (!store) {
    store = new JsonFileConversationStore(absolutePath);
    memoryStores.set(absolutePath, store);
  }
  return store;
}
