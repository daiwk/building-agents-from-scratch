import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, type ModelProvider, type UserContent } from "../src/core/index.js";
import { HybridRetriever } from "../src/retrieval/index.js";
import { InMemoryArtifactStore } from "../src/artifacts/index.js";
import { createWebServer } from "../src/web/server.js";

const servers: ReturnType<typeof createWebServer>[] = [];
afterEach(async () => Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("Stage 13 retrieval", () => {
  it("returns a snippet with a stable source citation", async () => {
    const retriever = new HybridRetriever();
    await retriever.ingest([
      { id: "guide", title: "Agent 指南", text: "Memory 保存历史。\nTool 由宿主执行。", uri: "/guide" },
    ]);
    const [hit] = await retriever.search("谁执行 Tool");
    expect(hit?.snippet).toContain("宿主执行");
    expect(hit?.citation).toMatchObject({ sourceId: "guide", title: "Agent 指南", uri: "/guide" });
    expect(hit?.citation.start).toBe(0);
  });
});

describe("Stage 14 multimodal artifacts", () => {
  it("rejects executable content and hashes accepted artifacts", () => {
    const store = new InMemoryArtifactStore(20);
    expect(() => store.create("bad.sh", "application/x-sh", Buffer.from("echo bad"))).toThrow("Unsupported");
    expect(store.create("note.txt", "text/plain", Buffer.from("hello")).sha256).toHaveLength(64);
  });

  it("uploads an image and passes it to the model as a content block", async () => {
    let received: UserContent | undefined;
    const model: ModelProvider = {
      name: "capture",
      async generate(request) {
        const last = request.messages.at(-1);
        received = last?.role === "user" ? last.content : undefined;
        return { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
      },
    };
    const server = createWebServer({ createAgent: () => new Agent({ model }), providerName: model.name });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const upload = await fetch(`${base}/api/artifacts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pixel.png", mimeType: "image/png", dataBase64: Buffer.from("png").toString("base64") }),
    });
    const artifact = await upload.json() as { id: string; sha256: string };
    expect(upload.status).toBe(201);
    expect(artifact.sha256).toHaveLength(64);
    const chat = await fetch(`${base}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "看图", artifactIds: [artifact.id] }),
    });
    await chat.text();
    expect(received).toEqual([
      { type: "text", text: "看图" },
      { type: "image", source: { type: "base64", mediaType: "image/png", data: Buffer.from("png").toString("base64") } },
    ]);
    const preview = await fetch(`${base}/api/artifacts/${artifact.id}`);
    expect(preview.headers.get("content-type")).toBe("image/png");
  });
});
