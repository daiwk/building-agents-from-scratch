import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Agent,
  InMemoryConversationStore,
  type ModelProvider,
} from "../src/core/index.js";
import {
  JsonFileConversationStore,
  SqliteMemoryIndex,
  SqliteConversationStore,
} from "../src/memory/index.js";
import {
  SkillCatalog,
  applySkillsToSystemPrompt,
  loadSkillsFromDirectory,
  parseSkillMarkdown,
} from "../src/skills/index.js";
import {
  ToolRegistry,
  calculatorTool,
  createBuiltinToolRegistry,
} from "../src/tools/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ToolRegistry", () => {
  it("loads only explicitly selected tools in the requested order", () => {
    const registry = createBuiltinToolRegistry();

    expect(registry.select(["current_time", "calculator"]).map((tool) => tool.name))
      .toEqual(["current_time", "calculator"]);
    expect(registry.list()).toHaveLength(2);
  });

  it("rejects duplicate and unknown tools", () => {
    const registry = new ToolRegistry().register(calculatorTool);

    expect(() => registry.register(calculatorTool)).toThrow(
      "Tool is already registered",
    );
    expect(() => registry.select(["shell"])).toThrow("Unknown tool: shell");
  });
});

describe("ConversationStore", () => {
  it("loads previous messages into Agent and saves the next turn", async () => {
    const store = new InMemoryConversationStore();
    await store.save("lesson", [
      { role: "user", content: "我叫小明" },
      {
        role: "assistant",
        content: [{ type: "text", text: "你好，小明" }],
        stopReason: "stop",
      },
    ]);
    const generate = vi.fn(async (request) => {
      expect(request.messages[0]).toMatchObject({
        role: "user",
        content: "我叫小明",
      });
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "我记得你" }],
        stopReason: "stop" as const,
      };
    });
    const model: ModelProvider = { name: "memory-test", generate };
    const agent = new Agent({
      model,
      memory: { sessionId: "lesson", store },
    });

    for await (const _event of agent.run("你还记得我吗？")) {
      // Consume all events.
    }

    expect(generate).toHaveBeenCalledOnce();
    expect(await store.load("lesson")).toHaveLength(4);

    await agent.reset();
    expect(await store.load("lesson")).toEqual([]);
  });

  it("persists conversations in an atomic JSON file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-memory-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "conversations.json");
    const firstStore = new JsonFileConversationStore(filePath);
    await firstStore.save("web-1", [{ role: "user", content: "持久化" }]);

    const secondStore = new JsonFileConversationStore(filePath);
    expect(await secondStore.load("web-1")).toEqual([
      { role: "user", content: "持久化" },
    ]);
    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
    };
    expect(raw.version).toBe(1);
  });

  it("isolates, replaces, and clears sessions in SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-memory-sqlite-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "conversations.sqlite3");
    const firstStore = new SqliteConversationStore(databasePath);
    await firstStore.save("web-1", [
      { role: "user", content: "第一版" },
    ]);
    await firstStore.save("web-2", [
      { role: "user", content: "另一个会话" },
    ]);
    await firstStore.save("web-1", [
      { role: "user", content: "覆盖后" },
    ]);
    firstStore.close();

    const secondStore = new SqliteConversationStore(databasePath);
    expect(await secondStore.load("web-1")).toEqual([
      { role: "user", content: "覆盖后" },
    ]);
    expect(await secondStore.load("web-2")).toEqual([
      { role: "user", content: "另一个会话" },
    ]);
    await secondStore.clear("web-1");
    expect(await secondStore.load("web-1")).toEqual([]);
    expect(await secondStore.load("web-2")).toHaveLength(1);
    secondStore.close();
  });
});

describe("SqliteMemoryIndex", () => {
  it("persists typed memories across index instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-memory-index-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "memory-index.sqlite3");
    const first = new SqliteMemoryIndex(path);
    await first.upsert({
      id: "preference",
      kind: "semantic",
      content: "用户喜欢中文回答",
      createdAtUnixMs: 1,
    });
    first.close();

    const second = new SqliteMemoryIndex(path);
    expect((await second.search("喜欢中文"))[0]?.id).toBe("preference");
    second.close();
  });
});

describe("SkillCatalog", () => {
  it("reads repository SKILL.md files without executing anything", () => {
    const skills = loadSkillsFromDirectory("skills");

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "tool-first",
      description: expect.stringContaining("优先使用"),
    });
    expect(skills[0]?.instructions).toContain("先检查可用工具");
  });

  it("selects skills and injects bounded instructions", () => {
    const skill = parseSkillMarkdown(
      [
        "---",
        "name: concise",
        "description: 简洁回答",
        "---",
        "",
        "回答不超过三句话。",
      ].join("\n"),
      "virtual/SKILL.md",
    );
    const catalog = new SkillCatalog().register(skill);

    const prompt = applySkillsToSystemPrompt(
      "你是助手。",
      catalog.select(["concise"]),
    );

    expect(prompt).toContain('<skill name="concise">');
    expect(prompt).toContain("回答不超过三句话。");
    expect(() => catalog.select(["missing"])).toThrow("Unknown skill");
  });
});
