import type { Skill } from "./types.js";

/**
 * SkillCatalog 与 ToolRegistry 类似：加载不等于启用，只有 select() 的 skill
 * 才会进入本轮 system prompt。
 */
export class SkillCatalog {
  private readonly skills = new Map<string, Skill>();

  register(skill: Skill): this {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill is already registered: ${skill.name}`);
    }
    this.skills.set(skill.name, skill);
    return this;
  }

  registerMany(skills: readonly Skill[]): this {
    for (const skill of skills) this.register(skill);
    return this;
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  select(names: readonly string[]): Skill[] {
    return names.map((name) => {
      const skill = this.skills.get(name);
      if (!skill) {
        throw new Error(
          `Unknown skill: ${name}. Available skills: ${[
            ...this.skills.keys(),
          ].join(", ")}`,
        );
      }
      return skill;
    });
  }
}

/**
 * 用清晰边界把选中的 skill 注入 system prompt，便于日志和调试时定位来源。
 */
export function applySkillsToSystemPrompt(
  basePrompt: string,
  skills: readonly Skill[],
): string {
  if (skills.length === 0) return basePrompt;
  const sections = skills.map(
    (skill) =>
      `<skill name="${escapeAttribute(skill.name)}">\n` +
      `${skill.instructions}\n</skill>`,
  );
  return `${basePrompt.trim()}\n\n# Loaded skills\n\n${sections.join("\n\n")}`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
