import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Skill } from "./types.js";

const MAX_SKILL_BYTES = 256 * 1024;

/**
 * 从一个目录加载 SKILL.md。
 *
 * 支持两种结构：
 *   skills/SKILL.md
 *   skills/<skill-name>/SKILL.md
 *
 * 这里只读取 Markdown 指令，不 import JS、不执行 shell，也不会自动获得新工具权限。
 */
export function loadSkillsFromDirectory(directory: string): Skill[] {
  const root = resolve(directory);
  if (!existsSync(root)) {
    throw new Error(`Skills directory does not exist: ${root}`);
  }

  const candidates: string[] = [];
  const rootSkill = join(root, "SKILL.md");
  if (existsSync(rootSkill)) candidates.push(rootSkill);

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(root, entry.name, "SKILL.md");
    if (existsSync(skillFile)) candidates.push(skillFile);
  }

  return candidates.sort().map(loadSkillFile);
}

export function loadSkillFile(filePath: string): Skill {
  const absolutePath = resolve(filePath);
  const size = statSync(absolutePath).size;
  if (size > MAX_SKILL_BYTES) {
    throw new Error(`Skill file is larger than 256 KiB: ${absolutePath}`);
  }
  return parseSkillMarkdown(readFileSync(absolutePath, "utf8"), absolutePath);
}

export function parseSkillMarkdown(markdown: string, sourcePath: string): Skill {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error(`Skill must start with YAML frontmatter: ${sourcePath}`);
  }

  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex < 0) {
    throw new Error(`Skill frontmatter is not closed: ${sourcePath}`);
  }

  const frontmatter = normalized.slice(4, closingIndex);
  const metadata = parseSimpleFrontmatter(frontmatter, sourcePath);
  const instructions = normalized.slice(closingIndex + 5).trim();
  if (!metadata.name) throw new Error(`Skill name is required: ${sourcePath}`);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(metadata.name)) {
    throw new Error(`Invalid skill name: ${metadata.name}`);
  }
  if (!metadata.description) {
    throw new Error(`Skill description is required: ${sourcePath}`);
  }
  if (!instructions) {
    throw new Error(`Skill instructions are empty: ${sourcePath}`);
  }

  return {
    name: metadata.name,
    description: metadata.description,
    instructions,
    sourcePath: resolve(sourcePath),
  };
}

/**
 * 教学版只解析顶层 name/description 字符串，避免假装实现完整 YAML。
 */
function parseSimpleFrontmatter(
  frontmatter: string,
  sourcePath: string,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw new Error(`Unsupported skill frontmatter in ${sourcePath}: ${line}`);
    }
    const key = line.slice(0, separator).trim();
    const value = stripQuotes(line.slice(separator + 1).trim());
    if (key === "name" || key === "description") metadata[key] = value;
  }
  return metadata;
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
