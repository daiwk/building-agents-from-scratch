import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  ExtractiveSummaryProvider,
  RecentContextBuilder,
  TokenContextBuilder,
  type AgentContext,
  type ModelProvider,
} from "../src/core/index.js";
import {
  InMemoryMemoryIndex,
  type MemoryRecord,
} from "../src/memory/index.js";
import {
  ModelSkillRouter,
  SkillCatalog,
  assertSkillToolsAvailable,
  createDynamicSkillHook,
  parseSkillMarkdown,
} from "../src/skills/index.js";
import { agentAsTool } from "../src/subagents/index.js";

describe("RecentContextBuilder", () => {
  it("keeps the newest complete turn without deleting full history", () => {
    const context: AgentContext = {
      systemPrompt: "system",
      tools: [],
      messages: [
        { role: "user", content: "旧问题" },
        {
          role: "assistant",
          content: [{ type: "text", text: "旧回答" }],
          stopReason: "stop",
        },
        { role: "user", content: "新问题" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "calculator",
              arguments: {},
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "calculator",
          content: "42",
          isError: false,
        },
      ],
    };

    const built = new RecentContextBuilder({
      maxMessages: 1,
      maxCharacters: 10_000,
    }).build(context);

    expect(built.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(context.messages).toHaveLength(5);
  });

  it("is used by Agent for each model request", async () => {
    const generate = vi.fn(async (request) => {
      expect(request.messages).toEqual([
        { role: "user", content: "当前问题" },
      ]);
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "当前回答" }],
        stopReason: "stop" as const,
      };
    });
    const model: ModelProvider = { name: "context-test", generate };
    const agent = new Agent({
      model,
      contextBuilder: new RecentContextBuilder({
        maxMessages: 1,
        maxCharacters: 10_000,
      }),
    });
    agent.context.messages.push(
      { role: "user", content: "旧问题" },
      {
        role: "assistant",
        content: [{ type: "text", text: "旧回答" }],
        stopReason: "stop",
      },
    );

    for await (const _event of agent.run("当前问题")) {
      // Consume all events.
    }

    expect(generate).toHaveBeenCalledOnce();
    // ContextBuilder 只影响请求快照，Agent 仍保留完整四条历史。
    expect(agent.context.messages).toHaveLength(4);
  });
});

describe("advanced memory", () => {
  it("uses an injected token counter and summarizes omitted complete turns", async () => {
    const context: AgentContext = {
      systemPrompt: "system",
      tools: [],
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" },
        { role: "user", content: "new" },
      ],
    };
    const built = await new TokenContextBuilder({
      maxTokens: 8,
      tokenCounter: {
        count: (text) => {
          if (text === "[]") return 0;
          if (text.includes("old")) return 7;
          return Math.min(text.length, 2);
        },
      },
      summarizer: new ExtractiveSummaryProvider(),
    }).build(context);

    expect(built.messages).toEqual([{ role: "user", content: "new" }]);
    expect(built.systemPrompt).toContain("conversation_summary");
    expect(context.messages).toHaveLength(3);
  });

  it("retrieves typed memories with deterministic ranking and filters", async () => {
    const index = new InMemoryMemoryIndex();
    const records: MemoryRecord[] = [
      { id: "fact", kind: "semantic", content: "用户喜欢蓝色", createdAtUnixMs: 1 },
      { id: "event", kind: "episodic", content: "昨天讨论红色", createdAtUnixMs: 2 },
      { id: "rule", kind: "procedural", content: "回答颜色问题要简洁", createdAtUnixMs: 3 },
    ];
    for (const record of records) await index.upsert(record);

    expect((await index.search("用户喜欢什么颜色", { kinds: ["semantic"] }))[0]?.id)
      .toBe("fact");
    await index.remove("fact");
    expect(await index.search("蓝")).toEqual([]);
  });
});

describe("dynamic Skill discovery", () => {
  it("discovers by description and rebuilds the prompt from its base", async () => {
    const concise = parseSkillMarkdown(
      [
        "---",
        "name: concise",
        "description: 用简洁方式回答问题",
        "---",
        "",
        "回答不超过三句话。",
      ].join("\n"),
      "virtual/concise/SKILL.md",
    );
    const calculator = parseSkillMarkdown(
      [
        "---",
        "name: math",
        "description: 进行精确数学计算",
        "---",
        "",
        "计算时必须使用工具。",
      ].join("\n"),
      "virtual/math/SKILL.md",
    );
    const catalog = new SkillCatalog().registerMany([
      concise,
      calculator,
    ]);
    expect(catalog.discover("请用简洁方式回答", { limit: 1 })).toEqual([
      concise,
    ]);

    const hooks = createDynamicSkillHook({
      basePrompt: "你是助手。",
      catalog,
      maxSkills: 1,
    });
    const context: AgentContext = {
      systemPrompt: "旧 prompt",
      messages: [{ role: "user", content: "请简洁说明" }],
      tools: [],
    };
    await hooks.beforeModel?.(context);

    expect(context.systemPrompt).toContain('<skill name="concise">');
    expect(context.systemPrompt).not.toContain("旧 prompt");
  });

  it("resolves dependencies and constrains model-selected names", async () => {
    const base = parseSkillMarkdown(
      "---\nname: base\ndescription: 基础格式\nversion: 1.2.0\n---\n基础规则。",
      "virtual/base/SKILL.md",
    );
    const child = parseSkillMarkdown(
      "---\nname: child\ndescription: 专业分析\ndependencies: base\ntags: 分析, research\ntools: calculator\n---\n执行分析。",
      "virtual/child/SKILL.md",
    );
    const catalog = new SkillCatalog().registerMany([base, child]);
    expect(catalog.select(["child"]).map((skill) => skill.name)).toEqual(["base", "child"]);
    expect(child.requiredTools).toEqual(["calculator"]);
    expect(() => assertSkillToolsAvailable([child], [])).toThrow("unavailable tools");
    const router = new ModelSkillRouter(async () => ["child", "unknown"]);
    await expect(catalog.route("分析", router, 1)).resolves.toEqual([base, child]);
    expect(catalog.discover("请做专业分析", { limit: 1 })[0]?.name).toBe("child");
  });
});

describe("agentAsTool", () => {
  it("runs an isolated child Agent and returns its final text", async () => {
    const controller = new AbortController();
    const childGenerate = vi.fn(async (request) => {
      expect(request.messages).toEqual([
        { role: "user", content: "分析这段材料" },
      ]);
      // ModelCallPolicy 会创建子 AbortSignal，但仍会转发父级取消。
      expect(request.signal).toBeDefined();
      expect(request.signal?.aborted).toBe(false);
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "子任务完成" }],
        stopReason: "stop" as const,
      };
    });
    const childModel: ModelProvider = {
      name: "child",
      generate: childGenerate,
    };
    const createAgent = vi.fn(
      () => new Agent({ model: childModel, maxTurns: 2 }),
    );
    const tool = agentAsTool({
      name: "researcher",
      description: "委派一个独立研究任务",
      createAgent,
    });

    const result = await tool.execute(
      { task: "分析这段材料" },
      {
        messages: [{ role: "user", content: "父 Agent 的私有历史" }],
        signal: controller.signal,
      },
    );

    expect(result).toBe("子任务完成");
    expect(createAgent).toHaveBeenCalledOnce();
    expect(childGenerate).toHaveBeenCalledOnce();
  });
});
