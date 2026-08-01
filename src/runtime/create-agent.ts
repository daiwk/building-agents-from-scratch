import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import {
  Agent,
  RecentContextBuilder,
  createBudgetFromEnvironment,
  createRateLimiterFromEnvironment,
  createTracerFromEnvironment,
  type AgentHooks,
  type ConversationStore,
  type ContextBuilder,
  type ModelProvider,
  type Tool,
  type ToolExecutionMode,
} from "../core/index.js";
import {
  JsonFileConversationStore,
  MemoryRecallContextBuilder,
  SqliteMemoryIndex,
  SqliteConversationStore,
} from "../memory/index.js";
import { CodexCliProvider, MiniMaxProvider } from "../providers/index.js";
import {
  SkillCatalog,
  applySkillsToSystemPrompt,
  assertSkillToolsAvailable,
  createDynamicSkillHook,
  loadSkillsFromDirectory,
} from "../skills/index.js";
import { createBuiltinToolRegistry } from "../tools/index.js";
import { createWorkspaceToolKit } from "../workspace/index.js";
import { createMcpClientFromEnvironment } from "../mcp/index.js";

// 同一个后端文件只创建一个 store 实例，供 CLI/Web 的多个会话复用连接或写入队列。
const memoryStores = new Map<string, ConversationStore>();
const memoryIndexes = new Map<string, SqliteMemoryIndex>();
const mcpClients = new Set<NonNullable<ReturnType<typeof createMcpClientFromEnvironment>>>();

// CLI 和 Web 共用这个“装配层”，避免两个界面各自创建一套 Agent。
export function loadLocalEnv(): void {
  if (existsSync(".env")) loadEnvFile(".env");
}

export function createAgentFromEnv(sessionId = "default"): Agent {
  return createAgentWithExtraTools(sessionId, []);
}

/** MCP 需要先异步 discovery；CLI/pi-agent 使用这个入口，普通同步装配保持不变。 */
export async function createAgentFromEnvAsync(sessionId = "default"): Promise<Agent> {
  const client = createMcpClientFromEnvironment();
  if (!client) return createAgentWithExtraTools(sessionId, []);
  try {
    const tools = (await client.createRegistry()).list();
    mcpClients.add(client);
    return createAgentWithExtraTools(sessionId, tools);
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function closeRuntimeResources(): Promise<void> {
  await Promise.all([...mcpClients].map((client) => client.close()));
  mcpClients.clear();
}

function createAgentWithExtraTools(sessionId: string, extraTools: readonly Tool[]): Agent {
  const providerName = getProviderName();
  const model = createProvider(providerName);
  const toolRegistry = createBuiltinToolRegistry();
  toolRegistry.registerMany(extraTools);
  const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT?.trim();
  if (workspaceRoot) {
    toolRegistry.registerMany(createWorkspaceToolKit({
      root: workspaceRoot,
      allowWrite: readBoolean("AGENT_WORKSPACE_ALLOW_WRITE", false),
    }).registry.list());
  }
  // Codex CLI 适配器本身已经是 Agent，当前不能接收这里注册的工具。
  const selectedToolNames =
    providerName === "minimax"
      ? readList("AGENT_TOOLS", ["calculator", "current_time"])
      : [];
  const basePrompt =
    "你是一个简洁、可靠的助手。需要精确计算或当前时间时，必须使用工具。";
  const skillConfiguration = configureSkills(basePrompt, selectedToolNames);
  const memoryFile = process.env.AGENT_MEMORY_FILE?.trim();
  const memoryDatabase = process.env.AGENT_MEMORY_DATABASE?.trim();
  if (memoryFile && memoryDatabase) {
    throw new Error(
      "Set only one of AGENT_MEMORY_FILE or AGENT_MEMORY_DATABASE.",
    );
  }
  const recentContextBuilder = createContextBuilderFromEnv();
  const memoryIndexFile = process.env.AGENT_MEMORY_INDEX_DATABASE?.trim();
  const contextBuilder = memoryIndexFile
    ? new MemoryRecallContextBuilder(
        getMemoryIndex(memoryIndexFile),
        recentContextBuilder,
        { limit: readPositiveInteger("AGENT_MEMORY_RECALL_LIMIT", 5) },
      )
    : recentContextBuilder;
  const budget = createBudgetFromEnvironment();
  const rateLimiter = createRateLimiterFromEnvironment();
  const tracer = createTracerFromEnvironment(process.env, (error) => {
    console.error(
      "trace export failed:",
      error instanceof Error ? error.message : String(error),
    );
  });
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
    ...(rateLimiter ? { rateLimiter } : {}),
    toolExecution: readToolExecutionMode(),
    ...(tracer ? { tracer } : {}),
    modelCall: {
      timeoutMs: readNonNegativeNumber("AGENT_MODEL_TIMEOUT_MS", 120_000),
      maxRetries: readNonNegativeInteger("AGENT_MODEL_MAX_RETRIES", 1),
      retryDelayMs: readNonNegativeNumber("AGENT_RETRY_DELAY_MS", 500),
    },
    ...(memoryFile || memoryDatabase
      ? {
          memory: {
            sessionId,
            store: getMemoryStore(
              memoryDatabase ?? memoryFile ?? "",
              memoryDatabase ? "sqlite" : "json",
            ),
          },
        }
      : {}),
  });
}

function getMemoryIndex(filePath: string): SqliteMemoryIndex {
  const absolutePath = resolve(filePath);
  let index = memoryIndexes.get(absolutePath);
  if (!index) {
    index = new SqliteMemoryIndex(absolutePath);
    memoryIndexes.set(absolutePath, index);
  }
  return index;
}

export function getProviderName(): string {
  // `??` 表示左边没有值（undefined/null）时才使用右边的默认值。
  return process.env.AGENT_PROVIDER ?? "minimax";
}

function readToolExecutionMode(): ToolExecutionMode {
  const value = process.env.AGENT_TOOL_EXECUTION?.trim() || "sequential";
  if (value !== "sequential" && value !== "parallel") {
    throw new Error(
      "AGENT_TOOL_EXECUTION must be sequential or parallel.",
    );
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false.`);
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

function configureSkills(basePrompt: string, allowedToolNames: string[]): {
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
      hooks: createDynamicSkillHook({ basePrompt, catalog, allowedToolNames }),
    };
  }
  const selected = catalog.select(selectedNames);
  assertSkillToolsAvailable(selected, allowedToolNames);
  return {
    systemPrompt: applySkillsToSystemPrompt(
      basePrompt,
      selected,
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

function getMemoryStore(
  filePath: string,
  backend: "json" | "sqlite",
): ConversationStore {
  const absolutePath = resolve(filePath);
  const key = `${backend}:${absolutePath}`;
  let store = memoryStores.get(key);
  if (!store) {
    store = backend === "sqlite"
      ? new SqliteConversationStore(absolutePath)
      : new JsonFileConversationStore(absolutePath);
    memoryStores.set(key, store);
  }
  return store;
}
