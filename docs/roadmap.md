# 渐进式开发路线

每个阶段都保持前一阶段可运行，不把高级概念混进最小循环。

## Stage 0：最小 Agent（当前）

已经具备：

- 显式 context 和 message；
- 模型 provider 接口；
- 顺序 tool loop；
- Agent 事件；
- 工具错误恢复；
- 最大轮次和取消信号；
- 工具参数运行时校验；
- 模型 timeout、选择性 retry 和指数退避；
- ToolRegistry 与常用工具按名称授权；
- ConversationStore（内存与本地 JSON）；
- SKILL.md 读取、选择和 prompt 注入；
- MiniMax 与本机 CLI 后端；
- 三个生命周期 hook。

完成标准：初学者只读 `types.ts` 和 `agent-loop.ts` 就能解释 Agent 原理。

## Stage 1：Streaming 与工程可靠性

- ~~`ModelProvider.stream()`~~（不支持时自动回退 `generate()`）；
- ~~text/thinking/tool-argument delta~~；
- ~~timeout、指数退避、限流~~；
- ~~token/cost budget~~（每次 run 累计，并在下一次模型调用前拦截）；
- ~~JSON Schema 基础参数校验~~（复杂 Schema 后续接成熟 validator）；
- ~~并行工具执行策略~~（默认顺序，显式开启并保持结果顺序稳定）；
- ~~OpenTelemetry-compatible trace~~（run/model/tool 父子 span + 可替换 exporter）。

原则：先形成完整 assistant message，再写入历史；半条消息不能污染 context。

MiniMax 国内接口已使用 SSE 实现真正的 token streaming。delta 只作为临时
`AgentEvent` 发给 CLI/Web UI；provider 收到 `message_stop` 并组装出完整
`AssistantMessage` 后，Agent loop 才写入 history。首个可见 delta 之前的临时失败可以
retry；首个 delta 之后不自动 retry，避免用户看到重复片段。

`ModelRateLimiter` 已提供进程内平滑限流，跨同一 Agent 的多次 run 共享状态，并通过
`rateLimitWait` 告知 CLI/Web UI 正在主动等待。TypeScript/Python 的 retry 也会经过同一
limiter；多实例共享额度仍应交给 Redis 或 API 网关。

`BudgetTracker` 已能累计 input、output、cache read 和 cache write token，并按用户配置的
币种与单价估算成本；项目不硬编码 MiniMax 套餐价格。预算是 soft boundary：usage 在响应
结束后才可得，因此可能越过上限一次，但不会再开始下一次模型调用。CLI 和 Web UI 都会
收到 `usage` 事件，Python 和 pi-agent 对照版也使用相同的配置与运行边界。

工具执行默认保持顺序；`AGENT_TOOL_EXECUTION=parallel` 才会并发启动同一轮的独立工具。
权限检查和结果写回仍按模型原始 call 顺序进行，避免完成时序让 Context 变得不确定。

三套实现现在都会为一次 run 创建根 span，并把每次模型调用和工具执行记录为子 span。
教学用 JSONL exporter 使用 `gen_ai.*` 属性，默认不保存 prompt、工具参数或结果；生产环境
可以在不修改 Agent loop 的情况下，把小型 exporter 接口替换为真实 OTel SDK/OTLP。

## Stage 2：Memory

把 memory 拆成三个不同问题：

1. `ConversationStore`：已提供内存/JSON 教学实现，下一步接 SQLite；
2. `ContextBuilder`：已提供 `RecentContextBuilder`，按最近完整轮次和字符预算构造本轮请求；
3. `MemoryIndex`：跨会话语义/关键词检索。

`RecentContextBuilder` 只裁剪发给模型的快照，不删除 ConversationStore 中的完整历史，
并保证 tool call/result 不被截成孤立消息。下一步加入精确 token 计数与摘要，再增加
episodic、semantic、procedural memory，避免把“memory”误写成一个巨型向量库类。

## Stage 3：Skills

建议协议：

```ts
type Skill = {
  name: string;
  description: string;
  instructions: string;
  tools?: Tool[];
};
```

基础 load → select → inject 已完成；`SkillCatalog.discover()` 与
`createDynamicSkillHook()` 也已提供透明的关键词动态选择，可用 `AGENT_SKILLS=auto`
启用。只把选中的 skill 指令放入 context，不要把全部技能全文塞进 system prompt。

当前 discover 是适合教学和少量 skill 的确定性 name/description 匹配，不是语义检索。
下一步可在不改变 catalog 边界的前提下替换为 BM25、embedding 或模型路由。技能带来的
工具仍走同一个权限边界。

## Stage 4：Sub-agent 和 Multi-agent

`agentAsTool({ createAgent })` 已实现：父 Agent 可以把独立 task 委派给新建的 child，
不共享可变 messages，并把父级取消信号向下传递。然后加入：

- 更完整的父子取消与超时传播；
- depth、turn、token 和时间预算；
- 只读或显式挑选的上下文传递；
- 结构化 handoff result；
- scheduler 管理并行子 Agent；
- event bus 汇总轨迹。

不要默认让所有 Agent 共享同一个可变 message 数组。

## Stage 5：Loop 与 Graph

当前 agent loop 是固定图：

```text
model → condition → tool → model
```

通用 graph 应新增独立 runtime：

- node：纯函数或 effect；
- edge：根据 state 选择下一节点；
- checkpoint：可恢复状态；
- reducer：并行分支合并；
- interrupt：人工输入与审批。

普通单 Agent 仍使用小循环；只有工作流确实需要分支、恢复或并行时才使用 graph。

## Stage 6：Self-evolve

Self-evolve 不是让 Agent 直接改线上 prompt 或代码。安全闭环应为：

```text
收集失败轨迹 → 提出候选修改 → 隔离环境评测 → 对比基线
→ 人工审批 → 版本化发布 → 可回滚监控
```

候选物可以是 prompt、skill、tool description 或 routing policy。每种候选物都需要：

- immutable version；
- 固定 eval dataset；
- 质量、成本、延迟和安全指标；
- 防止针对 eval 过拟合的 holdout；
- 明确的发布与回滚 gate。
