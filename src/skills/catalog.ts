import type { Skill } from "./types.js";

export type SkillDiscoveryOptions = {
  limit?: number;
  minScore?: number;
};

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

  /**
   * 用 name/description 做一个透明、零模型调用的关键词发现器。
   *
   * 这是教学版的第一步，不假装自己是语义检索。后续可以保留 discover() 的返回值
   * 语义，把内部评分替换为 embedding、BM25 或模型路由。
   */
  discover(
    query: string,
    options: SkillDiscoveryOptions = {},
  ): Skill[] {
    const limit = options.limit ?? 3;
    const minScore = options.minScore ?? 1;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Skill discovery limit must be a positive integer.");
    }
    if (!Number.isFinite(minScore) || minScore < 0) {
      throw new Error("Skill discovery minScore must be non-negative.");
    }

    return [...this.skills.values()]
      .map((skill, order) => ({
        skill,
        order,
        score: scoreSkill(query, skill),
      }))
      .filter((candidate) => candidate.score >= minScore)
      .sort(
        (left, right) =>
          right.score - left.score || left.order - right.order,
      )
      .slice(0, limit)
      .map((candidate) => candidate.skill);
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

function scoreSkill(query: string, skill: Skill): number {
  const normalizedQuery = query.toLocaleLowerCase();
  const normalizedName = skill.name.toLocaleLowerCase();
  let score = normalizedQuery.includes(normalizedName) ? 10 : 0;
  const terms = new Set(tokenize(`${skill.name} ${skill.description}`));
  for (const term of terms) {
    if (normalizedQuery.includes(term)) score += 1;
  }
  return score;
}

function tokenize(value: string): string[] {
  return (
    value
      .toLocaleLowerCase()
      .match(/\p{Script=Han}|[a-z0-9][a-z0-9_-]*/gu) ?? []
  );
}
