import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage as PiAgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { createPiAgent } from "../examples/pi-agent-direct.js";
import { SqliteConversationStore } from "../src/memory/index.js";

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
    const memoryDatabase = join(directory, "conversations.sqlite3");
    const store = new SqliteConversationStore<PiAgentMessage>(memoryDatabase);
    await store.save("pi-test", [
      {
        role: "user",
        content: "上一轮消息",
        timestamp: Date.now(),
      },
    ]);
    store.close();
    process.env.MINIMAX_CN_API_KEY = "test-key";
    process.env.MINIMAX_MODEL = "MiniMax-M3";
    process.env.AGENT_TOOLS = "calculator,read_file";
    process.env.AGENT_WORKSPACE_ROOT = directory;
    process.env.AGENT_WORKSPACE_ALLOW_WRITE = "false";
    process.env.AGENT_SKILLS = "tool-first";
    process.env.AGENT_SKILLS_DIR = "skills";
    process.env.AGENT_MEMORY_DATABASE = memoryDatabase;
    delete process.env.AGENT_MEMORY_FILE;
    process.env.AGENT_SESSION_ID = "pi-test";
    process.env.AGENT_TOOL_EXECUTION = "parallel";
    delete process.env.PI_AGENT_TOOLS;
    delete process.env.PI_AGENT_SKILLS;
    delete process.env.PI_AGENT_MEMORY_FILE;
    delete process.env.PI_AGENT_MEMORY_DATABASE;
    delete process.env.PI_AGENT_SESSION_ID;
    delete process.env.PI_AGENT_TOOL_EXECUTION;

    const agent = await createPiAgent({ systemPrompt: "候选版本 prompt" });

    expect(agent.state.tools.map((tool) => tool.name)).toEqual(["calculator", "read_file"]);
    expect(agent.state.tools.map((tool) => tool.name)).not.toContain("write_file");
    expect(agent.state.systemPrompt).toContain('<skill name="tool-first">');
    expect(agent.state.systemPrompt).toContain("候选版本 prompt");
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.messages[0]).toMatchObject({
      role: "user",
      content: "上一轮消息",
    });
    expect(agent.toolExecution).toBe("parallel");
  });
});
