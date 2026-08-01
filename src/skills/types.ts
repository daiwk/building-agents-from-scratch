export type Skill = {
  name: string;
  description: string;
  instructions: string;
  sourcePath: string;
  version: string;
  dependencies: string[];
  tags: string[];
  requiredTools: string[];
};

/** 模型路由只返回 skill 名称；Catalog 仍负责白名单、依赖和数量边界。 */
export type SkillRouter = {
  route(query: string, skills: readonly Skill[], limit: number): Promise<string[]>;
};
