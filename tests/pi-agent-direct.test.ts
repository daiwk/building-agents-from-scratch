import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage as PiAgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { createPiAgent } from "../examples/pi-agent-direct.js";
import { JsonFileConversationStore } from "../src/memory/index.js";

const temporaryDirectories: string[] = [];
const originalEnvironment = { ...process.env };

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("pi-agent feature parity", () => {
  it("loads selected tools, skills, and persisted messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-agent-memory-"));
    temporaryDirectories.push(directory);
    const memoryFile = join(directory, "conversations.json");
    const store = new JsonFileConversationStore<PiAgentMessage>(memoryFile);
    await store.save("pi-test", [
      {
        role: "user",
        content: "上一轮消息",
        timestamp: Date.now(),
      },
    ]);
    process.env.MINIMAX_CN_API_KEY = "test-key";
    process.env.MINIMAX_MODEL = "MiniMax-M3";
    process.env.AGENT_TOOLS = "calculator";
    process.env.AGENT_SKILLS = "tool-first";
    process.env.AGENT_SKILLS_DIR = "skills";
    process.env.AGENT_MEMORY_FILE = memoryFile;
    process.env.AGENT_SESSION_ID = "pi-test";
    delete process.env.PI_AGENT_TOOLS;
    delete process.env.PI_AGENT_SKILLS;
    delete process.env.PI_AGENT_MEMORY_FILE;
    delete process.env.PI_AGENT_SESSION_ID;

    const agent = await createPiAgent();

    expect(agent.state.tools.map((tool) => tool.name)).toEqual(["calculator"]);
    expect(agent.state.systemPrompt).toContain('<skill name="tool-first">');
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.messages[0]).toMatchObject({
      role: "user",
      content: "上一轮消息",
    });
  });
});
