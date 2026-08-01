import type { AgentHooks, AgentMessage } from "../core/index.js";
import type { SkillRouter } from "./types.js";
import {
  SkillCatalog,
  applySkillsToSystemPrompt,
  assertSkillToolsAvailable,
} from "./catalog.js";

export type DynamicSkillHookOptions = {
  basePrompt: string;
  catalog: SkillCatalog;
  maxSkills?: number;
  minScore?: number;
  authorizeSkill?: (name: string) => void;
  router?: SkillRouter;
  allowedToolNames?: string[];
};

/**
 * 在每次调用模型前，根据最新用户输入动态选择 skill。
 *
 * 这个 hook 每次都从 basePrompt 重新构造 system prompt，因此不会重复嵌套旧 skill。
 * 它只注入文本；skill 仍不能自动增加工具权限。
 */
export function createDynamicSkillHook(
  options: DynamicSkillHookOptions,
): AgentHooks {
  return {
    async beforeModel(context) {
      const latestUserInput = findLatestUserInput(context.messages);
      const skills = latestUserInput
        ? options.router
          ? await options.catalog.route(
              latestUserInput,
              options.router,
              options.maxSkills ?? 3,
            )
          : options.catalog.discover(latestUserInput, {
              limit: options.maxSkills ?? 3,
              minScore: options.minScore ?? 0.05,
            })
        : [];
      if (options.allowedToolNames) {
        assertSkillToolsAvailable(skills, options.allowedToolNames);
      }
      for (const skill of skills) options.authorizeSkill?.(skill.name);
      context.systemPrompt = applySkillsToSystemPrompt(
        options.basePrompt,
        skills,
      );
    },
  };
}

/** 把任意模型调用函数包成受 Catalog 约束的 router，便于接 JSON mode 或专用分类模型。 */
export class ModelSkillRouter implements SkillRouter {
  constructor(
    private readonly routeWithModel: (
      query: string,
      candidates: readonly {
        name: string;
        description: string;
        version: string;
      }[],
      limit: number,
    ) => Promise<string[]>,
  ) {}

  route(
    query: string,
    skills: Parameters<SkillRouter["route"]>[1],
    limit: number,
  ): Promise<string[]> {
    const candidates = skills.map(({ name, description, version }) => ({
      name,
      description,
      version,
    }));
    return this.routeWithModel(query, candidates, limit);
  }
}

function findLatestUserInput(
  messages: readonly AgentMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return typeof message.content === "string"
      ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
  }
  return undefined;
}
