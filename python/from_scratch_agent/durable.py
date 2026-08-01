"""SQLite durable runtime：checkpoint、幂等 task queue 和 append-only events。"""

from __future__ import annotations
import json
import sqlite3
import time
import uuid
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


class SqliteGraphCheckpointStore:
    def __init__(self, file_path: str | Path) -> None:
        self.file_path = _prepare_path(file_path)
        self.connection = sqlite3.connect(self.file_path)
        self.connection.execute("PRAGMA busy_timeout = 5000")
        self.connection.execute("""
            CREATE TABLE IF NOT EXISTS graph_checkpoints (
                checkpoint_id TEXT PRIMARY KEY,
                checkpoint_json TEXT NOT NULL,
                updated_at_unix_ms INTEGER NOT NULL
            )
        """)
        self.connection.commit()

    def load(self, checkpoint_id: str) -> dict | None:
        row = self.connection.execute(
            "SELECT checkpoint_json FROM graph_checkpoints WHERE checkpoint_id = ?",
            (_required(checkpoint_id, "checkpoint_id"),),
        ).fetchone()
        return deepcopy(json.loads(row[0])) if row else None

    def save(self, checkpoint_id: str, checkpoint: dict) -> None:
        with self.connection:
            self.connection.execute("""
                INSERT INTO graph_checkpoints(
                    checkpoint_id, checkpoint_json, updated_at_unix_ms
                ) VALUES (?, ?, ?)
                ON CONFLICT(checkpoint_id) DO UPDATE SET
                    checkpoint_json = excluded.checkpoint_json,
                    updated_at_unix_ms = excluded.updated_at_unix_ms
            """, (
                _required(checkpoint_id, "checkpoint_id"),
                json.dumps(checkpoint, ensure_ascii=False),
                _now_ms(),
            ))

    def clear(self, checkpoint_id: str) -> None:
        with self.connection:
            self.connection.execute(
                "DELETE FROM graph_checkpoints WHERE checkpoint_id = ?",
                (_required(checkpoint_id, "checkpoint_id"),),
            )

    def close(self) -> None:
        self.connection.close()


@dataclass
class DurableTask:
    task_id: str
    kind: str
    payload: Any
    status: str
    result: Any = None
    error: str | None = None
    worker_id: str | None = None
    lease_until: int | None = None
    created_at: int = 0
    updated_at: int = 0


@dataclass
class DurableEvent:
    id: int
    task_id: str
    type: str
    payload: Any
    created_at: int


