import tempfile
import unittest
from pathlib import Path

from from_scratch_agent.artifacts import InMemoryArtifactStore
from from_scratch_agent.security import (
    ApiKeyAuthenticator,
    ApiKeyIdentity,
    EnvironmentSecretProvider,
    InMemoryAuditSink,
    Principal,
    SecurityError,
    authorize,
    hash_api_key,
    scope_tenant_session_id,
)


class Stage15SecurityTests(unittest.TestCase):
    def test_auth_rbac_and_tenant_artifacts(self):
        key = "python-secret-key-0001"
        auth = ApiKeyAuthenticator([ApiKeyIdentity("a", "alice", "tenant-a", ("user",), hash_api_key(key))])
        principal = auth.authenticate(f"Bearer {key}")
        self.assertEqual(principal.tenant_id, "tenant-a")
        with self.assertRaises(SecurityError):
            authorize(principal, "audit:read")
        store = InMemoryArtifactStore()
        artifact = store.create("tenant-a", "a.txt", "text/plain", b"private")
        self.assertIsNone(store.get("tenant-b", artifact.id))
        self.assertNotEqual(
            scope_tenant_session_id("tenant-a", "same"),
            scope_tenant_session_id("tenant-b", "same"),
        )

    def test_file_secret_and_tenant_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "secret"
            path.write_text("from-file\n", encoding="utf-8")
            provider = EnvironmentSecretProvider({"MINIMAX_API_KEY_FILE": str(path)})
            self.assertEqual(provider.require("MINIMAX_API_KEY"), "from-file")
        audit = InMemoryAuditSink()
        audit.write(tenant_id="a", subject="alice", action="chat.run", outcome="success")
        audit.write(tenant_id="b", subject="bob", action="chat.run", outcome="success")
        self.assertEqual([event.tenant_id for event in audit.list("a")], ["a"])


if __name__ == "__main__":
    unittest.main()
