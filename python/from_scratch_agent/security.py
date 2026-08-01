"""Stage 15 教学安全边界：认证、RBAC、密钥与租户审计。"""

import hashlib
import hmac
import json
import os
import re
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROLE_PERMISSIONS = {
    "user": {"chat:run", "artifact:write", "artifact:read", "session:reset", "tool:calculator", "tool:current_time", "tool:search_knowledge"},
    "builder": {"chat:run", "artifact:write", "artifact:read", "session:reset", "tool:*", "skill:*", "resource:*"},
    "auditor": {"audit:read"},
    "admin": {"*"},
}


@dataclass(frozen=True)
class Principal:
    subject: str
    tenant_id: str
    roles: tuple[str, ...]


@dataclass(frozen=True)
class ApiKeyIdentity:
    id: str
    subject: str
    tenant_id: str
    roles: tuple[str, ...]
    sha256: str


class SecurityError(RuntimeError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def hash_api_key(api_key: str) -> str:
    if len(api_key) < 16:
        raise ValueError("API keys must contain at least 16 characters")
    return hashlib.sha256(api_key.encode()).hexdigest()


def scope_tenant_session_id(tenant_id: str, session_id: str) -> str:
    digest = hashlib.sha256()
    digest.update(tenant_id.encode())
    digest.update(b"\0")
    digest.update(session_id.encode())
    return digest.hexdigest()


class ApiKeyAuthenticator:
    def __init__(self, identities: list[ApiKeyIdentity]) -> None:
        if not identities:
            raise ValueError("At least one API key identity is required")
        self.identities = identities
        for identity in identities:
            if not re.fullmatch(r"[a-f0-9]{64}", identity.sha256):
                raise ValueError("Identity sha256 must be lowercase hex")
            if not identity.roles or any(role not in ROLE_PERMISSIONS for role in identity.roles):
                raise ValueError("Identity contains an unknown role")

    def authenticate(self, authorization: str | None) -> Principal:
        match = re.fullmatch(r"Bearer\s+(\S+)", authorization or "", re.IGNORECASE)
        if not match:
            raise SecurityError("Bearer API key is required", 401)
        candidate = hashlib.sha256(match.group(1).encode()).hexdigest()
        matched = None
        # 扫描全部 identity，避免匹配位置直接反映在响应时间里。
        for identity in self.identities:
            if hmac.compare_digest(candidate, identity.sha256):
                matched = identity
        if not matched:
            raise SecurityError("Invalid API key", 401)
        return Principal(matched.subject, matched.tenant_id, matched.roles)


def create_authenticator_from_environment(
    environment: dict[str, str] | None = None,
) -> ApiKeyAuthenticator | None:
    """读取与 TypeScript Web 共用的 hashed identity JSON；未配置表示本地模式。"""
    source = environment if environment is not None else os.environ
    config_path = source.get("AGENT_AUTH_CONFIG", "").strip()
    if not config_path:
        return None
    raw = json.loads(Path(config_path).read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("AGENT_AUTH_CONFIG must contain a JSON array")
    return ApiKeyAuthenticator([
        ApiKeyIdentity(
            item["id"], item["subject"], item["tenantId"],
            tuple(item["roles"]), item["sha256"],
        )
        for item in raw
    ])


def authorize(principal: Principal, permission: str) -> None:
    for role in principal.roles:
        for pattern in ROLE_PERMISSIONS.get(role, set()):
            if pattern == "*" or pattern == permission or (pattern.endswith("*") and permission.startswith(pattern[:-1])):
                return
    raise SecurityError(f"Permission denied: {permission}", 403)


class EnvironmentSecretProvider:
    """读取 ENV 或 *_FILE；不提供列举方法，避免无意暴露全部 secret。"""

    def __init__(self, environment: dict[str, str] | None = None) -> None:
        self.environment = environment if environment is not None else os.environ

    def get(self, name: str) -> str | None:
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
            raise ValueError("Invalid secret name")
        file_path = self.environment.get(f"{name}_FILE", "").strip()
        value = Path(file_path).read_text(encoding="utf-8").strip() if file_path else self.environment.get(name)
        return value or None

    def require(self, name: str) -> str:
        value = self.get(name)
        if not value:
            raise RuntimeError(f"Required secret is unavailable: {name}")
        return value


@dataclass(frozen=True)
class AuditEvent:
    id: str
    timestamp: str
    tenant_id: str
    subject: str
    action: str
    outcome: str
    resource_type: str | None = None
    resource_id: str | None = None
    metadata: dict[str, Any] | None = None


class InMemoryAuditSink:
    def __init__(self) -> None:
        self.events: list[AuditEvent] = []

    def write(self, *, tenant_id: str, subject: str, action: str, outcome: str, **kwargs: Any) -> AuditEvent:
        event = AuditEvent(str(uuid.uuid4()), datetime.now(timezone.utc).isoformat(), tenant_id, subject, action, outcome, **kwargs)
        self.events.append(event)
        return event

    def list(self, tenant_id: str, limit: int = 100) -> list[AuditEvent]:
        return [event for event in self.events if event.tenant_id == tenant_id][-limit:]


class JsonlAuditSink(InMemoryAuditSink):
    def __init__(self, path: str | Path) -> None:
        super().__init__()
        self.path = Path(path)

    def write(self, **kwargs: Any) -> AuditEvent:
        event = super().write(**kwargs)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(asdict(event), ensure_ascii=False) + "\n")
        os.chmod(self.path, 0o600)
        return event


def create_audit_sink_from_environment(
    environment: dict[str, str] | None = None,
) -> InMemoryAuditSink:
    source = environment if environment is not None else os.environ
    path = source.get("AGENT_AUDIT_FILE", "").strip()
    return JsonlAuditSink(path) if path else InMemoryAuditSink()
