"""安全的教学制品仓库；上传内容只作为数据保存，不会执行。"""

import hashlib
import uuid
from dataclasses import dataclass

ALLOWED_TYPES = {"text/plain", "text/markdown", "application/json", "image/png", "image/jpeg", "image/webp"}


@dataclass(frozen=True)
class Artifact:
    id: str
    tenant_id: str
    name: str
    mime_type: str
    data: bytes
    sha256: str


class InMemoryArtifactStore:
    def __init__(self, max_bytes: int = 2 * 1024 * 1024) -> None:
        self.max_bytes = max_bytes
        self._items: dict[str, Artifact] = {}

    def create(self, tenant_id: str, name: str, mime_type: str, data: bytes) -> Artifact:
        if mime_type not in ALLOWED_TYPES:
            raise ValueError("Unsupported artifact type")
        if not data or len(data) > self.max_bytes:
            raise ValueError("Artifact size is invalid")
        if not tenant_id or len(tenant_id) > 120:
            raise ValueError("Invalid tenant id")
        artifact = Artifact(str(uuid.uuid4()), tenant_id, name[:120], mime_type, bytes(data), hashlib.sha256(data).hexdigest())
        self._items[artifact.id] = artifact
        return artifact

    def get(self, tenant_id: str, artifact_id: str) -> Artifact | None:
        artifact = self._items.get(artifact_id)
        return artifact if artifact and artifact.tenant_id == tenant_id else None
