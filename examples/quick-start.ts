import { Agent } from "../src/core/index.js";
import { MiniMaxProvider } from "../src/providers/index.js";
import { calculatorTool } from "../src/tools/index.js";

const agent = new Agent({
  model: new MiniMaxProvider({
    apiKey: process.env.MINIMAX_API_KEY ?? "",
  }),
  tools: [calculatorTool],
  systemPrompt: "You are helpful. Always use the calculator for arithmetic.",
});

for await (const event of agent.run("What is 1234 * 5678?")) {
  if (event.type === "toolStart") console.log("tool call:", event.call);
  if (event.type === "toolEnd") console.log("tool result:", event.result);
  if (event.type === "text") console.log("answer:", event.text);
}