class SqliteDurableTaskStore:
    def __init__(self, file_path: str | Path) -> None:
        self.file_path = _prepare_path(file_path)
        self.connection = sqlite3.connect(self.file_path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA busy_timeout = 5000")
        self.connection.executescript("""
            CREATE TABLE IF NOT EXISTS durable_tasks (
                task_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
                payload_json TEXT NOT NULL, status TEXT NOT NULL,
                result_json TEXT, error TEXT, worker_id TEXT,
                lease_until_unix_ms INTEGER, created_at_unix_ms INTEGER NOT NULL,
                updated_at_unix_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS durable_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
                type TEXT NOT NULL, payload_json TEXT NOT NULL,
                created_at_unix_ms INTEGER NOT NULL
            );
        """)
        self.connection.commit()

    def enqueue(self, kind: str, payload: Any,
                task_id: str | None = None) -> DurableTask:
        task_id = task_id or str(uuid.uuid4())
        payload_json = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        now = _now_ms()
        with self.connection:
            cursor = self.connection.execute("""
                INSERT OR IGNORE INTO durable_tasks(
                    task_id, kind, payload_json, status,
                    created_at_unix_ms, updated_at_unix_ms
                ) VALUES (?, ?, ?, 'pending', ?, ?)
            """, (_required(task_id, "task_id"), _required(kind, "kind"),
                  payload_json, now, now))
            task = self.get(task_id)
            if cursor.rowcount == 0 and (
                task is None or task.kind != kind
                or json.dumps(task.payload, ensure_ascii=False, sort_keys=True) != payload_json
            ):
                raise ValueError(f"task_id {task_id} 的幂等 payload 冲突")
            if cursor.rowcount:
                self._append_event(task_id, "enqueued", {"kind": kind}, now)
        return self.get(task_id)

    def get(self, task_id: str) -> DurableTask | None:
        row = self.connection.execute(
            "SELECT * FROM durable_tasks WHERE task_id = ?",
            (_required(task_id, "task_id"),),
        ).fetchone()
        return _task_from_row(row) if row else None

    def claim(self, worker_id: str, lease_ms: int = 30_000) -> DurableTask | None:
        if lease_ms <= 0:
            raise ValueError("lease_ms 必须大于 0")
        worker_id = _required(worker_id, "worker_id")
        now = _now_ms()
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            expired = self.connection.execute("""
                SELECT task_id, worker_id FROM durable_tasks
                WHERE status = 'running' AND lease_until_unix_ms < ?
            """, (now,)).fetchall()
            self.connection.execute("""
                UPDATE durable_tasks SET status = 'pending', worker_id = NULL,
                    lease_until_unix_ms = NULL, updated_at_unix_ms = ?
                WHERE status = 'running' AND lease_until_unix_ms < ?
            """, (now, now))
            for task in expired:
                self._append_event(task["task_id"], "lease_expired", {
                    "previous_worker_id": task["worker_id"] or "unknown",
                }, now)
            row = self.connection.execute("""
                SELECT * FROM durable_tasks WHERE status = 'pending'
                ORDER BY created_at_unix_ms, task_id LIMIT 1
            """).fetchone()
            if row is None:
                self.connection.commit()
                return None
            self.connection.execute("""
                UPDATE durable_tasks SET status = 'running', worker_id = ?,
                    lease_until_unix_ms = ?, updated_at_unix_ms = ?
                WHERE task_id = ?
            """, (worker_id, now + lease_ms, now, row["task_id"]))
            self._append_event(row["task_id"], "claimed", {"worker_id": worker_id}, now)
            self.connection.commit()
            return self.get(row["task_id"])
        except Exception:
            self.connection.rollback()
            raise

    def complete(self, task_id: str, worker_id: str, result: Any) -> DurableTask:
        return self._finish(task_id, worker_id, "completed", result=result)

    def fail(self, task_id: str, worker_id: str, error: str) -> DurableTask:
        return self._finish(task_id, worker_id, "failed", error=error)

    def append_event(self, task_id: str, event_type: str, payload: Any) -> DurableEvent:
        now = _now_ms()
        with self.connection:
            event_id = self._append_event(task_id, event_type, payload, now)
        return DurableEvent(event_id, task_id, event_type, payload, now)

    def events(self, task_id: str) -> list[DurableEvent]:
        rows = self.connection.execute("""
            SELECT * FROM durable_events WHERE task_id = ? ORDER BY id
        """, (_required(task_id, "task_id"),)).fetchall()
        return [
            DurableEvent(row["id"], row["task_id"], row["type"],
                         json.loads(row["payload_json"]), row["created_at_unix_ms"])
            for row in rows
        ]

    def close(self) -> None:
        self.connection.close()

    def _finish(self, task_id: str, worker_id: str, status: str,
                result: Any = None, error: str | None = None) -> DurableTask:
        now = _now_ms()
        with self.connection:
            cursor = self.connection.execute("""
                UPDATE durable_tasks SET status = ?, result_json = ?, error = ?,
                    worker_id = NULL, lease_until_unix_ms = NULL,
                    updated_at_unix_ms = ?
                WHERE task_id = ? AND status = 'running' AND worker_id = ?
            """, (
                status,
                json.dumps(result, ensure_ascii=False) if status == "completed" else None,
                error, now, _required(task_id, "task_id"),
                _required(worker_id, "worker_id"),
            ))
            if cursor.rowcount != 1:
                raise ValueError("task 不属于当前 worker")
            payload = {"result": result} if status == "completed" else {"error": error}
            self._append_event(task_id, status, payload, now)
        return self.get(task_id)

    def _append_event(self, task_id: str, event_type: str,
                      payload: Any, now: int) -> int:
        cursor = self.connection.execute("""
            INSERT INTO durable_events(task_id, type, payload_json, created_at_unix_ms)
            VALUES (?, ?, ?, ?)
        """, (
            _required(task_id, "task_id"), _required(event_type, "event_type"),
            json.dumps(payload, ensure_ascii=False), now,
        ))
        return int(cursor.lastrowid)


class DurableTaskRunner:
    def __init__(self, store: SqliteDurableTaskStore, worker_id: str,
                 handlers: dict[str, Callable]) -> None:
        self.store = store
        self.worker_id = worker_id
        self.handlers = handlers

    def run_next(self) -> DurableTask | None:
        task = self.store.claim(self.worker_id)
        if task is None:
            return None
        handler = self.handlers.get(task.kind)
        if handler is None:
            return self.store.fail(
                task.task_id, self.worker_id, f"没有 handler：{task.kind}"
            )
        try:
            result = handler(task.payload, {
                "task_id": task.task_id,
                "append_event": lambda event_type, payload: self.store.append_event(
                    task.task_id, event_type, payload
                ),
            })
            return self.store.complete(task.task_id, self.worker_id, result)
        except Exception as error:
            return self.store.fail(task.task_id, self.worker_id, str(error))


def _task_from_row(row: sqlite3.Row) -> DurableTask:
    return DurableTask(
        task_id=row["task_id"], kind=row["kind"],
        payload=json.loads(row["payload_json"]), status=row["status"],
        result=json.loads(row["result_json"]) if row["result_json"] else None,
        error=row["error"], worker_id=row["worker_id"],
        lease_until=row["lease_until_unix_ms"],
        created_at=row["created_at_unix_ms"], updated_at=row["updated_at_unix_ms"],
    )


def _prepare_path(file_path: str | Path) -> str:
    path = Path(file_path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    if not str(file_path).strip():
        raise ValueError("SQLite path 不能为空")
    return str(path)


def _required(value: str, name: str) -> str:
    if not value.strip():
        raise ValueError(f"{name} 不能为空")
    return value


def _now_ms() -> int:
    return int(time.time() * 1000)
