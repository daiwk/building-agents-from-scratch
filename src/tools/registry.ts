import type { Tool } from "../core/index.js";
import { calculatorTool } from "./calculator.js";
import { currentTimeTool } from "./current-time.js";

/**
 * ToolRegistry 是工具的“目录”，负责注册、查找和按名称加载。
 *
 * AgentContext 最终仍然只接收 Tool[]，因此 Registry 不会侵入核心循环。
 * 它解决的是应用启动阶段“到底开放哪些工具”的问题。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool is already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerMany(tools: readonly Tool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * 只加载显式选择的工具，避免“注册过”自动变成“模型有权限调用”。
   */
  select(names: readonly string[]): Tool[] {
    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) {
        throw new Error(
          `Unknown tool: ${name}. Available tools: ${[
            ...this.tools.keys(),
          ].join(", ")}`,
        );
      }
      return tool;
    });
  }
}

export function createBuiltinToolRegistry(): ToolRegistry {
  return new ToolRegistry().registerMany([calculatorTool, currentTimeTool]);
}
