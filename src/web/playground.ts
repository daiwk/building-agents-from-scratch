import { Agent, RecentContextBuilder, type AgentContext, type ModelProvider } from "../core/index.js";
import { compareArtifacts, EvolutionController, InMemoryArtifactStore } from "../evolution/index.js";
import { TraceReplayEvaluator, toEvalCases, type ReplayEvalCase } from "../evals/index.js";
import { StateGraph } from "../graph/index.js";
import { SkillCatalog, applySkillsToSystemPrompt, type Skill } from "../skills/index.js";
import { AgentEventBus, runSubagent } from "../subagents/index.js";
import { createWorkspaceToolKit } from "../workspace/index.js";
import { McpClient, type McpRequestTransport } from "../mcp/index.js";
import { generateStructured } from "../structured-output/index.js";
import { ModelRouter } from "../routing/index.js";
import { DurableTaskRunner, SqliteDurableTaskStore } from "../durable/index.js";
import { GovernedMemoryBank, type Episode } from "../memory-consolidation/index.js";
import { RegularizedRsiController, type AtomicHarnessEdit } from "../rsi/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PlaygroundDemoName =
  | "memory"
  | "skills"
  | "subagent"
  | "graph"
  | "evolution"
  | "eval"
  | "workspace"
  | "mcp"
  | "structured"
  | "durable"
  | "memory-consolidation"
  | "rsi";

export const PLAYGROUND_DEMOS = [
  { id: "memory", stage: "02", title: "Memory", description: "完整历史如何变成本轮 Context" },
  { id: "skills", stage: "03", title: "Skills", description: "发现、依赖解析与 prompt 注入" },
  { id: "subagent", stage: "04", title: "Sub-agent", description: "独立 child 与结构化 handoff" },
  { id: "graph", stage: "05", title: "Graph", description: "并行分支经过 reducer 合并" },
  { id: "evolution", stage: "06", title: "Self-evolve", description: "固定数据、gate、审批和发布" },
  { id: "eval", stage: "07", title: "Trace replay", description: "不访问模型地重放 baseline 与 candidate" },
  { id: "workspace", stage: "09", title: "Workspace", description: "目录边界、只读默认与 artifact" },
  { id: "mcp", stage: "10", title: "MCP", description: "发现、白名单、调用与脱敏" },
  { id: "structured", stage: "11", title: "Route & JSON", description: "结构化 repair、路由与 fallback" },
  { id: "durable", stage: "12", title: "Durable", description: "SQLite task、lease 与事件恢复" },
  { id: "memory-consolidation", stage: "16", title: "Memory gate", description: "原始 episode、反例、回放与回滚" },
  { id: "rsi", stage: "17", title: "Regularized RSI", description: "递归 lineage、泄漏筛查、退火预算与保守选择" },
] as const;

export async function runPlaygroundDemo(name: string) {
  if (name === "memory") return memoryDemo();
  if (name === "skills") return skillsDemo();
  if (name === "subagent") return subagentDemo();
  if (name === "graph") return graphDemo();
  if (name === "evolution") return evolutionDemo();
  if (name === "eval") return evalDemo();
  if (name === "workspace") return workspaceDemo();
  if (name === "mcp") return mcpDemo();
  if (name === "structured") return structuredDemo();
  if (name === "durable") return durableDemo();
  if (name === "memory-consolidation") return memoryConsolidationDemo();
  if (name === "rsi") return rsiDemo();
  throw new Error(`Unknown playground demo: ${name}`);
}

async function memoryDemo() {
  const context: AgentContext = {
    systemPrompt: "你是教学助手。",
    tools: [],
    messages: [
      { role: "user", content: "我喜欢中文回答" },
      { role: "assistant", content: [{ type: "text", text: "已记住" }], stopReason: "stop" },
      { role: "user", content: "解释 Agent loop" },
      { role: "assistant", content: [{ type: "text", text: "模型和工具形成反馈环" }], stopReason: "stop" },
    ],
  };
  const built = new RecentContextBuilder({ maxMessages: 2, maxCharacters: 1_000 }).build(context);
  return demo("memory", "完整历史没有被删除，只有模型请求快照被裁剪。", [
    step("ConversationStore", "保存 4 条完整消息", context.messages),
    step("ContextBuilder", "按完整轮次选择最近 2 条", built.messages),
    step("Model request", "本轮只发送选择后的只读快照", built),
  ], { storedMessages: context.messages.length, sentMessages: built.messages.length });
}

