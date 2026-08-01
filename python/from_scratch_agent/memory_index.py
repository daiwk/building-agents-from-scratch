"""episodic / semantic / procedural 长期记忆索引。"""

import json
import math
import os
import re
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

MemoryKind = Literal["episodic", "semantic", "procedural"]


@dataclass
class MemoryRecord:
    id: str
    kind: MemoryKind
    content: str
    created_at_unix_ms: int = field(
        default_factory=lambda: int(time.time() * 1000)
    )
    metadata: dict[str, str] = field(default_factory=dict)


class MemoryIndex(Protocol):
    def upsert(self, record: MemoryRecord) -> None: ...
    def search(
        self, query: str, limit: int = 5, kinds: list[MemoryKind] | None = None
    ) -> list[MemoryRecord]: ...
    def remove(self, memory_id: str) -> None: ...


class InMemoryMemoryIndex:
    def __init__(self) -> None:
        self.records: dict[str, MemoryRecord] = {}

    def upsert(self, record: MemoryRecord) -> None:
        _validate(record)
        self.records[record.id] = record

    def search(self, query: str, limit: int = 5, kinds=None) -> list[MemoryRecord]:
        return _rank(list(self.records.values()), query, limit, kinds)

    def remove(self, memory_id: str) -> None:
        self.records.pop(memory_id, None)


class SqliteMemoryIndex:
    def __init__(self, file_path: str | Path) -> None:
        self.file_path = Path(file_path).resolve()
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.file_path, timeout=5) as database:
            database.execute("""CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
                created_at_unix_ms INTEGER NOT NULL, metadata_json TEXT NOT NULL
            )""")
        os.chmod(self.file_path, 0o600)

    def upsert(self, record: MemoryRecord) -> None:
        _validate(record)
        with sqlite3.connect(self.file_path, timeout=5) as database:
            database.execute("""INSERT INTO memories VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,
                content=excluded.content, created_at_unix_ms=excluded.created_at_unix_ms,
                metadata_json=excluded.metadata_json""", (
                record.id, record.kind, record.content, record.created_at_unix_ms,
                json.dumps(record.metadata, ensure_ascii=False),
            ))

    def search(
        self, query: str, limit: int = 5, kinds=None
    ) -> list[MemoryRecord]:
        with sqlite3.connect(self.file_path, timeout=5) as database:
            rows = database.execute(
                "SELECT id, kind, content, created_at_unix_ms, metadata_json FROM memories"
            ).fetchall()
        records = [
            MemoryRecord(row[0], row[1], row[2], row[3], json.loads(row[4]))
            for row in rows
        ]
        return _rank(records, query, limit, kinds)

    def remove(self, memory_id: str) -> None:
        with sqlite3.connect(self.file_path, timeout=5) as database:
            database.execute("DELETE FROM memories WHERE id = ?", (memory_id,))


def _rank(records, query: str, limit: int, kinds) -> list[MemoryRecord]:
    allowed = set(kinds) if kinds else None
    candidates = [
        record for record in records if not allowed or record.kind in allowed
    ]
    query_terms = _tokenize(query)
    scored = []
    for order, record in enumerate(candidates):
        words = _tokenize(record.content)
        score = 0.0
        for term in query_terms:
            frequency = words.count(term)
            documents = sum(term in _tokenize(item.content) for item in candidates)
            idf = math.log(
                1 + (len(candidates) + 1) / (documents + 1)
            )
            score += frequency * idf / (len(words) + 1)
        if score > 0:
            scored.append((score, record.created_at_unix_ms, -order, record))
    scored.sort(reverse=True, key=lambda item: item[:3])
    return [item[3] for item in scored[:limit]]


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[\u4e00-\u9fff]|[a-z0-9][a-z0-9_-]*", text.lower())


def _validate(record: MemoryRecord) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", record.id):
        raise ValueError("Memory id 无效")
    if (
        record.kind not in {"episodic", "semantic", "procedural"}
        or not record.content.strip()
    ):
        raise ValueError("Memory kind/content 无效")
