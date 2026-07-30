import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Agent, type ModelProvider } from "../src/core/index.js";
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
    expect(events).toContainEqual({ type: "text", text: "测试回答" });
    expect(events.some((event) => event.type === "agentEnd")).toBe(true);
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
