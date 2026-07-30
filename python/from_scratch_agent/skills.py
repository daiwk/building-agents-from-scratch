"""安全读取和选择 SKILL.md；只处理文本，不执行代码。"""

from dataclasses import dataclass
from pathlib import Path
from re import fullmatch


MAX_SKILL_BYTES = 256 * 1024


@dataclass
class Skill:
    name: str
    description: str
    instructions: str
    source_path: str


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
        for name in names:
            if name not in self._skills:
                raise ValueError(f"未知 Skill：{name}")
            selected.append(self._skills[name])
        return selected


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
        if key.strip() in {"name", "description"}:
            metadata[key.strip()] = value.strip().strip("\"'")

    name = metadata.get("name", "")
    description = metadata.get("description", "")
    instructions = normalized[closing + 5 :].strip()
    if not fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", name):
        raise ValueError(f"Skill name 无效：{name}")
    if not description or not instructions:
        raise ValueError(f"Skill description/instructions 不能为空：{source_path}")
    return Skill(name, description, instructions, str(Path(source_path).resolve()))


def apply_skills_to_system_prompt(
    base_prompt: str,
    skills: list[Skill],
) -> str:
    if not skills:
        return base_prompt
    sections = [
        f'<skill name="{skill.name}">\n{skill.instructions}\n</skill>'
        for skill in skills
    ]
    return f"{base_prompt.strip()}\n\n# Loaded skills\n\n" + "\n\n".join(
        sections
    )
