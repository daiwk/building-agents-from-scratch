/**
 * 直接使用成熟的 pi-agent API 实现同一个计算 Agent。
 *
 * 对照阅读：
 * - from scratch：src/core/agent-loop.ts（我们自己写循环）
 * - pi-agent：本文件（循环、参数校验、流式事件由库提供）
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import {
  Agent as PiAgent,
  type AgentMessage as PiAgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { createModels, Type } from "@earendil-works/pi-ai";
import { minimaxCnProvider } from "@earendil-works/pi-ai/providers/minimax-cn";
import { JsonFileConversationStore } from "../src/memory/index.js";
import {
  BudgetExceededError,
  BudgetTracker,
  createBudgetFromEnvironment,
  createRateLimiterFromEnvironment,
  waitForRateLimit,
} from "../src/core/index.js";
import {
  SkillCatalog,
  applySkillsToSystemPrompt,
  loadSkillsFromDirectory,
} from "../src/skills/index.js";

if (existsSync(".env")) loadEnvFile(".env");

// Type.Object 同时生成运行时 JSON Schema 和 TypeScript 类型。
const calculatorParameters = Type.Object({
  operation: Type.Union([
    Type.Literal("add"),
    Type.Literal("subtract"),
    Type.Literal("multiply"),
    Type.Literal("divide"),
  ]),
  left: Type.Number(),
  right: Type.Number(),
});

// pi-agent 的工具返回 content（给模型）和 details（给日志/UI）。
const calculatorTool: AgentTool<
  typeof calculatorParameters,
  { operation: string }
> = {
  name: "calculator",
  label: "Calculator",
  description: "对两个数字执行一次精确的四则运算。",
  parameters: calculatorParameters,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    let value: number;
    if (params.operation === "add") value = params.left + params.right;
    else if (params.operation === "subtract") value = params.left - params.right;
    else if (params.operation === "multiply") value = params.left * params.right;
    else {
      if (params.right === 0) throw new Error("不能除以 0");
      value = params.left / params.right;
    }
    return {
      content: [{ type: "text", text: String(value) }],
      details: { operation: params.operation },
    };
  },
};

const currentTimeParameters = Type.Object({
  timeZone: Type.String({
    description: "IANA time zone，例如 Asia/Shanghai",
  }),
});

const currentTimeTool: AgentTool<
  typeof currentTimeParameters,
  { timeZone: string }
> = {
  name: "current_time",
  label: "Current time",
  description: "获取指定 IANA 时区的当前时间。",
  parameters: currentTimeParameters,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    const text = new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: params.timeZone,
    }).format(new Date());
    return {
      content: [{ type: "text", text }],
      details: { timeZone: params.timeZone },
    };
  },
};

type AnyPiTool = AgentTool<any, any>;

class PiToolRegistry {
  private readonly tools = new Map<string, AnyPiTool>();

  register(tool: AnyPiTool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`pi-agent tool 已注册：${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  select(names: readonly string[]): AnyPiTool[] {
    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`未知 pi-agent tool：${name}`);
      return tool;
    });
  }
}

/**
 * 直接使用 pi-agent，但复用项目的 memory/skill 文件格式与环境变量语义。
 */
