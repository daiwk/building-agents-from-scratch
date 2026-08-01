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

## Stage 1：Streaming 与工程可靠性（已完成）

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

## Stage 2：Memory（已完成）

把 memory 拆成三个不同问题：

1. `ConversationStore`：~~内存/JSON 教学实现与 SQLite 持久化~~；
2. `ContextBuilder`：~~完整轮次、可插拔 tokenizer、旧历史摘要~~；
3. `MemoryIndex`：~~episodic / semantic / procedural 分类与跨会话 BM25-like 检索~~。

`RecentContextBuilder` 只裁剪发给模型的快照，不删除 ConversationStore 中的完整历史，
并保证 tool call/result 不被截成孤立消息。`TokenContextBuilder` 接受目标 provider 的
`TokenCounter`，因此可以使用真实 tokenizer，而不会拿字符数冒充 token；被裁掉的完整
旧轮次可交给可替换 `SummaryProvider`，原始历史仍不删除。

三套实现已使用同一个配置边界接入 SQLite：每个 session 一行 JSON messages，覆盖保存和
清除由数据库事务完成。TypeScript 使用 Node 内置 `node:sqlite`，Python 使用标准库
`sqlite3`，pi-agent 复用通用 store；JSON 文件实现仍保留，方便初学者直接观察数据。
`MemoryIndex` 使用独立 SQLite 表保存三类长期记忆，并提供透明的 BM25-like 本地排序和
prompt 注入 wrapper；后续接 embedding 只需替换 search 实现。

## Stage 3：Skills（已完成）

建议协议：

```ts
type Skill = {
  name: string;
  description: string;
  instructions: string;
  version: string;
  dependencies: string[];
  tags: string[];
  requiredTools: string[];
};
```

load → dependency resolve → route → inject 已完成。`SkillCatalog.discover()` 使用透明的
BM25-like 排序；`ModelSkillRouter`/Python `SkillRouter` 可接专用分类模型，但输出仍经过
Catalog 白名单、去重、limit 和依赖解析。`AGENT_SKILLS=auto` 在三套实现中按当前用户输入
动态选择。frontmatter 支持 version、dependencies、tags 和 tools；tools 只声明依赖，
未在宿主白名单中的工具会报错，Skill 永远不能自行扩大权限。

## Stage 4：Sub-agent 和 Multi-agent（已完成）

`agentAsTool({ createAgent })` 与 `runSubagent()` 已实现：父 Agent 可以把独立 task 委派给
新建的 child，不共享可变 messages，并得到 `HandoffResult`。已经加入：

- ~~父子取消与超时传播~~；
- ~~depth、turn、token 和时间预算~~；
- ~~只读或显式挑选的上下文传递~~；
- ~~结构化 handoff result~~；
- ~~scheduler 管理并行子 Agent~~；
- ~~event bus 汇总轨迹~~。

不要默认让所有 Agent 共享同一个可变 message 数组。

## Stage 5：Loop 与 Graph（已完成）

当前 agent loop 是固定图：

```text
model → condition → tool → model
```

通用 graph 已新增独立 runtime：

- ~~node：纯函数或 effect~~；
- ~~edge：根据 state 选择下一节点~~；
- ~~checkpoint：可恢复状态~~；
- ~~reducer：并行分支合并~~；
- ~~interrupt：人工输入与审批~~。

普通单 Agent 仍使用小循环；只有工作流确实需要分支、恢复或并行时才使用 graph。
TypeScript 与 Python 的 `StateGraph` 使用同一语义：条件 edge 选择路径，fork 并行执行后由
reducer 合并，checkpoint 保存下一节点，interrupt 返回可序列化值并从同一节点 resume。

## Stage 6：Self-evolve（已完成）

Self-evolve 不是让 Agent 直接改线上 prompt 或代码。安全闭环应为：

```text
收集失败轨迹 → 提出候选修改 → 隔离环境评测 → 对比基线
→ 人工审批 → 版本化发布 → 可回滚监控
```

候选物可以是 prompt、skill、tool description 或 routing policy。当前已经提供：