async function skillsDemo() {
  const base: Skill = { name: "base", description: "基础写作格式", instructions: "保持结构清晰。", sourcePath: "base/SKILL.md", version: "1.0.0", dependencies: [], tags: ["格式"], requiredTools: [] };
  const report: Skill = { name: "report", description: "生成分析报告", instructions: "先结论，再证据。", sourcePath: "report/SKILL.md", version: "1.1.0", dependencies: ["base"], tags: ["报告", "分析"], requiredTools: [] };
  const catalog = new SkillCatalog().registerMany([base, report]);
  const discovered = catalog.discover("写一份分析报告");
  const selected = catalog.select(discovered.map((item) => item.name));
  const prompt = applySkillsToSystemPrompt("你是助手。", selected);
  return demo("skills", "路由只能从 Catalog 白名单选择，依赖项先于目标 Skill 注入。", [
    step("Discover", "根据 name、description 和 tags 找候选", discovered.map((item) => item.name)),
    step("Resolve", "解析依赖并去重", selected.map((item) => `${item.name}@${item.version}`)),
    step("Inject", "用显式边界加入 system prompt", prompt),
  ], { selected: selected.map((item) => item.name) });
}

async function subagentDemo() {
  const model: ModelProvider = { name: "playground-child", async generate() {
    return { role: "assistant", content: [{ type: "text", text: "审查完成：示例通过。" }], stopReason: "stop", usage: { input: 4, output: 5 } };
  } };
  const bus = new AgentEventBus();
  const events: string[] = [];
  bus.subscribe((event) => events.push(`${event.agentId}:${event.event.type}`));
  const handoff = await runSubagent({ task: "审查报告", agentId: "reviewer-1", parentAgentId: "writer", createAgent: () => new Agent({ model }), eventBus: bus });
  return demo("subagent", "Child 使用独立 Context，父级只接收 HandoffResult。", [
    step("Delegate", "父 Agent 只传递一个明确 task", { task: handoff.task, parent: handoff.parentAgentId }),
    step("Observe", "Event bus 使用父子 ID 汇总事件", events),
    step("Handoff", "输出、预算和状态结构化返回", handoff),
  ], handoff);
}

async function graphDemo() {
  type State = { source: number; left?: number; right?: number; total?: number };
  const graph = new StateGraph<State>()
    .addNode("fork", () => ({ fork: ["left", "right"], join: "join" }))
    .addNode("left", (state) => ({ left: state.source + 1 }))
    .addNode("right", (state) => ({ right: state.source + 2 }))
    .addNode("join", (state) => ({ total: (state.left ?? 0) + (state.right ?? 0) }))
    .setStart("fork");
  const result = await graph.run({ source: 10 });
  return demo("graph", "两个分支读取各自 state 副本，reducer 按稳定顺序合并。", [
    step("Fork", "left 与 right 可以并行", ["left", "right"]),
    step("Reduce", "partial updates 合并进新 state", result.state),
    step("Complete", "普通 Agent loop 没有被 Graph 替换", result),
  ], result);
}

