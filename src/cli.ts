import { loadEnvFile } from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import { Agent, type ModelProvider } from "./core/index.js";
import { CodexCliProvider, MiniMaxProvider } from "./providers/index.js";
import { calculatorTool, currentTimeTool } from "./tools/index.js";

if (existsSync(".env")) loadEnvFile(".env");

const providerName = process.env.AGENT_PROVIDER ?? "minimax";
const model = createProvider(providerName);
const tools = providerName === "minimax" ? [calculatorTool, currentTimeTool] : [];
const agent = new Agent({
  model,
  tools,
  systemPrompt:
    "你是一个简洁、可靠的助手。需要精确计算或当前时间时，必须使用工具。",
});
const readline = createInterface({ input: stdin, output: stdout });

console.log(`from-scratch agent · provider=${model.name}`);
console.log("输入 /reset 清空记忆，/exit 退出。\n");

try {
  while (true) {
    const input = (await readline.question("you> ")).trim();
    if (!input) continue;
    if (input === "/exit") break;
    if (input === "/reset") {
      agent.reset();
      console.log("memory cleared\n");
      continue;
    }

    try {
      for await (const event of agent.run(input)) {
        if (event.type === "toolStart") {
          console.log(
            `  ↳ tool ${event.call.name}(${JSON.stringify(event.call.arguments)})`,
          );
        }
        if (event.type === "toolEnd") {
          console.log(
            `  ↳ result ${event.result.isError ? "error: " : ""}${event.result.content}`,
          );
        }
        if (event.type === "text") console.log(`agent> ${event.text}\n`);
      }
    } catch (error) {
      console.error(
        `error> ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
} finally {
  readline.close();
}

function createProvider(name: string): ModelProvider {
  if (name === "minimax") {
    return new MiniMaxProvider({
      apiKey: process.env.MINIMAX_API_KEY ?? "",
      model: process.env.MINIMAX_MODEL ?? "MiniMax-M2.7",
      baseUrl:
        process.env.MINIMAX_BASE_URL ??
        "https://api.minimax.io/anthropic/v1",
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
