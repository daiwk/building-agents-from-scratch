# 直接使用 pi-agent

`examples/pi-agent-direct.ts` 用成熟的 pi-agent API 实现同一个 Agent。它不是包装
本项目的 from-scratch 循环，而是直接创建 `Agent`、模型和 `AgentTool`，并复用项目的
SKILL.md loader 与通用 JSON/SQLite session store。

## 离线检查

```bash
npm run pi-check
```

这只验证 provider、模型和工具能否正确装配，不发送网络请求。

## 调用真实模型

```bash
npm run pi-example -- "精确计算 1234 × 5678"
```

示例使用 `@earendil-works/pi-ai/providers/minimax-cn`。如果只设置了本项目统一使用的
`MINIMAX_API_KEY`，示例会在进程内映射为 pi-ai 读取的 `MINIMAX_CN_API_KEY`。

## Tools、Memory 与 Skills

默认复用 `AGENT_*`：

```dotenv
AGENT_TOOLS=calculator,current_time
AGENT_TOOL_EXECUTION=sequential
AGENT_MEMORY_DATABASE=.agent-data/conversations.sqlite3
AGENT_MEMORY_INDEX_DATABASE=.agent-data/memory-index.sqlite3
AGENT_SESSION_ID=pi-cli
AGENT_SKILLS_DIR=skills
AGENT_SKILLS=tool-first
AGENT_TRACE_FILE=.agent-data/traces.jsonl
```

需要与 from-scratch Agent 隔离时，可以使用 `PI_AGENT_TOOLS`、
`PI_AGENT_MEMORY_FILE`、`PI_AGENT_MEMORY_DATABASE`、
`PI_AGENT_MEMORY_INDEX_DATABASE`、`PI_AGENT_SESSION_ID`、`PI_AGENT_SKILLS_DIR` 和
`PI_AGENT_SKILLS` 覆盖。
工具执行策略还可以用 `PI_AGENT_TOOL_EXECUTION` 单独覆盖。

- 工具通过 pi-agent 自己的 `AgentTool` 与 TypeBox Schema 校验；
- 历史消息从 `initialState.messages` 恢复；
- SQLite 和 JSON 都复用项目的通用 store，不依赖 pi-agent 私有存储格式；
- `agent_end` listener 被 pi-agent await，memory 保存完成后 `prompt()` 才结束；
- skill 仍然只注入指令，不自动获得工具或代码执行权限。
- lifecycle listener 把 run、model 和 tool 事件写入与教学版相同的父子 span。
- `agent_start` 根据最新用户消息执行相同的 Skill BM25 路由和 MemoryIndex 召回。

## Timeout 与 Retry

示例的 `streamFn` 把下面配置直接传给 pi-ai：

```dotenv
AGENT_MODEL_TIMEOUT_MS=120000
AGENT_MODEL_MAX_RETRIES=1
AGENT_MAX_RETRY_DELAY_MS=8000
AGENT_RATE_LIMIT_MAX_REQUESTS=60
AGENT_RATE_LIMIT_WINDOW_MS=60000
```

这使用成熟库原生的 provider timeout/retry，而不是在 pi-agent 外再复制一遍
from-scratch 重试循环。

示例在 pi-agent 的 `streamFn` 入口复用 `ModelRateLimiter`，所以不同 turn 和多次
`prompt()` 会共享同一个平滑请求速率。pi-ai 内部 retry 仍使用它自己的退避策略。

## Token / 成本预算

pi-agent 的完整 assistant message 自带标准化 usage。示例把它交给与 TypeScript 版共用的
`BudgetTracker`，因此仍使用同一组 `AGENT_MAX_*` 和 `AGENT_*_COST_*` 环境变量。每次
`prompt()` 在 `agent_start` 时重置计数；带工具调用的 turn 达到上限后，会在工具完成后
调用 pi-agent 的取消接口，不再启动下一次模型调用。

pi-ai 自身也会计算 provider cost，但本示例的成本上限只采用你显式配置的币种与单价，
避免教程把会变化的套餐价格写死。

## 与教学版对照

