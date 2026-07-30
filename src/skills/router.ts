import type { AgentHooks, AgentMessage } from "../core/index.js";
import {
  SkillCatalog,
  applySkillsToSystemPrompt,
} from "./catalog.js";

export type DynamicSkillHookOptions = {
  basePrompt: string;
  catalog: SkillCatalog;
  maxSkills?: number;
  minScore?: number;
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
    beforeModel(context) {
      const latestUserInput = findLatestUserInput(context.messages);
      const skills = latestUserInput
          ? options.catalog.discover(latestUserInput, {
            limit: options.maxSkills ?? 3,
            // 中文按单字做透明匹配，默认至少命中两个词，减少常见字误选。
            minScore: options.minScore ?? 2,
          })
        : [];
      context.systemPrompt = applySkillsToSystemPrompt(
        options.basePrompt,
        skills,
      );
    },
  };
}

function findLatestUserInput(
  messages: readonly AgentMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }
  return undefined;
}
