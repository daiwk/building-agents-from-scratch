# 直接使用 pi-agent

`examples/pi-agent-direct.ts` 用成熟的 pi-agent API 实现同一个计算 Agent。它不是包装
本项目的 from-scratch 循环，而是直接创建 `Agent`、模型和 `AgentTool`。

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

## 与教学版对照

| 教学版 | pi-agent |
|---|---|
| 手写 `agentLoop()` | `Agent` 内部管理循环 |
| 工具参数是普通 JSON Schema | `Type.Object` 同时提供 Schema 与类型 |
| 自定义少量事件 | 标准 message/tool/agent 生命周期事件 |
| 一个 MiniMax provider | pi-ai 的 provider 与 model registry |

成熟库适合继续做 streaming、复杂 provider 和生产集成；教学版适合定位控制流、修改
协议以及验证自己的架构想法。

!!! warning "Node.js 版本"
    当前 pi-agent 包要求 Node.js 22.19 或更高版本。