async function evolutionDemo() {
  const store = new InMemoryArtifactStore();
  store.put({ artifactId: "prompt", kind: "prompt", version: 1, content: "直接回答。", createdAt: "2026-01-01T00:00:00Z" });
  store.activate("prompt", 1);
  const dataset = [
    { id: "public", input: "退款", split: "eval" as const },
    { id: "hidden", input: "陌生交易", split: "holdout" as const },
  ];
  const controller = new EvolutionController(store, dataset, async (artifact) => ({ output: artifact.version === 2 ? "先核验" : "直接承诺", passed: artifact.version === 2, safetyPassed: artifact.version === 2, tokens: 10, cost: 0.01, latencyMs: 20 }));
  const candidate = controller.propose({ artifactId: "prompt", kind: "prompt", content: "先核验事实。", rationale: "修复越权承诺", failureTraceIds: ["trace-42"] });
  const evaluated = await controller.evaluate(candidate.id);
  controller.approve(candidate.id, "human-reviewer");
  controller.publish(candidate.id, "release-owner");
  return demo("evolution", "模型可以提出候选，但 gate、人工审批和发布属于宿主。", [
    step("Propose", "候选关联失败 trace 和父版本", candidate),
    step("Evaluate", "baseline/candidate 使用同一 eval 与 holdout", evaluated.report),
    step("Approve & publish", "人工身份通过后切换 active version", controller.releaseHistory()),
  ], { activeVersion: store.getActive("prompt")?.version, gatePassed: evaluated.report?.gate.passed });
}

async function workspaceDemo() {
  const readOnly = createWorkspaceToolKit({ root: process.cwd() });
  const writable = createWorkspaceToolKit({ root: process.cwd(), allowWrite: true });
  return demo("workspace", "注册工具不等于授权；写工具只有宿主显式开启后才出现。", [
    step("Root", "所有路径都必须留在这一目录", process.cwd()),
    step("Read-only", "默认只提供读取与搜索", readOnly.registry.list().map((tool) => tool.name)),
    step("Write opt-in", "allowWrite=true 才注册 write_file", writable.registry.list().map((tool) => tool.name)),
  ], { shell: false, network: false, symlinksFollowed: false });
}

async function evalDemo() {
  const events = [{ type: "agentStart" as const }, { type: "agentEnd" as const }];
  const makeCase = (id: string, split: "eval" | "holdout"): ReplayEvalCase => ({
    id, input: "处理退款", split, expected: "核验", rubric: "contains",
    runs: {
      "1": { artifactVersion: 1, output: "直接退款", safetyPassed: false, tokens: 10, cost: 0.01, latencyMs: 20, events },
      "2": { artifactVersion: 2, output: "先核验订单", safetyPassed: true, tokens: 11, cost: 0.01, latencyMs: 21, events },
    },
  });
  const dataset = [makeCase("public", "eval"), makeCase("hidden", "holdout")];
  const baseline = { artifactId: "prompt", kind: "prompt" as const, version: 1, content: "v1", createdAt: "2026-01-01T00:00:00Z" };
  const candidate = { ...baseline, version: 2, content: "v2", parentVersion: 1 };
  const replay = new TraceReplayEvaluator(dataset);
  const firstReplay = replay.replay(candidate, toEvalCases(dataset)[0]!);
  const report = await compareArtifacts(baseline, candidate, toEvalCases(dataset), replay.asEvaluator());
  return demo("eval", "Recorded events 可以重复检查 rubric，不会再次调用模型或真实工具。", [
    step("Dataset", "公开 eval 与隐藏 holdout 固定成同一快照", dataset.map((item) => ({ id: item.id, split: item.split }))),
    step("Replay", "校验 agentStart、tool 配对和 agentEnd", firstReplay),
    step("Diff", "逐项比较 baseline 和 candidate", report),
  ], report.gate);
}

async function mcpDemo() {
  const calls: string[] = [];
  const transport: McpRequestTransport = {
    async request(method) {
      calls.push(method);
      if (method === "initialize") return {};
      if (method === "tools/list") return { tools: [
        { name: "lookup", inputSchema: { type: "object" } },
        { name: "admin", inputSchema: { type: "object" } },
      ] };
      return { content: "文档结果", token: "demo-secret" };
    },
  };
  const registry = await new McpClient({
    serverName: "docs", transport, allowedTools: ["lookup"],
  }).createRegistry();
  const tools = registry.list();
  const result = await tools[0]!.execute({}, { messages: [] });
  return demo("mcp", "MCP server 只负责声明能力，宿主白名单决定 Agent 最终能看到什么。", [
    step("Discover", "先 initialize，再读取 server 工具目录", calls.slice(0, 2)),
    step("Allowlist", "admin 没有授权，因此不会注册", tools.map((tool) => tool.name)),
    step("Call & redact", "调用结果进入 Context 前移除 secret 字段", JSON.parse(result)),
  ], { transport: "stdio-compatible", shellFromModel: false });
}