- ~~immutable version~~（同一 artifact/version 禁止覆盖）；
- ~~固定 eval dataset~~（baseline 与 candidate 使用相同快照）；
- ~~质量、成本、延迟、token 和安全指标~~；
- ~~防止针对 eval 过拟合的 holdout~~；
- ~~明确的人工审批、发布、发布后回归监控与回滚 gate~~。

TypeScript 与 Python 的 `EvolutionController` 都要求候选关联失败 trace。模型可以生成
candidate content 和 rationale，但不能调用 `approve()` 或 `publish()`；release gate 通过后
仍需提供人工身份。`InMemoryArtifactStore` 是可观察的教学实现，生产环境应在同一接口后接
数据库、制品仓库和组织自己的权限系统。

## Stage 7：Trace Replay 与 Eval Workbench（已完成）

- ~~JSONL 固定数据集与 SHA-256 fingerprint~~；
- ~~失败 trace 提升为二元 rubric eval case~~；
- ~~不访问模型和真实工具的 deterministic replay~~；
- ~~baseline/candidate diff 与 release gate~~；
- ~~JSON eval report 持久化~~；
- ~~可在 CI 使用退出码阻止回归~~。

`TraceReplayEvaluator` 会校验 `agentStart → toolStart/toolEnd → agentEnd` 的结构，并使用
录制时的输出、usage、成本和延迟重新评分。Replay 适合稳定回归，不等于真实线上质量；仍需
定期运行真实模型评测，并人工检查失败模式。

## Stage 8：高级能力 Web Playground（已完成）

`/playground.html` 是不需要 API Key 的组件实验台。目前可以逐步运行：

- ~~Memory：完整历史与本轮 Context 快照~~；
- ~~Skills：发现、依赖解析与注入~~；
- ~~Sub-agent：父子事件和 handoff~~；
- ~~Graph：fork、reducer 与最终 state~~；
- ~~Self-evolve / Trace replay：评测、gate 和发布~~；
- ~~Workspace：默认只读与显式写授权~~。

每个 demo 调用项目里的真实组件，但使用固定输入和假模型。页面在普通宽屏与手机宽度下都
保持文档流滚动，不使用锁死整页的固定高度。

## Stage 9：安全 Workspace Tools 与 Artifact（已完成）

- ~~`list_files`、`read_file`、`search_text`~~；
- ~~宿主显式开启后才注册 `write_file`~~；
- ~~root confinement、路径穿越与 symlink escape 防护~~；
- ~~文件大小、条目数、匹配数和写入大小限制~~；
- ~~长结果转为 artifact，并用 `read_artifact` 分段读取~~；
- ~~TypeScript、Python 与 pi-agent 共用工具语义~~。

这些工具不执行 shell、不访问网络，也不会自动扩大 Skill 权限。通过
`AGENT_WORKSPACE_ROOT` 设置唯一允许目录；`AGENT_WORKSPACE_ALLOW_WRITE` 默认 false。

## Stage 10：MCP 接入（计划）

先支持 stdio tool discovery/call、server/tool 白名单、timeout/cancel 和 secret 脱敏；
Resources、Prompts 与远程 transport 后续再加入。MCP adapter 进入 ToolRegistry，不修改
Agent loop。

## Stage 11：Structured Output 与模型路由（计划）

加入可校验 JSON 输出、无效结果 repair、按任务选模型、fallback，以及 generator/judge
隔离统计。Graph planner 和 Skill router 只能输出宿主允许的结构。

## Stage 12：Durable Runtime（计划）

提供 SQLite checkpoint、持久化 task queue、run/event store、幂等 task ID，以及服务重启后
继续 interrupt/sub-agent；分布式队列保持为可替换生产实现。

## Stage 13–15（远期）

- Stage 13：带引用的文档摄取与 BM25/vector hybrid retrieval；
- Stage 14：文件上传、图片输入、Artifact 预览与下载；
- Stage 15：认证、租户隔离、RBAC、密钥管理、审计与部署模板。
