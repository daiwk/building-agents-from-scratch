# TypeScript 版

TypeScript 版增加了异步工具、取消信号、生命周期 hooks、ContextBuilder、动态 Skill
和 Sub-agent adapter，适合 Node.js 与 Web 应用。核心文件均包含中文注释，也会解释
新人不熟悉的语法。

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