export async function createPiAgent(): Promise<PiAgent> {
  // pi-ai 已内置 MiniMax 国内 provider：
  // baseUrl=https://api.minimaxi.com/anthropic
  // 默认读取 MINIMAX_CN_API_KEY。
  if (!process.env.MINIMAX_CN_API_KEY && process.env.MINIMAX_API_KEY) {
    process.env.MINIMAX_CN_API_KEY = process.env.MINIMAX_API_KEY;
  }

  const models = createModels();
  models.setProvider(minimaxCnProvider());
  const modelId = process.env.MINIMAX_MODEL ?? "MiniMax-M2.7";
  const model = models.getModel("minimax-cn", modelId);
  if (!model) {
    throw new Error(
      `pi-ai 的 minimax-cn provider 中找不到模型：${modelId}`,
    );
  }

  const toolRegistry = new PiToolRegistry()
    .register(calculatorTool)
    .register(currentTimeTool);
  const selectedTools = toolRegistry.select(
    readList("PI_AGENT_TOOLS", readList("AGENT_TOOLS", [
      "calculator",
      "current_time",
    ])),
  );
  const selectedSkills = loadSelectedPiSkills();
  const sessionId =
    process.env.PI_AGENT_SESSION_ID ??
    process.env.AGENT_SESSION_ID ??
    "pi-cli";
  const memoryFile =
    process.env.PI_AGENT_MEMORY_FILE ?? process.env.AGENT_MEMORY_FILE;
  const memoryStore = memoryFile
    ? new JsonFileConversationStore<PiAgentMessage>(memoryFile)
    : undefined;
  const savedMessages = memoryStore
    ? await memoryStore.load(sessionId)
    : [];
  const timeoutMs = readNonNegativeNumber(
    "AGENT_MODEL_TIMEOUT_MS",
    120_000,
  );
  const maxRetries = readNonNegativeInteger(
    "AGENT_MODEL_MAX_RETRIES",
    1,
  );
  const maxRetryDelayMs = readNonNegativeNumber(
    "AGENT_MAX_RETRY_DELAY_MS",
    8_000,
  );
  const budgetOptions = createBudgetFromEnvironment();
  let budget = new BudgetTracker(budgetOptions);
  const rateLimiter = createRateLimiterFromEnvironment();

  const agent = new PiAgent({
    initialState: {
      systemPrompt: applySkillsToSystemPrompt(
        "你是一个可靠的助手；精确计算和当前时间必须使用工具。",
        selectedSkills,
      ),
      model,
      tools: selectedTools,
      messages: savedMessages,
    },
    // pi-ai 原生支持 timeout/maxRetries，不需要在成熟库外再写一套重试循环。
    streamFn: async (selectedModel, context, options) => {
      const delayMs = rateLimiter?.reserve() ?? 0;
      if (delayMs > 0) {
        console.log(
          `\n[rate limit] waiting ${(delayMs / 1000).toFixed(1)}s`,
        );
        await waitForRateLimit(delayMs, options?.signal);
      }
      return models.streamSimple(selectedModel, context, {
        ...options,
        timeoutMs,
        maxRetries,
        maxRetryDelayMs,
      });
    },
    sessionId,
    maxRetryDelayMs,
    toolExecution: "sequential",
  });

  // pi-agent 已提供比教学版更细的标准事件。
  agent.subscribe((event) => {
    if (event.type === "agent_start") {
      // pi-agent 实例可以多次 prompt；预算与 from-scratch 版一样按单次 run 重置。
      budget = new BudgetTracker(budgetOptions);
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      console.log(`\n[tool] ${event.toolName}`, event.args);
    }
    if (event.type === "tool_execution_end") {
      console.log(`[result] ${event.toolName}`, event.result);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      const totals = budget.record({
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
      });
      const cost =
        totals.estimatedCost === undefined
          ? ""
          : ` · estimated ${totals.currency} ${totals.estimatedCost.toFixed(6)}`;
      console.log(`\n[usage] ${totals.totalTokens} tokens${cost}`);
    }
    if (
      event.type === "turn_end" &&
      event.message.role === "assistant" &&
      event.message.content.some((block) => block.type === "toolCall")
    ) {
      try {
        budget.assertCanStartModelCall();
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        // turn_end 已在所有工具执行后发生；此时取消可阻止下一次模型调用。
        console.error(`\n[budget] ${error.message}`);
        agent.abort();
      }
    }
    if (event.type === "agent_end") {
      console.log("\n[done]");
      // subscribe listener 会被 pi-agent await，保存完成后 prompt() 才结束。
      if (memoryStore) {
        return memoryStore.save(sessionId, agent.state.messages);
      }
    }
  });

  return agent;
}

function loadSelectedPiSkills() {
  const names = readList(
    "PI_AGENT_SKILLS",
    readList("AGENT_SKILLS", []),
  );
  if (names.length === 0) return [];
  const directory =
    process.env.PI_AGENT_SKILLS_DIR ??
    process.env.AGENT_SKILLS_DIR ??
    "skills";
  return new SkillCatalog()
    .registerMany(loadSkillsFromDirectory(directory))
    .select(names);
}

function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = readNonNegativeNumber(name, fallback);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const agent = await createPiAgent();
  if (process.argv.includes("--dry-run")) {
    console.log(
      `pi-agent ready · model=${agent.state.model.id} · tools=${agent.state.tools
        .map((tool) => tool.name)
        .join(",")}`,
    );
  } else {
    await agent.prompt(process.argv.slice(2).join(" ") || "精确计算 1234 × 5678");
  }
}
