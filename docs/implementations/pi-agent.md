# 直接使用 pi-agent

`examples/pi-agent-direct.ts` 用成熟的 pi-agent API 实现同一个 Agent。它不是包装
本项目的 from-scratch 循环，而是直接创建 `Agent`、模型和 `AgentTool`，并复用项目的
SKILL.md loader 与通用 JSON session store。

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
AGENT_MEMORY_FILE=.agent-data/conversations.json
AGENT_SESSION_ID=pi-cli
AGENT_SKILLS_DIR=skills
AGENT_SKILLS=tool-first
```

需要与 from-scratch Agent 隔离时，可以使用 `PI_AGENT_TOOLS`、
`PI_AGENT_MEMORY_FILE`、`PI_AGENT_SESSION_ID`、`PI_AGENT_SKILLS_DIR` 和
`PI_AGENT_SKILLS` 覆盖。
工具执行策略还可以用 `PI_AGENT_TOOL_EXECUTION` 单独覆盖。

- 工具通过 pi-agent 自己的 `AgentTool` 与 TypeBox Schema 校验；
- 历史消息从 `initialState.messages` 恢复；
- `agent_end` listener 被 pi-agent await，memory 保存完成后 `prompt()` 才结束；
- skill 仍然只注入指令，不自动获得工具或代码执行权限。

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

成熟库适合继续做 streaming、复杂 provider 和生产集成；教学版适合定位控制流、修改
协议以及验证自己的架构想法。

!!! warning "Node.js 版本"
    当前 pi-agent 包要求 Node.js 22.19 或更高版本。
