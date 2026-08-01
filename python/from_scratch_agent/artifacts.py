"""安全的教学制品仓库；上传内容只作为数据保存，不会执行。"""

import hashlib
import uuid
from dataclasses import dataclass

ALLOWED_TYPES = {"text/plain", "text/markdown", "application/json", "image/png", "image/jpeg", "image/webp"}


@dataclass(frozen=True)
class Artifact:
    id: str
    name: str
    mime_type: str
    data: bytes
    sha256: str


class InMemoryArtifactStore:
    def __init__(self, max_bytes: int = 2 * 1024 * 1024) -> None:
        self.max_bytes = max_bytes
        self._items: dict[str, Artifact] = {}

    def create(self, name: str, mime_type: str, data: bytes) -> Artifact:
        if mime_type not in ALLOWED_TYPES:
            raise ValueError("Unsupported artifact type")
        if not data or len(data) > self.max_bytes:
            raise ValueError("Artifact size is invalid")
        artifact = Artifact(str(uuid.uuid4()), name[:120], mime_type, bytes(data), hashlib.sha256(data).hexdigest())
        self._items[artifact.id] = artifact
        return artifact

    def get(self, artifact_id: str) -> Artifact | None:
        return self._items.get(artifact_id)
