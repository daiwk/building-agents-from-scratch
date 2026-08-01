# 可靠性模块

最小 Agent loop 让流程跑通之后，最先应该补的不是 multi-agent，而是几条基础防线：

```mermaid
flowchart LR
    A["模型调用"] --> B{"超时？"}
    B -- "是" --> C{"临时错误且<br/>还有重试次数？"}
    C -- "是" --> D["指数退避后重试"]
    C -- "否" --> E["停止并报告错误"]
    B -- "否" --> F["解析 tool call"]
    F --> G{"参数通过 Schema？"}
    G -- "否" --> H["错误作为 tool result 写回"]
    G -- "是" --> I["执行工具"]
```

## 工具参数校验

JSON Schema 不只是给模型看的提示。模型输出是不可信的外部输入，必须在执行函数前再次
校验。

`src/core/tool-validation.ts` 实现了教学项目当前需要的子集：

- `required`：必填字段；
- `type`：字符串、数字、布尔值、数组、对象等；
- `enum`：允许值集合；
- `additionalProperties: false`：拒绝未知字段。

校验失败不会让 Agent 直接崩溃，也不会执行工具。错误会成为 `tool` 消息进入 Context，
模型可以在下一轮修正参数。

!!! warning "这是可读性优先的 Schema 子集"
    它不是完整 JSON Schema 实现。生产项目需要复杂的嵌套结构、格式或组合关键字时，
    应替换为 Ajv 等成熟 validator。

## Timeout

`src/core/model-call.ts` 用 `Promise.race` 限制单次模型调用时间，同时把 AbortSignal 传给
provider。即使某个 provider 忽略取消信号，外层 Agent 也能及时结束等待。

```ts
const agent = new Agent({
  model,
  modelCall: {
    timeoutMs: 30_000,
  },
});
```

`timeoutMs: 0` 表示不设置超时，但用户主动取消仍然有效。

## Retry 与指数退避

不是所有失败都应该重试：

| 错误 | 默认重试 | 原因 |
|---|---:|---|
| timeout / 网络断开 | 是 | 下一次可能恢复 |
| HTTP 429 | 是 | 临时限流 |
| HTTP 5xx | 是 | 服务端临时故障 |
| API Key 无效 | 否 | 重试无法修复 |
| 请求参数错误 | 否 | 必须修改请求 |

每次重试前的等待时间按 `delay × 2^attempt` 增长，并受最大延迟限制。首次请求不计入
`maxRetries`，因此 `maxRetries: 2` 最多会发出三次请求。

```ts
const agent = new Agent({
  model,
  modelCall: {
    maxRetries: 2,
    retryDelayMs: 500,
    maxRetryDelayMs: 8_000,
  },
});
```

CLI 和 Web UI 可以通过 `.env` 配置：

```dotenv
AGENT_MODEL_TIMEOUT_MS=120000
AGENT_MODEL_MAX_RETRIES=1
AGENT_RETRY_DELAY_MS=500
```

## 模型请求限流

`ModelRateLimiter` 把“一个窗口最多 N 次”换算成均匀间隔。例如 60 次/分钟会平滑为
约每秒启动一次模型请求，避免固定窗口在边界处突然放出一批请求：

```dotenv
AGENT_RATE_LIMIT_MAX_REQUESTS=60
AGENT_RATE_LIMIT_WINDOW_MS=60000
```

Limiter 由 `Agent` 持有，而不是每次 `run()` 新建，因此连续任务也不能通过重置计数绕过
限制。等待前会产生 `rateLimitWait` 事件，CLI 和 Web UI 都会明确显示等待时间；用户取消
时，TypeScript 版会立即结束等待。from-scratch TypeScript/Python 版的自动 retry 也共用
同一个 limiter，指数退避较长时通常无需额外等待。

!!! note "这是进程内的平滑限流"
    多进程、多机器或多个 API Key 共享额度时，应把预留状态放到 Redis/网关等集中层。
    pi-agent 示例能限制每个 Agent turn；pi-ai 内部 retry 仍由其原生退避策略管理。

### Streaming 的重试边界

`streamModelWithPolicy()` 在第一个 delta 发给 UI 之前仍可重试临时故障。一旦已经发出
可见 delta，就不会自动重试；否则第二次请求会从头生成，用户可能看到重复文本或重复的
工具参数。此时错误会明确结束本轮，由调用者决定是否重新发起整个任务。

timeout 覆盖整个 stream 生命周期，用户取消也会继续传给 provider 的 SSE 请求。

## Token / 成本预算

`BudgetTracker` 在每次 `Agent.run()` 开始时新建，累计模型返回的 input、output、
cache read 和 cache write token。每个完整模型响应都会产生一个 `usage` 事件，CLI 和
Web UI 可以据此展示本次任务已经消耗的资源。

```ts
const agent = new Agent({
  model,
  budget: {
    maxTotalTokens: 120_000,
    maxCost: 10,
    pricing: {
      currency: "CNY",
      // 请填写你当前套餐或模型的实际单价，不要照抄旧价格。
      inputCostPerMillionTokens: inputPrice,
      outputCostPerMillionTokens: outputPrice,
    },
  },
});
```

CLI 和 Web UI 也可以通过 `.env` 配置。价格和币种都是用户配置，项目不会假设某个
MiniMax 套餐的固定价格：

```dotenv
AGENT_MAX_TOTAL_TOKENS=120000

# 需要成本预算时取消注释，并填入当前套餐的真实数字
# AGENT_MAX_COST=10
# AGENT_COST_CURRENCY=CNY
# AGENT_INPUT_COST_PER_MILLION_TOKENS=
# AGENT_OUTPUT_COST_PER_MILLION_TOKENS=
```

!!! warning "这是 soft budget"
    provider 只有在一次响应结束后才会报告 usage，因此最后一次调用可能越过上限。
    Agent 会在开始**下一次**模型调用前停止。配置了预算但 provider 不返回 usage 时，
    Agent 会明确报错，而不是假装预算仍然可信。

预算作用域是一次 `run()`。若要限制整个会话、用户或账户，应在外层服务中持久化累计值，
再把剩余额度传给每次任务。

## 为什么独立成模块

`agent-loop.ts` 仍然只负责“模型 → 工具 → 模型”的控制流。参数校验和模型调用策略可以
单独测试、替换和继续扩展，后续加入熔断时不需要重写 Agent loop。
