# Tools、Memory、Skills 与 Sub-agent

这些组件经常被混在一个 Agent 类里。教学版把它们分开，因为它们回答的是不同问题：

| 组件 | 回答的问题 | 不负责什么 |
|---|---|---|
| ToolRegistry | 本应用有哪些工具？本 Agent 被授权使用哪些？ | 不执行 Agent loop |
| ConversationStore | 这个 session 之前有哪些消息？ | 不决定本轮发给模型哪些消息 |
| ContextBuilder | 完整历史中的哪些消息进入本轮模型请求？ | 不删除或持久化历史 |
| SkillCatalog | 有哪些指令包？本 Agent 加载哪些？ | 不自动执行代码或开放工具 |
| agentAsTool | 如何把独立 child Agent 委派给父 Agent？ | 不共享父 Agent 私有历史 |

```mermaid
flowchart LR
    TR["ToolRegistry"] -->|"select(names)"| T["AgentContext.tools"]
    CS["ConversationStore"] -->|"load(sessionId)"| M["AgentContext.messages"]
    M -->|"build(context)"| CB["ContextBuilder"]
    SC["SkillCatalog"] -->|"select(names)"| P["system prompt"]
    T --> A["Agent Loop"]
    CB --> A
    P --> A
    A -->|"save(messages)"| CS
```

## 常用工具加载

内置 registry 当前注册：

- `calculator`
- `current_time`

注册不等于授权。只有 `select()` 返回的工具才会进入 AgentContext：

```ts
const registry = createBuiltinToolRegistry();
const tools = registry.select(["calculator"]);

const agent = new Agent({ model, tools });
```

CLI 和 Web UI 通过逗号分隔的环境变量选择：

```dotenv
AGENT_TOOLS=calculator,current_time
```

设置成空字符串表示不开放任何工具。未知名称会在启动阶段直接报错，而不是等模型调用后
才发现。

## Conversation Memory

`ConversationStore` 的协议只有三个方法：

```ts
type ConversationStore = {
  load(sessionId: string): Promise<AgentMessage[]>;
  save(sessionId: string, messages: readonly AgentMessage[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
};
```

项目提供三种实现：

### InMemoryConversationStore

适合测试和单进程临时会话，进程退出后数据消失。

### JsonFileConversationStore

适合本地学习和调试：

```dotenv
AGENT_MEMORY_FILE=.agent-data/conversations.json
```

Web UI 使用浏览器 session id 区分对话；CLI 默认使用 `cli`，也可以设置：

```dotenv
AGENT_SESSION_ID=my-learning-session
```

JSON 写入使用临时文件加 rename，并将文件权限设置为 `0600`。它只保证同一 store 实例
内的写入排队，不适合多个 Node 进程共享。

### SqliteConversationStore

适合需要多个 session、进程重启恢复或多个进程协调写入的本地应用：

```dotenv
AGENT_MEMORY_DATABASE=.agent-data/conversations.sqlite3
```

`AGENT_MEMORY_FILE` 和 `AGENT_MEMORY_DATABASE` 只能选择一个。SQLite 每个 session
保存一行 JSON message 数组，用事务完成覆盖与清除，并等待短暂写锁；TypeScript 使用
Node.js 内置 `node:sqlite`，Python 使用标准库 `sqlite3`，表结构一致且都不增加依赖。
数据库仍是明文，请像对待聊天记录一样限制文件访问和备份范围。需要远程服务、高可用或
细粒度查询时，再实现同一接口接 PostgreSQL，而不是修改 Agent loop。

## 构建本轮 Context

`RecentContextBuilder` 保留最近的完整对话轮次，用字符数近似 token budget：

```ts
const agent = new Agent({
  model,
  contextBuilder: new RecentContextBuilder({
    maxMessages: 40,
    maxCharacters: 50_000,
  }),
});
```

也可以通过环境变量启用：

```dotenv
AGENT_CONTEXT_MAX_MESSAGES=40
AGENT_CONTEXT_MAX_CHARACTERS=50000
```