| 教学版 | pi-agent |
|---|---|
| 手写 `agentLoop()` | `Agent` 内部管理循环 |
| 工具参数是普通 JSON Schema | `Type.Object` 同时提供 Schema 与类型 |
| 自定义少量事件 | 标准 message/tool/agent 生命周期事件 |
| 一个 MiniMax provider | pi-ai 的 provider 与 model registry |
| 自己实现 Schema 子集 | TypeBox + pi-agent 原生校验 |
| 自己实现模型重试循环 | pi-ai provider 原生 timeout/retry |
| 共用平滑限流器 | 在 `streamFn` 入口限制每个 turn |
| 显式顺序/并行策略 | pi-agent 原生 `toolExecution` |
| 共用 `BudgetTracker` | 原生 usage + 生命周期事件驱动预算 |
| 共用 `AgentTracer` | 生命周期事件驱动相同的 JSONL trace |

成熟库适合继续做 streaming、复杂 provider 和生产集成；教学版适合定位控制流、修改
协议以及验证自己的架构想法。

Stage 4/5 是 Agent 外层的 orchestration：pi-agent 实例可以作为 scheduler worker 或
`StateGraph` node，原生 lifecycle event 可转发到同一个 event bus。Graph 不复制 pi-agent
内部 loop，只负责 child 之间的任务、状态、checkpoint 与审批路径。

`runPiAgentHandoff()` 已把 `prompt()`、usage、timeout/abort 和错误统一转换成
`HandoffResult`。可以直接在 graph node 中调用；需要有界并发时，把多个调用函数交给
`SubagentScheduler.runWorkers()`，结果仍按输入顺序返回。

## Stage 6 隔离评测

`createPiAgent({ systemPrompt })` 和 `runPiAgentHandoff(..., { systemPrompt })` 接受版本化
prompt artifact。Evaluator 可以为 baseline/candidate 分别创建新实例，读取 handoff 的输出、
token 与耗时后生成二元 `EvalSampleResult`。版本、holdout、gate、人工审批和发布仍由
`EvolutionController` 管理，pi-agent 本身不能切换 active version。

设置 `AGENT_WORKSPACE_ROOT` 后，示例会把同一组 workspace tools 适配成 pi-agent 的
`AgentTool`；仍需在 `PI_AGENT_TOOLS` 或 `AGENT_TOOLS` 中逐个授权。Trace replay 位于 Agent
外层，所以 from-scratch 与 pi-agent 录制的完成轨迹可以进入同一个固定 dataset。

Stage 10 的 MCP 工具也先进入同一个 core `ToolRegistry`，再适配为 pi-agent `AgentTool`；
因此 `AGENT_MCP_TOOLS` 和 `PI_AGENT_TOOLS`/`AGENT_TOOLS` 两层授权仍然生效。Stage 11 的
Structured Output/ModelRouter 与 Stage 12 的 DurableTaskStore 位于 Agent 外层，可包装
pi-agent 的 `prompt()` 或把 pi-agent handoff 注册成 durable task handler，无需复制内部 loop。

Stage 13 可以通过 `AGENT_KNOWLEDGE_FILE=knowledge.json` 加载带 id、title、text、uri 的
文档数组，再在 `PI_AGENT_TOOLS` 中选择 `search_knowledge`。Stage 14 的
`promptPiAgentWithArtifacts()` 会把同一个 ArtifactStore 中的图片适配为 pi-ai 原生
`ImageContent`，文本文件则作为有明确边界的文字输入。

Stage 15 通过 `PI_AGENT_ROLE`、`PI_AGENT_TENANT_ID`、`PI_AGENT_SUBJECT` 为直接调用版提供
Principal。选中的 tool、动态 Skill 和 workspace 会经过同一个 RBAC；设置这些身份变量后，
memory session 也会自动按 tenant 做 SHA-256 命名空间隔离。MiniMax Key 支持
`MINIMAX_API_KEY_FILE`，Agent/tool 生命周期事件会写入同一个 tenant-scoped audit sink。

!!! warning "Node.js 版本"
    当前 pi-agent 包要求 Node.js 22.19 或更高版本。
