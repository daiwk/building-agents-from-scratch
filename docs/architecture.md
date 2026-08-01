# 架构说明

## 核心关系

```mermaid
classDiagram
    class Agent {
      +context: AgentContext
      +run(input) AsyncGenerator
      +reset()
    }
    class AgentContext {
      +systemPrompt: string
      +messages: AgentMessage[]
      +tools: Tool[]
    }
    class ModelProvider {
      <<interface>>
      +name: string
      +generate(request) AssistantMessage
      +stream(request) ModelStreamEvent
    }
    class Tool {
      <<interface>>
      +name: string
      +description: string
      +inputSchema: JsonSchema
      +execute(input, context) string
    }
    class AgentHooks {
      +beforeModel(context)
      +beforeTool(call, context)
      +afterTool(call, result, context)
    }
    class ConversationStore {
      <<interface>>
      +load(sessionId)
      +save(sessionId, messages)
      +clear(sessionId)
    }
    class ToolRegistry {
      +register(tool)
      +select(names)
    }
    class SkillCatalog {
      +register(skill)
      +select(names)
      +discover(query)
    }
    class ContextBuilder {
      <<interface>>
      +build(context) BuiltContext
    }
    class MemoryIndex {
      <<interface>>
      +upsert(record)
      +search(query)
      +remove(id)
    }
    class BudgetTracker {
      +record(usage) BudgetSnapshot
      +assertCanStartModelCall()
    }
    class ModelRateLimiter {
      +reserve() number
    }
    class AgentTracer {
      +startSpan(name, options) TraceSpan
    }
    class TraceExporter {
      <<interface>>
      +export(span)
    }
    class SubagentScheduler {
      +run(tasks)
    }
    class StateGraph {
      +addNode(name, node)
      +addEdge(from, to, condition)
      +run(state)
    }

    Agent *-- AgentContext
    Agent --> ModelProvider
    Agent --> ConversationStore
    Agent --> ContextBuilder
    ContextBuilder --> MemoryIndex
    Agent --> BudgetTracker
    Agent --> ModelRateLimiter
    Agent --> AgentTracer
    AgentTracer --> TraceExporter
    Agent --> SubagentScheduler
    SubagentScheduler --> Agent
    StateGraph --> Agent
    AgentContext o-- Tool
    Agent --> AgentHooks
    ToolRegistry --> Tool
    SkillCatalog --> AgentContext
```

`Agent` 只负责持有状态。`agentLoop()` 才是算法，并且也可以脱离 `Agent`
单独使用。这与 pi-agent 暴露高层 `Agent` 和低层 `agentLoop` 的思路一致。

## 一轮调用的数据流

假设用户问“6 × 7 是多少”：

```text
messages = [User("6 × 7 是多少")]
    ↓ model.generate()
Assistant([ToolCall("calculator", { left: 6, right: 7, ... })])
    ↓ tool.execute()
ToolResult("42")
    ↓ append to messages, model.generate() again
Assistant([Text("答案是 42")])
```

历史记录同时是短期 memory，也是模型下一步决策所看到的环境状态。

## Web UI 如何接入

Web UI 没有绕过核心，也没有另写一套 Agent：

```text
Browser
  └─ POST /api/chat
       └─ Agent.run()
            └─ AgentEvent
                 └─ NDJSON response
                      └─ Conversation + Execution trace
```

每个浏览器会话对应一个内存中的 `Agent` 实例。服务端逐行输出 NDJSON，因此工具开始、
工具结束、模型 delta、usage 和完成状态都会立即出现在右侧轨迹中。完整消息仍只在流结束
后写入 history，临时 delta 不会污染下一轮 context。

## 为什么 provider 返回完整消息

`ModelProvider.generate()` 返回完整 `AssistantMessage`，以便初学者先看清控制流。
可选的 `stream()` 已按同一个协议加入：

1. provider 边解析 SSE 边发出 delta event；
2. provider 内部同步聚合 blocks；
3. 聚合完成后 return 同样的 `AssistantMessage`；
4. loop 此时才把完整消息写入 context。

没有 `stream()` 的 provider 自动回退 `generate()`；消息结构和工具协议没有改变。

## Hooks 是扩展腰部

三个 hook 刻意放在 loop 的关键边界：

- `beforeModel`：加载 memory、压缩 context、注入 skill、动态选择模型；
- `beforeTool`：参数校验、权限审批、策略阻断；
- `afterTool`：审计、写长期 memory、更新指标、产生训练轨迹。

hook 可以改变 context，但不应该偷偷执行下一轮循环。控制流始终留在
`agentLoop()`，这样调试时只有一个地方需要检查。

并行工具模式也不改变这个边界：全部 `beforeTool` 先按顺序完成，工具执行阶段才并发；
结果、`afterTool` 和 Context 写入恢复为原始 call 顺序。这样并行只影响耗时，不影响
下一轮模型看到的消息排列。

## Event 与 Trace 的边界

`AgentEvent` 是面向实时界面的临时信号，`TraceSpanRecord` 是面向持久化观测的完成记录。
一次 `agent.run` 是根 span，每次 `gen_ai.chat` 和 `execute_tool` 是它的子 span；三种实现
使用同样的 ID、时间和属性字段。默认不记录 prompt、工具参数或结果，exporter 失败也不会
改变 Agent 的控制流。JSONL 只是教学实现，生产环境可在 `TraceExporter` 边界接 OTel SDK。

## Sub-agent 为什么可以是 Tool

最小组合方式是用已经提供的 `agentAsTool()`，把另一个 `Agent.run()` 包装成
`Tool.execute()`：

```text
parent model → call research_agent tool
             → child Agent loop
             → child final answer as tool result
             → parent model
```

这不需要修改核心。adapter 每次创建独立 child，只传入 task，并向下传递取消信号。
需要并行、显式上下文传递和预算分配时，再新增 scheduler，而不是把这些概念提前塞进
`Agent`。

## 安全边界

模型只能“请求”工具，真正的权限始终在宿主程序：

1. 只注册允许模型使用的工具；
2. 在 `beforeTool` 校验参数和审批；
3. 给文件、网络和 shell 工具设置独立 sandbox；
4. 用 `maxTurns`、timeout、token/cost budget 控制资源；
5. self-evolve 只生成版本化候选物，由 eval 和人工 gate 决定是否启用。