async function structuredDemo() {
  const outputs = ["not-json", "{\"answer\":\"已修复\"}"];
  const repairModel: ModelProvider = {
    name: "repair-demo",
    async generate() {
      return { role: "assistant", content: [{ type: "text", text: outputs.shift()! }],
        stopReason: "stop", usage: { input: 3, output: 2 } };
    },
  };
  const structured = await generateStructured<{ answer: string }>(
    repairModel, { systemPrompt: "回答", messages: [], tools: [] },
    { type: "object", properties: { answer: { type: "string" } },
      required: ["answer"], additionalProperties: false },
  );
  const unavailable: ModelProvider = {
    name: "primary", async generate() { throw new Error("provider offline"); },
  };
  const fallback: ModelProvider = {
    name: "fallback", async generate() {
      return { role: "assistant", content: [{ type: "text", text: "fallback ok" }],
        stopReason: "stop", usage: { input: 2, output: 1 } };
    },
  };
  const router = new ModelRouter([
    { name: "primary", model: unavailable },
    { name: "fallback", model: fallback },
  ]);
  const routed = await router.generate(
    { systemPrompt: "route", messages: [], tools: [] },
    { task: "summary", role: "generator" },
  );
  return demo("structured", "JSON 由宿主验证；模型失败时按显式顺序 fallback。", [
    step("Generate", "第一份输出不是合法 JSON", "not-json"),
    step("Repair & validate", "repair 后再次通过相同 Schema", structured),
    step("Route & metrics", "generator/judge 指标不会混在一起", router.snapshotMetrics()),
  ], { routedModel: routed.routedModel, value: structured.value });
}

