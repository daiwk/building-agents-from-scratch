import type { Skill, SkillRouter } from "./types.js";

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
    const selected: Skill[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular skill dependency: ${name}`);
      }
      const skill = this.skills.get(name);
      if (!skill) {
        throw new Error(
          `Unknown skill: ${name}. Available skills: ${[
            ...this.skills.keys(),
          ].join(", ")}`,
        );
      }
      visiting.add(name);
      for (const dependency of skill.dependencies) visit(dependency);
      visiting.delete(name);
      visited.add(name);
      selected.push(skill);
    };
    for (const name of names) visit(name);
    return selected;
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
    const minScore = options.minScore ?? 0.0001;
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
        score: scoreSkill(query, skill, [...this.skills.values()]),
      }))
      .filter((candidate) => candidate.score >= minScore)
      .sort(
        (left, right) =>
          right.score - left.score || left.order - right.order,
      )
      .slice(0, limit)
      .map((candidate) => candidate.skill);
  }

  async route(query: string, router: SkillRouter, limit = 3): Promise<Skill[]> {
    const names = await router.route(query, this.list(), limit);
    const unique = [...new Set(names)].slice(0, limit);
    return this.select(unique);
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
      `<metadata version="${escapeAttribute(skill.version)}" />\n` +
      `${skill.instructions}\n</skill>`,
  );
  return `${basePrompt.trim()}\n\n# Loaded skills\n\n${sections.join("\n\n")}`;
}

export function assertSkillToolsAvailable(
  skills: readonly Skill[],
  allowedToolNames: readonly string[],
): void {
  const allowed = new Set(allowedToolNames);
  for (const skill of skills) {
    const missing = skill.requiredTools.filter((name) => !allowed.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Skill ${skill.name} requires unavailable tools: ${missing.join(", ")}`,
      );
    }
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function scoreSkill(
  query: string,
  skill: Skill,
  corpus: readonly Skill[],
): number {
  const queryTerms = tokenize(query);
  const documentTerms = tokenize(
    `${skill.name} ${skill.description} ${skill.tags.join(" ")}`,
  );
  let score = query
    .toLocaleLowerCase()
    .includes(skill.name.toLocaleLowerCase())
    ? 10
    : 0;
  for (const term of queryTerms) {
    const frequency = documentTerms.filter((item) => item === term).length;
    const documentsWithTerm = corpus.filter((item) =>
      tokenize(
        `${item.name} ${item.description} ${item.tags.join(" ")}`,
      ).includes(term),
    ).length;
    const idf = Math.log(1 + (corpus.length + 1) / (documentsWithTerm + 1));
    score += frequency * idf / (documentTerms.length + 1);
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
