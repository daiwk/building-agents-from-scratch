import {
  Agent,
  type AssistantMessage,
  type Tool,
} from "../core/index.js";

export type AgentAsToolOptions = {
  name: string;
  description: string;
  /**
   * 每次调用都创建一个新的 child Agent，避免父子或多个任务共享可变 messages。
   */
  createAgent: () => Agent | Promise<Agent>;
};

/**
 * 把 child Agent 适配成普通 Tool，父 Agent 无需知道子 Agent 的内部循环。
 *
 * 边界很明确：
 * - child 只收到 task 字符串，不会自动看到父 Agent 历史；
 * - 父级 AbortSignal 会传给 child；
 * - child 的工具、memory 和 maxTurns 都由 createAgent() 单独配置。
 */
export function agentAsTool(options: AgentAsToolOptions): Tool {
  return {
    name: options.name,
    description: options.description,
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "交给子 Agent 独立完成的具体任务",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const task = input.task;
      if (typeof task !== "string") {
        throw new Error("Sub-agent task must be a string.");
      }

      const child = await options.createAgent();
      let finalMessage: AssistantMessage | undefined;
      for await (const event of child.run(task, {
        ...(context.signal ? { signal: context.signal } : {}),
      })) {
        if (event.type === "agentEnd") finalMessage = event.message;
      }
      if (!finalMessage) {
        throw new Error("Sub-agent ended without a final message.");
      }

      const text = finalMessage.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return text || "Sub-agent completed without text output.";
    },
  };
}