截断只影响本轮 `ModelRequest`，`AgentContext` 与 ConversationStore 仍保留完整历史。
组件按 user message 划分轮次，所以不会只保留 tool result、却丢掉对应的 tool call。
字符数只是便于理解的近似值；生产系统可以实现同一 `ContextBuilder` 接口，改用 tokenizer、
摘要和检索。

!!! info "Memory 不只是一个数据库"
    ConversationStore 负责保存，ContextBuilder 负责本轮上下文，未来的 MemoryIndex
    负责跨会话检索；三者不应塞进同一个类。

## 读取 SKILL.md

Skill 目录采用简单结构：

```text
skills/
└── tool-first/
    └── SKILL.md
```

文件由 frontmatter 和 Markdown 指令组成：

```markdown
---
name: tool-first
description: 在精确任务中优先使用工具
---

# Tool First

先检查可用工具，再回答。
```

启用：

```dotenv
AGENT_SKILLS_DIR=skills
AGENT_SKILLS=tool-first
```

也可以使用动态发现：

```dotenv
AGENT_SKILLS=auto
```

`SkillCatalog.discover()` 会对最新用户输入与 skill 的 name/description 做透明关键词评分，
`createDynamicSkillHook()` 再把命中的少量 skill 注入 prompt。它不需要额外模型调用，适合
教学和少量 skill；这不是语义检索，skill 数量增加后应替换为 BM25、embedding 或模型路由。

Loader 有意设置以下边界：

- 单个文件最多 256 KiB；
- 教学版 frontmatter 只读取 `name` 和 `description`；
- 只读取 `SKILL.md` 文本；
- 不 import JavaScript、不运行 shell；
- skill 不会自动获得工具权限。

只有 `SkillCatalog.select()` 选中的指令会带明确边界注入 system prompt。把所有 skill
全文都塞给模型会增加噪音、成本和 prompt injection 面积。

## 把 child Agent 作为工具

`agentAsTool()` 是 Sub-agent 的第一个最小原语：

```ts
const researcher = agentAsTool({
  name: "researcher",
  description: "委派一个独立研究任务",
  createAgent: () =>
    new Agent({
      model,
      tools: [searchTool],
      maxTurns: 4,
    }),
});

const parent = new Agent({ model, tools: [researcher] });
```

每次 tool call 都通过 factory 创建新 child，因此不会共享父 Agent 或其他任务的可变
messages。child 只收到结构化 `task`，父级取消信号会继续传递；child 的工具权限、
memory 和 turn budget 都要显式配置。当前返回最终文本，结构化 handoff、depth/token
budget 和并行 scheduler 仍留在后续阶段。

## 下一步扩展点

- ToolRegistry：工具权限、租户策略、lazy loader；
- ConversationStore：加密、TTL、PostgreSQL；
- ContextBuilder：精确 token budget、摘要、检索结果排序；
- SkillCatalog：语义路由、依赖检查和版本信息；
- agentAsTool：结构化 handoff、深度预算和并行 scheduler。

## 三套实现的对应关系

| 能力 | TypeScript from scratch | Python from scratch | pi-agent direct |
|---|---|---|---|
| 工具加载 | `ToolRegistry` | `ToolRegistry` | `PiToolRegistry` + `AgentTool` |
| 参数校验 | 教学 JSON Schema 子集 | 同一 Schema 子集 | pi-agent/TypeBox 原生校验 |
| 会话 memory | JSON / `SqliteConversationStore` | JSON / `SqliteConversationStore` | 通用 JSON/SQLite store + pi messages |
| Skill | `SkillCatalog` | Python `SkillCatalog` | 复用 TypeScript loader/catalog |
| Timeout/retry | `ModelCallPolicy` | Python `ModelCallPolicy` | pi-ai 原生 stream options |
| 最近轮次 Context | `RecentContextBuilder` | 待对齐 | 使用 pi-agent 原生 context |
| Sub-agent adapter | `agentAsTool` | 待对齐 | 待提供对照示例 |
