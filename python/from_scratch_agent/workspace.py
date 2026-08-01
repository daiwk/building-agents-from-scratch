"""默认只读、限制在一个 root 内且不执行 shell 的 workspace tools。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from .registry import ToolRegistry
from .types import Tool


@dataclass(frozen=True)
class FileArtifact:
    id: str
    name: str
    media_type: str
    content: str


class InMemoryFileArtifactStore:
    def __init__(self) -> None:
        self._items: dict[str, FileArtifact] = {}

    def put(self, name: str, media_type: str, content: str) -> FileArtifact:
        artifact = FileArtifact(
            f"artifact-{len(self._items) + 1}", name, media_type, content
        )
        self._items[artifact.id] = artifact
        return artifact

    def get(self, artifact_id: str) -> FileArtifact | None:
        return self._items.get(artifact_id)

    def list(self) -> list[FileArtifact]:
        return list(self._items.values())


@dataclass
class WorkspaceToolKit:
    registry: ToolRegistry
    artifacts: InMemoryFileArtifactStore


def create_workspace_toolkit(
    root: str | Path,
    allow_write: bool = False,
    max_read_bytes: int = 256_000,
    max_write_bytes: int = 256_000,
    max_entries: int = 500,
    max_matches: int = 200,
    max_inline_characters: int = 8_000,
) -> WorkspaceToolKit:
    _positive(max_inline_characters, "max_inline_characters")
    sandbox = _WorkspaceSandbox(
        root, max_read_bytes, max_write_bytes, max_entries, max_matches
    )
    artifacts = InMemoryFileArtifactStore()

    def formatted(name: str, text: str) -> str:
        if len(text) <= max_inline_characters:
            return text
        artifact = artifacts.put(name, "text/plain", text)
        return (
            text[:max_inline_characters]
            + f"\n\n[output truncated; artifact={artifact.id}; characters={len(text)}]"
        )

    tools = [
        Tool("read_artifact", "分段读取被截断的工具输出", {
            "type": "object",
            "properties": {
                "id": {"type": "string"}, "offset": {"type": "integer"},
                "limit": {"type": "integer"},
            },
            "required": ["id"], "additionalProperties": False,
        }, lambda args: _read_artifact(
            artifacts,
            _required_string(args.get("id"), "id"),
            _optional_non_negative_int(args.get("offset"), 0, "offset"),
            _optional_positive_int(args.get("limit"), max_inline_characters, "limit"),
        )),
        Tool("list_files", "列出授权 workspace 内的文件", _schema(False),
             lambda args: formatted("file-list.txt", "\n".join(
                 sandbox.list(_optional_string(args.get("path"), "."))
             ))),
        Tool("read_file", "读取授权 workspace 内的 UTF-8 文件", _schema(True),
             lambda args: formatted(Path(_required_string(args.get("path"), "path")).name,
                                    sandbox.read(_required_string(args.get("path"), "path")))),
        Tool("search_text", "不执行 shell，在 workspace 内搜索文本", {
            "type": "object",
            "properties": {"query": {"type": "string"}, "path": {"type": "string"}},
            "required": ["query"], "additionalProperties": False,
        }, lambda args: formatted("search-results.txt", "\n".join(sandbox.search(
            _optional_string(args.get("path"), "."),
            _required_string(args.get("query"), "query"),
        )))),
    ]
    if allow_write:
        tools.append(Tool("write_file", "替换 workspace 内的 UTF-8 文件；需宿主显式授权", {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"], "additionalProperties": False,
        }, lambda args: sandbox.write(
            _required_string(args.get("path"), "path"),
            _required_string(args.get("content"), "content", allow_empty=True),
        )))
    return WorkspaceToolKit(ToolRegistry().register_many(tools), artifacts)


class _WorkspaceSandbox:
    def __init__(self, root, max_read, max_write, max_entries, max_matches) -> None:
        self.root = Path(root).resolve(strict=True)
        self.max_read = _positive(max_read, "max_read_bytes")
        self.max_write = _positive(max_write, "max_write_bytes")
        self.max_entries = _positive(max_entries, "max_entries")
        self.max_matches = _positive(max_matches, "max_matches")

    def list(self, user_path: str) -> list[str]:
        start = self._existing(user_path)
        result = []
        for path in self._walk(start):
            result.append("." if path == self.root else str(path.relative_to(self.root)))
            if len(result) >= self.max_entries:
                break
        return result

    def read(self, user_path: str) -> str:
        path = self._existing(user_path)
        if not path.is_file():
            raise ValueError("Workspace path 不是文件")
        if path.stat().st_size > self.max_read:
            raise ValueError(f"文件超过 {self.max_read} bytes")
        return path.read_text(encoding="utf-8")

    def search(self, user_path: str, query: str) -> list[str]:
        if not query:
            raise ValueError("query 不能为空")
        matches = []
        for path in self._walk(self._existing(user_path)):
            if not path.is_file() or path.stat().st_size > self.max_read:
                continue
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except (UnicodeDecodeError, OSError):
                continue
            for number, line in enumerate(lines, 1):
                if query in line:
                    matches.append(f"{path.relative_to(self.root)}:{number}:{line}")
                    if len(matches) >= self.max_matches:
                        return matches
        return matches

    def write(self, user_path: str, content: str) -> str:
        if len(content.encode()) > self.max_write:
            raise ValueError(f"content 超过 {self.max_write} bytes")
        target = self._writable(user_path)
        with NamedTemporaryFile(
            "w", encoding="utf-8", dir=target.parent, prefix=f".{target.name}.",
            suffix=".tmp", delete=False,
        ) as temporary:
            temporary.write(content)
            temporary_path = Path(temporary.name)
        temporary_path.chmod(0o600)
        temporary_path.replace(target)
        return f"Wrote {len(content.encode())} bytes to {user_path}"

    def _walk(self, start: Path):
        pending = [start]
        while pending:
            current = pending.pop(0)
            if current.is_symlink():
                continue
            yield current
            if current.is_dir():
                children = sorted(current.iterdir(), key=lambda item: item.name)
                pending.extend(item for item in children if (
                    not item.is_symlink()
                    and item.name not in {".git", "node_modules", ".agent-data"}
                ))

    def _existing(self, user_path: str) -> Path:
        candidate = self._lexical(user_path).resolve(strict=True)
        self._inside(candidate)
        return candidate

    def _writable(self, user_path: str) -> Path:
        candidate = self._lexical(user_path)
        parent = candidate.parent.resolve(strict=True)
        self._inside(parent)
        return parent / candidate.name

    def _lexical(self, user_path: str) -> Path:
        value = Path(user_path)
        if not user_path or "\0" in user_path or value.is_absolute():
            raise ValueError("Workspace path 必须是非空相对路径")
        candidate = self.root / value
        self._inside(candidate.resolve(strict=False))
        return candidate

    def _inside(self, path: Path) -> None:
        if path != self.root and self.root not in path.parents:
            raise ValueError("Path escapes the authorized workspace")


def _schema(required):
    result: dict[str, Any] = {
        "type": "object", "properties": {"path": {"type": "string"}},
        "additionalProperties": False,
    }
    if required:
        result["required"] = ["path"]
    return result


def _required_string(value, name, allow_empty=False):
    if not isinstance(value, str) or (not allow_empty and not value):
        raise ValueError(f"{name} 必须是字符串")
    return value


def _optional_string(value, fallback):
    return fallback if value is None else _required_string(value, "path")


def _positive(value, name):
    if not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} 必须是正整数")
    return value


def _optional_non_negative_int(value, fallback, name):
    if value is None:
        return fallback
    if not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} 必须是非负整数")
    return value


def _optional_positive_int(value, fallback, name):
    return fallback if value is None else _positive(value, name)


def _read_artifact(store, artifact_id, offset, limit):
    artifact = store.get(artifact_id)
    if artifact is None:
        raise ValueError(f"未知 artifact：{artifact_id}")
    return (
        f"[artifact={artifact_id}; offset={offset}; total={len(artifact.content)}]\n"
        + artifact.content[offset:offset + limit]
    )
