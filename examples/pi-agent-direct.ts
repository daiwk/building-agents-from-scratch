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
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { createModels, Type } from "@earendil-works/pi-ai";
import { minimaxCnProvider } from "@earendil-works/pi-ai/providers/minimax-cn";

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

export function createPiAgent(): PiAgent {
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

  const agent = new PiAgent({
    initialState: {
      systemPrompt: "你是一个可靠的助手；精确计算必须使用 calculator。",
      model,
      tools: [calculatorTool],
    },
    // pi-agent 要求注入真正执行模型流的函数。
    streamFn: models.streamSimple.bind(models),
    toolExecution: "sequential",
  });

  // pi-agent 已提供比教学版更细的标准事件。
  agent.subscribe((event) => {
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
    if (event.type === "agent_end") {
      console.log("\n[done]");
    }
  });

  return agent;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const agent = createPiAgent();
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
