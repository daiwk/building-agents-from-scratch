import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  createAgentFromEnv,
  getProviderName,
  loadLocalEnv,
} from "./runtime/create-agent.js";

loadLocalEnv();

const providerName = getProviderName();
const agent = createAgentFromEnv(process.env.AGENT_SESSION_ID ?? "cli");
const readline = createInterface({ input: stdin, output: stdout });

console.log(`from-scratch agent · provider=${providerName}`);
console.log("输入 /reset 清空记忆，/exit 退出。\n");

try {
  while (true) {
    const input = (await readline.question("you> ")).trim();
    if (!input) continue;
    if (input === "/exit") break;
    if (input === "/reset") {
      await agent.reset();
      console.log("memory cleared\n");
      continue;
    }

    try {
      let receivedTextDelta = false;
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
        if (event.type === "rateLimitWait") {
          console.log(
            `  ↳ rate limit · waiting ${(event.delayMs / 1000).toFixed(1)}s`,
          );
        }
        if (event.type === "text") console.log(`agent> ${event.text}\n`);
        if (event.type === "textDelta") {
          if (!receivedTextDelta) stdout.write("agent> ");
          stdout.write(event.delta);
          receivedTextDelta = true;
        }
        if (event.type === "usage") {
          if (receivedTextDelta) {
            stdout.write("\n");
            receivedTextDelta = false;
          }
          const cost =
            event.totals.estimatedCost === undefined
              ? ""
              : ` · estimated ${event.totals.currency} ${event.totals.estimatedCost.toFixed(6)}`;
          console.log(
            `  ↳ usage ${event.totals.totalTokens} tokens${cost}`,
          );
        }
        if (event.type === "agentEnd" && receivedTextDelta) {
          stdout.write("\n\n");
        }
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
