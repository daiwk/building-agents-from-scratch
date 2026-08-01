import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, InMemoryConversationStore, type ModelProvider } from "../src/core/index.js";
import { InMemoryArtifactStore } from "../src/artifacts/index.js";
import {
  ApiKeyAuthenticator,
  InMemoryAuditSink,
  EnvironmentSecretProvider,
  JsonlAuditSink,
  SecurityError,
  authorize,
  hashApiKey,
  scopeTenantSessionId,
} from "../src/security/index.js";
import { assertSafeBind, createWebServer } from "../src/web/server.js";
import { createAgentFromEnv } from "../src/runtime/create-agent.js";

const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
})));

const keys = {
  alice: "alice-secret-key-0001",
  aliceAudit: "alice-audit-key-0002",
  bob: "bob-secret-key-000003",
};

function authenticator() {
  return new ApiKeyAuthenticator([
    { id: "alice", subject: "alice", tenantId: "tenant-a", roles: ["user"], sha256: hashApiKey(keys.alice) },
    { id: "alice-audit", subject: "auditor", tenantId: "tenant-a", roles: ["auditor"], sha256: hashApiKey(keys.aliceAudit) },
    { id: "bob", subject: "bob", tenantId: "tenant-b", roles: ["builder"], sha256: hashApiKey(keys.bob) },
  ]);
}

describe("Stage 15 authentication and RBAC", () => {
  it("authenticates hashed bearer keys and enforces capability permissions", () => {
    const auth = authenticator();
    expect(auth.authenticate(`Bearer ${keys.alice}`).tenantId).toBe("tenant-a");
    expect(() => auth.authenticate("Bearer wrong")).toThrow(SecurityError);
    expect(() => authorize(auth.authenticate(`Bearer ${keys.alice}`), "audit:read")).toThrow("Permission denied");
    expect(() => authorize(auth.authenticate(`Bearer ${keys.alice}`), "tool:shell")).toThrow("Permission denied");
    expect(() => authorize(auth.authenticate(`Bearer ${keys.bob}`), "tool:calculator")).not.toThrow();
  });

  it("hides artifacts belonging to another tenant", () => {
    const store = new InMemoryArtifactStore();
    const artifact = store.create("tenant-a", "note.txt", "text/plain", Buffer.from("private"));
    expect(store.get("tenant-a", artifact.id)?.data.toString()).toBe("private");
    expect(store.get("tenant-b", artifact.id)).toBeUndefined();
  });

  it("loads file-mounted secrets and persists tenant-scoped audit events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-security-"));
    const secretPath = join(directory, "minimax");
    writeFileSync(secretPath, "file-secret\n", { mode: 0o600 });
    const secrets = new EnvironmentSecretProvider({ MINIMAX_API_KEY_FILE: secretPath });
    expect(secrets.require("MINIMAX_API_KEY")).toBe("file-secret");
    const audit = new JsonlAuditSink(join(directory, "nested", "audit.jsonl"));
    await audit.write({ tenantId: "a", subject: "alice", action: "chat.run", outcome: "success" });
    await audit.write({ tenantId: "b", subject: "bob", action: "chat.run", outcome: "success" });
    expect((await audit.list("a")).map((event) => event.subject)).toEqual(["alice"]);
  });

  it("enforces the same tool RBAC inside the Agent assembly layer", () => {
    const beforeKey = process.env.MINIMAX_API_KEY;
    const beforeTools = process.env.AGENT_TOOLS;
    try {
      process.env.MINIMAX_API_KEY = "test-key";
      process.env.AGENT_TOOLS = "calculator";
      expect(createAgentFromEnv("user-session", {
        subject: "alice", tenantId: "tenant-a", roles: ["user"],
      }).context.tools.map((tool) => tool.name)).toEqual(["calculator"]);
      expect(() => createAgentFromEnv("audit-session", {
        subject: "auditor", tenantId: "tenant-a", roles: ["auditor"],
      })).toThrow("Permission denied: tool:calculator");
    } finally {
      if (beforeKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = beforeKey;
      if (beforeTools === undefined) delete process.env.AGENT_TOOLS;
      else process.env.AGENT_TOOLS = beforeTools;
    }
  });

  it("refuses a public bind when authentication is not configured", () => {
    expect(() => assertSafeBind("0.0.0.0", undefined)).toThrow("Refusing");
    expect(() => assertSafeBind("0.0.0.0", "deploy/auth.json")).not.toThrow();
    expect(() => assertSafeBind("127.0.0.1", undefined)).not.toThrow();
  });
});

describe("Stage 15 secured Web boundary", () => {
  it("isolates sessions/artifacts/audits by tenant and rejects missing credentials", async () => {
    const store = new InMemoryConversationStore();
    const audit = new InMemoryAuditSink();
    const model: ModelProvider = {
      name: "secure-test",
      async generate() {
        return { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
      },
    };
    const server = createWebServer({
      authenticator: authenticator(), audit, providerName: model.name,
      createAgent: (sessionId = "missing") => new Agent({ model, memory: { sessionId, store } }),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = (key: string) => ({ "content-type": "application/json", authorization: `Bearer ${key}` });

    expect((await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"message":"x"}' })).status).toBe(401);
    for (const key of [keys.alice, keys.bob]) {
      const response = await fetch(`${base}/api/chat`, {
        method: "POST", headers: headers(key), body: JSON.stringify({ message: "private prompt", sessionId: "same" }),
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(await store.load(scopeTenantSessionId("tenant-a", "same"))).toHaveLength(2);
    expect(await store.load(scopeTenantSessionId("tenant-b", "same"))).toHaveLength(2);

    const upload = await fetch(`${base}/api/artifacts`, {
      method: "POST", headers: headers(keys.alice),
      body: JSON.stringify({ name: "a.txt", mimeType: "text/plain", dataBase64: Buffer.from("tenant-a-only").toString("base64") }),
    });
    const artifact = await upload.json() as { id: string };
    expect((await fetch(`${base}/api/artifacts/${artifact.id}`, { headers: { authorization: `Bearer ${keys.bob}` } })).status).toBe(404);
    expect((await fetch(`${base}/api/chat`, {
      method: "POST", headers: headers(keys.bob),
      body: JSON.stringify({ message: "steal", artifactIds: [artifact.id] }),
    })).status).toBe(404);

    const auditResponse = await fetch(`${base}/api/audit`, { headers: { authorization: `Bearer ${keys.aliceAudit}` } });
    const events = (await auditResponse.json() as { events: { tenantId: string; action: string; metadata?: object }[] }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.tenantId === "tenant-a")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private prompt");
    expect((await fetch(`${base}/api/audit`, { headers: { authorization: `Bearer ${keys.alice}` } })).status).toBe(403);
  });
});
