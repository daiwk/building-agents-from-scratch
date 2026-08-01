import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonValue, ModelProvider } from "../src/core/index.js";
import { DurableTaskRunner, SqliteDurableTaskStore, SqliteGraphCheckpointStore } from "../src/durable/index.js";
import { StateGraph } from "../src/graph/index.js";
import { McpClient, StdioMcpTransport, type McpRequestTransport } from "../src/mcp/index.js";
import { ModelRouter } from "../src/routing/index.js";
import { generateStructured } from "../src/structured-output/index.js";
import { closeRuntimeResources, createAgentFromEnvAsync } from "../src/runtime/create-agent.js";

const request = { systemPrompt: "test", messages: [], tools: [] };
const message = (text: string, input = 1, output = 1) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  stopReason: "stop" as const,
  usage: { input, output },
});

describe("Stage 10 MCP", () => {
  it("discovers only allowlisted tools and redacts secret fields", async () => {
    const calls: string[] = [];
    const transport: McpRequestTransport = {
      async request(method) {
        calls.push(method);
        if (method === "initialize") return {};
        if (method === "tools/list") return { tools: [
          { name: "lookup", description: "safe", inputSchema: { type: "object" } },
          { name: "admin", inputSchema: { type: "object" } },
        ] };
        return { content: "ok", token: "should-not-leak" };
      },
    };
    const registry = await new McpClient({
      serverName: "docs", transport, allowedTools: ["lookup"],
    }).createRegistry();
    expect(registry.list().map((tool) => tool.name)).toEqual(["docs__lookup"]);
    const result = await registry.list()[0]!.execute({}, { messages: [] });
    expect(JSON.parse(result)).toEqual({ content: "ok", token: "[REDACTED]" });
    expect(calls).toEqual(["initialize", "tools/list", "tools/call"]);
  });

  it("cancels a timed-out request", async () => {
    let requestId: string | number | undefined;
    let cancelledId: JsonValue | undefined;
    const transport: McpRequestTransport = {
      request(_method, _params, signal, id) {
        requestId = id;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      notify(method, params) {
        if (method === "notifications/cancelled") cancelledId = params?.requestId;
      },
    };
    await expect(new McpClient({
      serverName: "slow", transport, allowedTools: [], timeoutMs: 5,
    }).listTools()).rejects.toThrow("timed out");
    expect(cancelledId).toBe(requestId);
  });

  it("speaks JSON-RPC to a real stdio process", async () => {
    const client = new McpClient({
      serverName: "fixture",
      allowedTools: ["echo"],
      transport: new StdioMcpTransport(
        process.execPath, [join(process.cwd(), "tests/fixtures/mcp-server.mjs")],
      ),
    });
    try {
      const tool = (await client.createRegistry()).list()[0]!;
      expect(JSON.parse(await tool.execute({ value: "hello" }, { messages: [] })))
        .toEqual({ content: "hello" });
    } finally {
      await client.close();
    }
  });

  it("loads allowlisted MCP tools through the CLI runtime", async () => {
    const keys = ["AGENT_MCP_COMMAND", "AGENT_MCP_ARGS", "AGENT_MCP_SERVER_NAME",
      "AGENT_MCP_TOOLS", "AGENT_TOOLS", "MINIMAX_API_KEY"] as const;
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.AGENT_MCP_COMMAND = process.execPath;
      process.env.AGENT_MCP_ARGS = JSON.stringify([
        join(process.cwd(), "tests/fixtures/mcp-server.mjs"),
      ]);
      process.env.AGENT_MCP_SERVER_NAME = "fixture";
      process.env.AGENT_MCP_TOOLS = "echo";
      process.env.AGENT_TOOLS = "fixture__echo";
      process.env.MINIMAX_API_KEY = "test";
      const agent = await createAgentFromEnvAsync("mcp-test");
      expect(agent.context.tools.map((tool) => tool.name)).toEqual(["fixture__echo"]);
    } finally {
      await closeRuntimeResources();
      for (const key of keys) {
        const value = before[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("Stage 11 structured output and routing", () => {
  it("repairs invalid JSON and validates the repaired value", async () => {
    const outputs = ["not-json", '```json{"answer":"ok"}```'];
    const model: ModelProvider = {
      name: "sequence",
      async generate() { return message(outputs.shift()!); },
    };
    const result = await generateStructured<{ answer: string }>(model, request, {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    });
    expect(result.value).toEqual({ answer: "ok" });
    expect(result.repairAttempts).toBe(1);
  });

  it("falls back and keeps generator/judge metrics separate", async () => {
    const broken: ModelProvider = { name: "broken", async generate() { throw new Error("offline"); } };
    const healthy: ModelProvider = { name: "healthy", async generate() { return message("ok", 3, 2); } };
    const router = new ModelRouter([
      { name: "primary", model: broken },
      { name: "fallback", model: healthy },
    ]);
    expect((await router.generate(request, { task: "write", role: "generator" })).routedModel)
      .toBe("fallback");
    await router.generate(request, { task: "score", role: "judge", preferredModel: "fallback" });
    expect(router.snapshotMetrics()).toEqual([
      { role: "generator", model: "primary", requests: 1, successes: 0, failures: 1, inputTokens: 0, outputTokens: 0 },
      { role: "generator", model: "fallback", requests: 1, successes: 1, failures: 0, inputTokens: 3, outputTokens: 2 },
      { role: "judge", model: "fallback", requests: 1, successes: 1, failures: 0, inputTokens: 3, outputTokens: 2 },
    ]);
  });
});

describe("Stage 12 durable runtime", () => {
  it("resumes a graph checkpoint after reopening SQLite", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "durable-")), "runtime.sqlite");
    type State = { approved?: boolean; done?: boolean };
    const firstStore = new SqliteGraphCheckpointStore<State>(file);
    const graph = (store: SqliteGraphCheckpointStore<State>) => new StateGraph<State>(
      undefined, store,
    ).addNode("approval", (_state, context) => {
      if (context.resumeValue !== true) context.interrupt({ question: "approve?" });
      return { approved: true };
    }).addNode("finish", () => ({ done: true }))
      .addEdge("approval", "finish").setStart("approval");
    expect((await graph(firstStore).run({}, { checkpointId: "run-1" })).status).toBe("interrupted");
    firstStore.close();
    const secondStore = new SqliteGraphCheckpointStore<State>(file);
    const resumed = await graph(secondStore).run({}, {
      checkpointId: "run-1", resume: true, resumeValue: true,
    });
    expect(resumed).toMatchObject({ status: "completed", state: { approved: true, done: true } });
    secondStore.close();
  });

  it("persists idempotent tasks and append-only events", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tasks-")), "runtime.sqlite");
    const first = new SqliteDurableTaskStore(file);
    first.enqueue("double", { value: 4 }, "task-1");
    first.enqueue("double", { value: 4 }, "task-1");
    first.enqueue("ordered", { b: 2, a: 1 }, "task-order");
    expect(first.enqueue("ordered", { a: 1, b: 2 }, "task-order").status).toBe("pending");
    first.close();
    const second = new SqliteDurableTaskStore(file);
    const runner = new DurableTaskRunner(second, "worker-1", {
      double: (payload, context) => {
        context.appendEvent("progress", { percent: 50 });
        return { value: Number((payload as { value: JsonValue }).value) * 2 };
      },
    });
    expect(await runner.runNext()).toMatchObject({ status: "completed", result: { value: 8 } });
    expect(second.events("task-1").map((event) => event.type))
      .toEqual(["enqueued", "claimed", "progress", "completed"]);
    second.close();
  });

  it("recovers a running task after its worker lease expires", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "lease-")), "runtime.sqlite");
    const store = new SqliteDurableTaskStore(file);
    store.enqueue("work", {}, "leased-task");
    expect(store.claim("worker-a", 1)?.status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.claim("worker-b")?.workerId).toBe("worker-b");
    expect(store.events("leased-task").map((event) => event.type))
      .toEqual(["enqueued", "claimed", "lease_expired", "claimed"]);
    store.close();
  });
});
