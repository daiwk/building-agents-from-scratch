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

- `ModelProvider.stream()`；
- text/thinking/tool-argument delta；
- ~~timeout、指数退避~~、限流；
- token/cost budget；
- ~~JSON Schema 基础参数校验~~（复杂 Schema 后续接成熟 validator）；
- 并行工具执行策略；
- OpenTelemetry-compatible trace。

原则：先形成完整 assistant message，再写入历史；半条消息不能污染 context。

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
