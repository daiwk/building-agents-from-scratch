"""ConversationStore：只保存会话消息，不混入摘要或向量检索。"""

import json
import os
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


def _validate_session_id(session_id: str) -> None:
    if not session_id or len(session_id) > 80 or not all(
        character.isalnum() or character in "_-" for character in session_id
    ):
        raise ValueError("session_id 只能包含 1-80 个字母、数字、_ 或 -")
