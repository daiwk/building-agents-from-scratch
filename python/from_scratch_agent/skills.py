"""安全读取和选择 SKILL.md；只处理文本，不执行代码。"""

import math
from dataclasses import dataclass, field
from pathlib import Path
from re import findall, fullmatch
from typing import Protocol

from .context_builder import ContextBuilder
from .types import AgentContext


MAX_SKILL_BYTES = 256 * 1024


@dataclass
class Skill:
    name: str
    description: str
    instructions: str
    source_path: str
    version: str = "1.0.0"
    dependencies: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    required_tools: list[str] = field(default_factory=list)


class SkillRouter(Protocol):
    def route(self, query: str, skills: list[Skill], limit: int) -> list[str]: ...


class SkillCatalog:
    def __init__(self) -> None:
        self._skills: dict[str, Skill] = {}

    def register(self, skill: Skill) -> "SkillCatalog":
        if skill.name in self._skills:
            raise ValueError(f"Skill 已注册：{skill.name}")
        self._skills[skill.name] = skill
        return self

    def register_many(self, skills: list[Skill]) -> "SkillCatalog":
        for skill in skills:
            self.register(skill)
        return self

    def select(self, names: list[str]) -> list[Skill]:
        selected: list[Skill] = []
        visited: set[str] = set()
        visiting: set[str] = set()

        def visit(name: str) -> None:
            if name in visited:
                return
            if name in visiting:
                raise ValueError(f"Skill 循环依赖：{name}")
            if name not in self._skills:
                raise ValueError(f"未知 Skill：{name}")
            visiting.add(name)
            skill = self._skills[name]
            for dependency in skill.dependencies:
                visit(dependency)
            visiting.remove(name)
            visited.add(name)
            selected.append(skill)

        for name in names:
            visit(name)
        return selected

    def discover(self, query: str, limit: int = 3) -> list[Skill]:
        corpus = list(self._skills.values())
        scored = [
            (_score_skill(query, skill, corpus), order, skill)
            for order, skill in enumerate(corpus)
        ]
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [skill for score, _, skill in scored if score > 0][:limit]

    def route(
        self, query: str, router: SkillRouter, limit: int = 3
    ) -> list[Skill]:
        names = router.route(query, list(self._skills.values()), limit)
        return self.select(list(dict.fromkeys(names))[:limit])


@dataclass
class SkillRoutingContextBuilder:
    base_prompt: str
    catalog: SkillCatalog
    delegate: ContextBuilder | None = None
    router: SkillRouter | None = None
    limit: int = 3
    allowed_tool_names: list[str] | None = None

    def build(self, context: AgentContext) -> AgentContext:
        built = self.delegate.build(context) if self.delegate else AgentContext(
            context.system_prompt, list(context.messages), context.tools
        )
        query = next(
            (
                str(message.get("content", ""))
                for message in reversed(context.messages)
                if message.get("role") == "user"
            ),
            "",
        )
        skills = (
            self.catalog.route(query, self.router, self.limit)
            if query and self.router
            else self.catalog.discover(query, self.limit) if query else []
        )
        if self.allowed_tool_names is not None:
            assert_skill_tools_available(skills, self.allowed_tool_names)
        suffix = (
            built.system_prompt[len(context.system_prompt):]
            if built.system_prompt.startswith(context.system_prompt)
            else ""
        )
        built.system_prompt = apply_skills_to_system_prompt(
            self.base_prompt, skills
        ) + suffix
        return built


def load_skills_from_directory(directory: str | Path) -> list[Skill]:
    root = Path(directory).resolve()
    if not root.exists():
        raise ValueError(f"Skill 目录不存在：{root}")
    candidates = []
    if (root / "SKILL.md").exists():
        candidates.append(root / "SKILL.md")
    candidates.extend(
        child / "SKILL.md"
        for child in root.iterdir()
        if child.is_dir() and (child / "SKILL.md").exists()
    )
    return [load_skill_file(path) for path in sorted(candidates)]


def load_skill_file(file_path: str | Path) -> Skill:
    path = Path(file_path).resolve()
    if path.stat().st_size > MAX_SKILL_BYTES:
        raise ValueError(f"Skill 文件超过 256 KiB：{path}")
    return parse_skill_markdown(path.read_text(encoding="utf-8"), str(path))


def parse_skill_markdown(markdown: str, source_path: str) -> Skill:
    normalized = markdown.replace("\r\n", "\n")
    if not normalized.startswith("---\n"):
        raise ValueError(f"Skill 必须以 frontmatter 开头：{source_path}")
    closing = normalized.find("\n---\n", 4)
    if closing < 0:
        raise ValueError(f"Skill frontmatter 未闭合：{source_path}")

    metadata: dict[str, str] = {}
    for raw_line in normalized[4:closing].splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition(":")
        if not separator:
            raise ValueError(f"不支持的 frontmatter：{line}")
        if key.strip() in {
            "name", "description", "version", "dependencies", "tags", "tools"
        }:
            metadata[key.strip()] = value.strip().strip("\"'")

    name = metadata.get("name", "")
    description = metadata.get("description", "")
    instructions = normalized[closing + 5 :].strip()
    version = metadata.get("version", "1.0.0")
    if not fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", name):
        raise ValueError(f"Skill name 无效：{name}")
    if not description or not instructions:
        raise ValueError(f"Skill description/instructions 不能为空：{source_path}")
    if not fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError(f"Skill version 无效：{version}")
    def split(value: str) -> list[str]:
        return [item.strip() for item in value.split(",") if item.strip()]

    return Skill(
        name,
        description,
        instructions,
        str(Path(source_path).resolve()),
        version,
        split(metadata.get("dependencies", "")),
        split(metadata.get("tags", "")),
        split(metadata.get("tools", "")),
    )


def apply_skills_to_system_prompt(
    base_prompt: str,
    skills: list[Skill],
) -> str:
    if not skills:
        return base_prompt
    sections = [
        f'<skill name="{skill.name}">\n'
        f'<metadata version="{skill.version}" />\n'
        f'{skill.instructions}\n</skill>'
        for skill in skills
    ]
    return f"{base_prompt.strip()}\n\n# Loaded skills\n\n" + "\n\n".join(
        sections
    )


def assert_skill_tools_available(skills: list[Skill], allowed: list[str]) -> None:
    allowed_names = set(allowed)
    for skill in skills:
        missing = [
            name for name in skill.required_tools if name not in allowed_names
        ]
        if missing:
            raise ValueError(
                f"Skill {skill.name} 需要未授权工具：{', '.join(missing)}"
            )


def _score_skill(query: str, skill: Skill, corpus: list[Skill]) -> float:
    query_terms = _tokenize(query)
    document = _tokenize(
        f"{skill.name} {skill.description} {' '.join(skill.tags)}"
    )
    score = 10.0 if skill.name.lower() in query.lower() else 0.0
    for term in query_terms:
        frequency = document.count(term)
        documents = sum(
            term in _tokenize(
                f"{item.name} {item.description} {' '.join(item.tags)}"
            )
            for item in corpus
        )
        idf = math.log(1 + (len(corpus) + 1) / (documents + 1))
        score += frequency * idf / (len(document) + 1)
    return score


def _tokenize(text: str) -> list[str]:
    return findall(r"[\u4e00-\u9fff]|[a-z0-9][a-z0-9_-]*", text.lower())
