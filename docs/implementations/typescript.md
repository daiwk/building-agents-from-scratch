# TypeScript 版

TypeScript 版增加了模型 token streaming、异步工具、取消信号、生命周期 hooks、
ContextBuilder、动态 Skill 和 Sub-agent adapter，适合 Node.js 与 Web 应用。核心文件
均包含中文注释，也会解释新人不熟悉的语法。

MiniMax provider 实现了 Anthropic-compatible SSE；其他 provider 只实现
`generate()` 也仍然可用。streaming 产生 `textDelta`、`thinkingDelta` 和
`toolArgumentsDelta`，完整消息结束后才进入 Agent history。

## 只先认识五个语法

| 语法 | 含义 |
|---|---|
| `type A = ...` | 给一类数据起名字 |
| `x?: string` | 字段可以不存在 |
| `A \| B` | 值可以是 A 或 B |
| `Promise<T>` | 未来才会得到一个 T |
| `async function*` / `yield` | 异步地逐个发出事件 |

不需要先系统学完整门语言。带着这张表阅读 `src/core/types.ts` 和
`src/core/agent-loop.ts` 即可。

## 运行

```bash
npm run dev
```

完整检查：

```bash
npm run check
```

## hooks 放在哪里

- `beforeModel`：加载 memory、压缩 context、选择 skill；
- `beforeTool`：权限、参数校验和人工审批；
- `afterTool`：审计、指标和长期记忆。

hooks 可以改变上下文，但不应该偷偷推进下一轮。这样所有控制流仍能在一个文件中追踪。

## 快速启用 Context 与动态 Skill

```dotenv
# 只限制本轮发给模型的快照，完整历史仍会持久化
AGENT_CONTEXT_MAX_MESSAGES=40
AGENT_CONTEXT_MAX_CHARACTERS=50000

# 根据最新用户输入匹配少量 SKILL.md
AGENT_SKILLS=auto
```

`RecentContextBuilder` 使用字符数近似 token 数并保留完整轮次。`AGENT_SKILLS=auto`
使用确定性关键词匹配，适合学习和小型 skill 集合，不等同于语义检索。

## 配置模型请求速率

```dotenv
AGENT_RATE_LIMIT_MAX_REQUESTS=60
AGENT_RATE_LIMIT_WINDOW_MS=60000
```

这会平滑为约每秒一次请求，状态在同一个 `Agent` 的多次 `run()` 间共享。CLI/Web 收到
`rateLimitWait` 后会显示具体等待时间，取消请求也能中止等待。

## 顺序或并行执行工具

```dotenv
AGENT_TOOL_EXECUTION=parallel
```

默认值是 `sequential`。并行模式用 `Promise.all` 重叠执行工具，但结果仍按模型生成 tool
call 的顺序写入 Context。只有确认工具彼此独立、没有共享写入时才应开启。

## 配置一次任务的预算

```dotenv
AGENT_MAX_TOTAL_TOKENS=120000

# 需要成本预算时取消注释，并填入当前套餐的真实数字
# AGENT_MAX_COST=10
# AGENT_COST_CURRENCY=CNY
# AGENT_INPUT_COST_PER_MILLION_TOKENS=
# AGENT_OUTPUT_COST_PER_MILLION_TOKENS=
```

预算在每次 `Agent.run()` 时重新计算。MiniMax provider 会返回 usage，因此 CLI 和 Web UI
能展示累计 token 和估算成本；实验性的 Codex CLI 后端不提供可核验的 usage，配置预算时
会直接拒绝启动，避免显示一个不可信的数字。价格请按你的当前套餐自行填写。

预算在一次响应结束后才更新，所以它会阻止的是**下一次**模型调用，而不是截断已经开始的
响应。需要账户级硬额度时，应同时使用模型平台的限额和服务端持久化计量。

## 开启 Trace

```dotenv
AGENT_TRACE_FILE=.agent-data/traces.jsonl
```

每次 `Agent.run()` 会产生一个 `agent.run` 根 span；模型请求与工具调用分别成为
`gen_ai.chat` 和 `execute_tool <name>` 子 span。默认不保存 prompt、工具参数和结果。
`TraceExporter` 是可替换接口，JSONL 只用于教学和单机调试；完整字段与接入生产 OTel 的
边界见“可观测性与 Trace”。
