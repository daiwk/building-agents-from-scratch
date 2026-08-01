"""ConversationStore：只保存会话消息，不混入摘要或向量检索。"""

import json
import os
import sqlite3
import time
from copy import deepcopy
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from typing import Protocol

from .types import Message


class ConversationStore(Protocol):
    def load(self, session_id: str) -> list[Message]: ...

    def save(self, session_id: str, messages: list[Message]) -> None: ...

    def clear(self, session_id: str) -> None: ...


class InMemoryConversationStore:
    def __init__(self) -> None:
        self._conversations: dict[str, list[Message]] = {}

    def load(self, session_id: str) -> list[Message]:
        _validate_session_id(session_id)
        return deepcopy(self._conversations.get(session_id, []))

    def save(self, session_id: str, messages: list[Message]) -> None:
        _validate_session_id(session_id)
        self._conversations[session_id] = deepcopy(messages)

    def clear(self, session_id: str) -> None:
        _validate_session_id(session_id)
        self._conversations.pop(session_id, None)


class JsonFileConversationStore:
    """适合本地教学的原子 JSON store；多进程场景应换数据库。"""

    def __init__(self, file_path: str | Path) -> None:
        self.file_path = Path(file_path).resolve()
        self._lock = Lock()

    def load(self, session_id: str) -> list[Message]:
        _validate_session_id(session_id)
        with self._lock:
            data = self._read()
            return deepcopy(data["conversations"].get(session_id, []))

    def save(self, session_id: str, messages: list[Message]) -> None:
        _validate_session_id(session_id)
        with self._lock:
            data = self._read()
            data["conversations"][session_id] = deepcopy(messages)
            self._write(data)

    def clear(self, session_id: str) -> None:
        _validate_session_id(session_id)
        with self._lock:
            data = self._read()
            data["conversations"].pop(session_id, None)
            self._write(data)

    def _read(self) -> dict:
        if not self.file_path.exists():
            return {"version": 1, "conversations": {}}
        data = json.loads(self.file_path.read_text(encoding="utf-8"))
        if data.get("version") != 1 or not isinstance(
            data.get("conversations"), dict
        ):
            raise ValueError("不支持的 memory 文件格式")
        if not all(
            isinstance(messages, list)
            for messages in data["conversations"].values()
        ):
            raise ValueError("memory 中的 conversation 必须是列表")
        return data

    def _write(self, data: dict) -> None:
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_name = ""
        try:
            with NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=self.file_path.parent,
                prefix=f".{self.file_path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_name = temporary.name
                json.dump(data, temporary, ensure_ascii=False, indent=2)
                temporary.write("\n")
            os.chmod(temporary_name, 0o600)
            os.replace(temporary_name, self.file_path)
        finally:
            if temporary_name and os.path.exists(temporary_name):
                os.unlink(temporary_name)


class SqliteConversationStore:
    """标准库 SQLite store；表结构与 TypeScript 版一致。"""

    def __init__(self, file_path: str | Path) -> None:
        self.file_path = Path(file_path).resolve()
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as database:
            database.execute(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    session_id TEXT PRIMARY KEY,
                    messages_json TEXT NOT NULL,
                    updated_at_unix_ms INTEGER NOT NULL
                )
                """
            )
        os.chmod(self.file_path, 0o600)

    def load(self, session_id: str) -> list[Message]:
        _validate_session_id(session_id)
        with self._connect() as database:
            row = database.execute(
                "SELECT messages_json FROM conversations WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            return []
        messages = json.loads(row[0])
        if not isinstance(messages, list):
            raise ValueError("SQLite memory 中的 conversation 必须是列表")
        return deepcopy(messages)

    def save(self, session_id: str, messages: list[Message]) -> None:
        _validate_session_id(session_id)
        payload = json.dumps(messages, ensure_ascii=False)
        with self._connect() as database:
            database.execute(
                """
                INSERT INTO conversations(
                    session_id, messages_json, updated_at_unix_ms
                ) VALUES (?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    messages_json = excluded.messages_json,
                    updated_at_unix_ms = excluded.updated_at_unix_ms
                """,
                (session_id, payload, int(time.time() * 1000)),
            )

    def clear(self, session_id: str) -> None:
        _validate_session_id(session_id)
        with self._connect() as database:
            database.execute(
                "DELETE FROM conversations WHERE session_id = ?",
                (session_id,),
            )

    def _connect(self) -> sqlite3.Connection:
        # 每次操作使用短连接，避免 ThreadPool/Web 接入时共享线程绑定的 connection。
        return sqlite3.connect(self.file_path, timeout=5)


def _validate_session_id(session_id: str) -> None:
    if not session_id or len(session_id) > 80 or not all(
        character.isalnum() or character in "_-" for character in session_id
    ):
        raise ValueError("session_id 只能包含 1-80 个字母、数字、_ 或 -")
