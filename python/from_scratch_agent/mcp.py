"""MCP 工具发现与调用：server 能提供工具，不代表 Agent 自动获得权限。"""

from __future__ import annotations
import json
import subprocess
import uuid
from queue import Empty, Queue
from threading import Lock, Thread
from typing import Any, Protocol
from .registry import ToolRegistry
from .types import Tool

SECRET_KEYS = {"authorization", "token", "api_key", "apikey", "password", "secret"}


class McpTransport(Protocol):
    def request(self, method: str, params: dict[str, Any],
                request_id: str | int | None = None) -> Any: ...
    def notify(self, method: str, params: dict[str, Any] | None = None) -> None: ...
    def close(self) -> None: ...


class McpClient:
    def __init__(self, server_name: str, transport: McpTransport,
                 allowed_tools: list[str], timeout_seconds: float = 30.0) -> None:
        if not server_name.strip():
            raise ValueError("server_name 不能为空")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds 必须大于 0")
        self.server_name = server_name
        self.transport = transport
        self.allowed_tools = set(allowed_tools)
        self.timeout_seconds = timeout_seconds
        self.initialized = False

    def list_tools(self) -> list[dict[str, Any]]:
        self._initialize()
        result = self._call("tools/list", {})
        tools = result.get("tools") if isinstance(result, dict) else None
        if not isinstance(tools, list):
            raise ValueError("MCP tools/list 必须返回 tools 数组")
        parsed = [self._parse_tool(tool) for tool in tools]
        return [tool for tool in parsed if tool["name"] in self.allowed_tools]

    def create_registry(self) -> ToolRegistry:
        registry = ToolRegistry()
        for definition in self.list_tools():
            remote_name = definition["name"]

            def execute(arguments: dict[str, Any], name=remote_name) -> str:
                result = self._call("tools/call", {"name": name, "arguments": arguments})
                return json.dumps(redact_secrets(result), ensure_ascii=False)

            registry.register(Tool(
                name=f"{self.server_name}__{remote_name}",
                description=definition.get("description") or f"MCP tool {remote_name}",
                input_schema=definition["inputSchema"],
                execute=execute,
            ))
        return registry

    def close(self) -> None:
        self.transport.close()

    def _initialize(self) -> None:
        if self.initialized:
            return
        self._call("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "building-agents-from-scratch", "version": "0.1.0"},
        })
        self.transport.notify("notifications/initialized")
        self.initialized = True

    def _call(self, method: str, params: dict[str, Any]) -> Any:
        request_id = str(uuid.uuid4())
        result_queue: Queue[tuple[bool, Any]] = Queue(maxsize=1)

        def invoke() -> None:
            try:
                result_queue.put((True, self.transport.request(
                    method, params, request_id
                )))
            except BaseException as error:
                result_queue.put((False, error))

        Thread(target=invoke, daemon=True).start()
        try:
            succeeded, value = result_queue.get(timeout=self.timeout_seconds)
        except Empty as error:
            self.transport.notify("notifications/cancelled", {
                "requestId": request_id, "reason": "timed out",
            })
            raise TimeoutError(f"MCP {method} 超过 {self.timeout_seconds} 秒") from error
        if not succeeded:
            raise value
        return value

    @staticmethod
    def _parse_tool(value: Any) -> dict[str, Any]:
        if not isinstance(value, dict) or not isinstance(value.get("name"), str):
            raise ValueError("MCP tool name 必须是字符串")
        schema = value.get("inputSchema")
        if not isinstance(schema, dict) or schema.get("type") != "object":
            raise ValueError(f"MCP tool {value['name']} 必须使用 object inputSchema")
        return value


class StdioMcpTransport:
    """最小 newline-delimited JSON-RPC transport；命令必须由宿主配置。"""

    def __init__(self, command: str, args: list[str] | None = None,
                 cwd: str | None = None) -> None:
        if not command.strip():
            raise ValueError("MCP command 不能为空")
        self.process = subprocess.Popen(
            [command, *(args or [])], cwd=cwd, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self.next_id = 1
        self.lock = Lock()

    def request(self, method: str, params: dict[str, Any],
                request_id: str | int | None = None) -> Any:
        with self.lock:
            if request_id is None:
                request_id = self.next_id
                self.next_id += 1
            self._write({"jsonrpc": "2.0", "id": request_id,
                         "method": method, "params": params})
            if self.process.stdout is None:
                raise RuntimeError("MCP stdout 不可用")
            while True:
                line = self.process.stdout.readline()
                if not line:
                    raise RuntimeError("MCP process 已退出")
                message = json.loads(line)
                if message.get("id") != request_id:
                    continue
                if "error" in message:
                    raise RuntimeError(json.dumps(
                        redact_secrets(message["error"]), ensure_ascii=False
                    ))
                return message.get("result")

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()

    def _write(self, message: dict[str, Any]) -> None:
        if self.process.stdin is None:
            raise RuntimeError("MCP stdin 不可用")
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()


def redact_secrets(value: Any) -> Any:
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if key.lower() in SECRET_KEYS else redact_secrets(item)
            for key, item in value.items()
        }
    return value
