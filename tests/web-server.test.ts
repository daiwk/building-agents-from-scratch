import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  Agent,
  InMemoryConversationStore,
  type ModelProvider,
} from "../src/core/index.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      },
    ),
  );
});

describe("web server", () => {
  it("serves the UI and health endpoint", async () => {
    const { server, baseUrl } = await startTestServer();

    const health = await fetch(`${baseUrl}/api/health`);
    expect(await health.json()).toEqual({ ok: true, provider: "test-model" });

    const page = await fetch(baseUrl);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("Agent Observatory");
    expect(await (await fetch(`${baseUrl}/styles.css`)).text()).toContain(
      ".activity-bar",
    );
    expect(server.listening).toBe(true);
  });

  it("serves the component playground and runs deterministic demos", async () => {
    const { baseUrl } = await startTestServer();
    const page = await fetch(`${baseUrl}/playground.html`);
    expect(await page.text()).toContain("Component Lab");
    const catalog = await (await fetch(`${baseUrl}/api/playground/demos`)).json() as {
      demos: { id: string }[];
    };
    expect(catalog.demos.map((item) => item.id)).toContain("evolution");
    expect(catalog.demos.map((item) => item.id)).toEqual(expect.arrayContaining([
      "mcp", "structured", "durable",
    ]));
    const run = await fetch(`${baseUrl}/api/playground/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ demo: "graph" }),
    });
    const result = await run.json() as { id: string; result: { state: { total: number } } };
    expect(result).toMatchObject({ id: "graph", result: { state: { total: 23 } } });
    const durable = await fetch(`${baseUrl}/api/playground/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ demo: "durable" }),
    });
    expect(await durable.json()).toMatchObject({
      id: "durable", result: { status: "completed", result: { value: 10 } },
    });
  });

  it("streams agent events as NDJSON", async () => {
    const { baseUrl } = await startTestServer();
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "你好" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );

    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; text?: string });
    expect(events[0]?.type).toBe("session");
    expect(events.some((event) => event.type === "agentStart")).toBe(true);
    expect(events.some((event) => event.type === "message")).toBe(false);
    expect(events.some((event) => event.type === "thinking")).toBe(false);
    expect(events).toContainEqual({ type: "textDelta", delta: "测试" });
    expect(events).toContainEqual({ type: "textDelta", delta: "回答" });
    expect(events.some((event) => event.type === "text")).toBe(false);
    expect(events).toContainEqual({
      type: "usage",
      usage: { input: 3, output: 2 },
      totals: {
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 5,
      },
    });
    expect(events.some((event) => event.type === "agentEnd")).toBe(true);
  });

  it("uses the browser session id for memory and clears it on reset", async () => {
    const store = new InMemoryConversationStore();
    const model: ModelProvider = {
      name: "memory-model",
      async generate() {
        return {
          role: "assistant",
          content: [{ type: "text", text: "记住了" }],
          stopReason: "stop",
        };
      },
    };
    const server = createWebServer({
      createAgent: (sessionId = "fallback") =>
        new Agent({
          model,
          memory: { sessionId, store },
        }),
      providerName: model.name,
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "记住我", sessionId: "browser-1" }),
    });
    await chat.text();
    expect(await store.load("browser-1")).toHaveLength(2);

    const reset = await fetch(`${baseUrl}/api/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "browser-1" }),
    });
    expect(reset.status).toBe(200);
    expect(await store.load("browser-1")).toEqual([]);
  });
});

async function startTestServer() {
  const model: ModelProvider = {
    name: "test-model",
    async generate() {
      return {
        role: "assistant",
        content: [{ type: "text", text: "测试回答" }],
        stopReason: "stop",
        usage: { input: 3, output: 2 },
      };
    },
    async *stream() {
      yield { type: "textDelta", delta: "测试" };
      yield { type: "textDelta", delta: "回答" };
      return {
        role: "assistant",
        content: [{ type: "text", text: "测试回答" }],
        stopReason: "stop",
        usage: { input: 3, output: 2 },
      };
    },
  };
  const server = createWebServer({
    createAgent: () => new Agent({ model }),
    providerName: model.name,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}