async function durableDemo() {
  const directory = mkdtempSync(join(tmpdir(), "agent-durable-demo-"));
  try {
    const file = join(directory, "runtime.sqlite");
    const first = new SqliteDurableTaskStore(file);
    first.enqueue("double", { value: 5 }, "demo-task");
    first.close();
    const second = new SqliteDurableTaskStore(file);
    const runner = new DurableTaskRunner(second, "worker-1", {
      double: (payload, context) => {
        context.appendEvent("progress", { percent: 50 });
        return { value: Number((payload as { value: number }).value) * 2 };
      },
    });
    const task = await runner.runNext();
    const events = second.events("demo-task");
    second.close();
    return demo("durable", "进程重启后，新 worker 从同一 SQLite 文件继续 pending task。", [
      step("Enqueue", "taskId 是幂等键", { taskId: "demo-task", status: "pending" }),
      step("Restart & claim", "worker 通过有限 lease 获得执行权", task),
      step("Event log", "状态变化只追加，便于恢复与审计", events.map((event) => event.type)),
    ], { status: task?.status, result: task?.result });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function memoryConsolidationDemo() {
  const bank = new GovernedMemoryBank();
  const makeEpisode = (id: string, taskId: string, tags: string[], scope: string): Episode => ({
    id, taskId, tags, scope, input: `处理 ${id}`, trajectory: `raw trace: ${id}`,
    outcome: "success", createdAt: "2026-08-01T00:00:00Z",
  });
  bank.retain(makeEpisode("csv-1", "task-a", ["data", "csv"], "csv-import"));
  bank.retain(makeEpisode("csv-2", "task-b", ["data", "csv", "quoted"], "csv-import"));
  bank.retain(makeEpisode("json-1", "task-c", ["data", "json"], "json-import"));
  const evidence = [
    { episodeId: "csv-1", relation: "support" as const },
    { episodeId: "csv-2", relation: "support" as const },
    { episodeId: "json-1", relation: "counterexample" as const },
  ];
  const cases = [
    { id: "new-csv", tags: ["data", "csv"], shouldApply: true, baselinePassed: false },
    { id: "known-csv", tags: ["data", "csv", "quoted"], shouldApply: true, baselinePassed: true },
    { id: "json-boundary", tags: ["data", "json"], shouldApply: false, baselinePassed: true },
  ];
  const bad = bank.propose({
    memoryId: "import-rule", scope: "csv-import", lesson: "所有数据都按逗号切分。",
    applicability: { allTags: ["data"], noneTags: [] }, evidence,
    rationale: "从两条 CSV 成功轨迹提炼。",
  });
  const rejected = await bank.evaluate(bad.id, cases, (_candidate, testCase) =>
    testCase.id !== "json-boundary"
  );
  bank.reject(bad.id, "playground-reviewer");
  const bounded = bank.propose({
    memoryId: "import-rule", scope: "csv-import", lesson: "CSV 导入使用支持引号字段的 parser。",
    applicability: { allTags: ["data", "csv"], noneTags: ["json"] }, evidence,
    rationale: "显式保留 CSV 边界和 JSON 反例。",
  });
  const gated = await bank.evaluate(bounded.id, cases, (_candidate, testCase) =>
    testCase.id === "new-csv" ? true : testCase.baselinePassed
  );
  bank.activate(bounded.id, "playground-reviewer");
  const active = bank.active(["data", "csv"]);
  return demo("memory-consolidation", "原始轨迹永不被抽象覆盖；只有带反例且回放无回归的候选才能激活。", [
    step("Retain episodes", "保留两条支持证据和一条边界反例", ["csv-1", "csv-2", "json-1"]),
    step("Reject overgeneralization", "过宽 applicability 会命中 JSON 并造成回放回归", rejected.report),
    step("Gate & activate", "缩窄适用条件后，人工身份激活可回滚版本", { report: gated.report, active }),
  ], { rejected: !rejected.report?.passed, active });
}

async function rsiDemo() {
  const grades = {
    expensive: { publicScore: 0.62, selectionScore: 0.60, policyTokens: 200, safetyPassed: true },
    reusable: { publicScore: 0.59, selectionScore: 0.58, policyTokens: 105, safetyPassed: true },
    recursive: { publicScore: 0.64, selectionScore: 0.63, policyTokens: 106, safetyPassed: true },
  } as const;
  const controller = new RegularizedRsiController(
    { id: "agent", version: 1, content: "base", createdAt: "2026-09-01T00:00:00Z" },
    { publicScore: 0.5, selectionScore: 0.5, policyTokens: 100, safetyPassed: true },
    async (harness) => grades[harness.content as keyof typeof grades],
    { totalRounds: 4, minEditBudget: 1, maxEditBudget: 3 },
    ["private-answer"],
  );
  const edit = (id: string, component: AtomicHarnessEdit["component"], diff: string): AtomicHarnessEdit => ({
    id, component, operation: "update", hypothesis: `test ${id}`,
    description: `change ${id}`, sourceDiff: diff,
  });
  const leaked = controller.propose("leak", [edit("leak", "prompt", "+private-answer")]);
  const expensive = controller.propose("expensive", [edit("loops", "control_flow", "+loops")]);
  const reusable = controller.propose("reusable", [edit("retry", "config", "+bounded retry")]);
  const expensiveReport = await controller.evaluate(expensive.id);
  const reusableReport = await controller.evaluate(reusable.id);
  const firstWinner = controller.select([leaked.id, expensive.id, reusable.id], "playground-reviewer");
  const recursive = controller.propose("recursive", [edit("checklist", "skill", "+generic checklist")]);
  await controller.evaluate(recursive.id);
  const secondWinner = controller.select([recursive.id], "playground-reviewer");
  return demo("rsi", "只有通过固定 selector 的 harness 才成为下一轮 parent；模型不能改 selector、预算或私有评分。", [
    step("Screen", "包含私有答案的候选在评测前拒绝", leaked),
    step("Regularize", "高分但成本翻倍的候选不进入 lineage", expensiveReport.selection),
    step("Recurse", "可复用修改成为 v2，下一轮只能基于 v2 提出 v3", { reusable: reusableReport.selection, lineage: controller.lineage() }),
  ], { firstWinner, secondWinner, versions: controller.lineage().map((item) => item.version) });
}

function step(label: string, detail: string, data: unknown) {
  return { label, detail, data };
}

function demo(id: PlaygroundDemoName, summary: string, steps: unknown[], result: unknown) {
  return { id, summary, steps, result };
}
