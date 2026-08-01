# Python 版

Python 版位于 `python/from_scratch_agent/`，不依赖任何第三方运行时库。它保持同步 API，
但现在与 TypeScript 版共享 Tools、Memory、Skills 和可靠性策略的设计语义。

## 阅读顺序

1. `types.py`：Tool、ModelProvider 和 Context；
2. `agent.py`：完整循环；
3. `tools.py`：计算器和时间工具；
4. `minimax.py`：国内 MiniMax 协议适配；
5. `registry.py`：按名称加载工具；
6. `memory.py`：内存、JSON 与 SQLite ConversationStore；
7. `skills.py`：读取、选择和注入 SKILL.md；
8. `reliability.py`：timeout、retry 和指数退避；
9. `budget.py`：单次任务的 token / 成本软预算；
10. `rate_limit.py`：跨任务共享的模型请求限流；
11. `tracing.py`：零依赖父子 span 与 JSONL exporter；
12. `runtime.py`：统一读取环境变量；
13. `subagents.py`：handoff、预算、event bus 与 scheduler；
14. `graph.py`：独立状态图运行时；
15. `evolution.py`：版本化候选、eval gate、审批、发布与回滚；
16. `cli.py`：终端交互外壳。

Stage 2/3 对照组件位于 `context_builder.py`、`memory_index.py` 和 `skills.py`：Python Agent
现在也会在每次模型请求前调用 ContextBuilder，并支持 tokenizer、摘要、三类长期记忆、
BM25-like Skill 发现、版本和依赖解析。
`subagents.py` 与 `graph.py` 对齐 Stage 4/5。Python 同步线程不能安全强杀阻塞函数，因此
timeout 返回 cancelled 并停止等待；生产版应使用支持协作取消的 asyncio provider。
`evolution.py` 对齐 Stage 6，并继续只使用 Python 标准库。Evaluator 是普通函数，因此可以
接假模型、MiniMax、人工 rubric 或经过人工标注验证的 LLM judge。

## 运行

```bash
PYTHONPATH=python .venv/bin/python -m from_scratch_agent.cli
```

测试不访问网络：

```bash
PYTHONPATH=python .venv/bin/python -m unittest discover -s python/tests -v
```

## 核心组件配置

Python CLI 与 TypeScript CLI 使用相同环境变量：

```dotenv
AGENT_TOOLS=calculator,current_time
AGENT_TOOL_EXECUTION=sequential
AGENT_MEMORY_DATABASE=.agent-data/conversations.sqlite3
AGENT_MEMORY_INDEX_DATABASE=.agent-data/memory-index.sqlite3
AGENT_MEMORY_RECALL_LIMIT=5
AGENT_SESSION_ID=python-cli
AGENT_SKILLS_DIR=skills
AGENT_SKILLS=tool-first
AGENT_MODEL_TIMEOUT_MS=120000
AGENT_MODEL_MAX_RETRIES=1
AGENT_RETRY_DELAY_MS=500
AGENT_MAX_RETRY_DELAY_MS=8000
AGENT_RATE_LIMIT_MAX_REQUESTS=60
AGENT_RATE_LIMIT_WINDOW_MS=60000
AGENT_MAX_TOTAL_TOKENS=120000
AGENT_TRACE_FILE=.agent-data/traces.jsonl
```

需要可直接阅读的文件时，可改用 `AGENT_MEMORY_FILE=.agent-data/conversations.json`；
JSON 与 SQLite 只能选择一个，都不设置时仍是纯内存对话。Python SQLite 版只使用标准库
`sqlite3`，表结构与 TypeScript 版一致。不设置 `AGENT_SKILLS` 时不会加载任何 skill。
工具参数会在执行前通过与 TypeScript 版相同的 JSON Schema 子集校验。

Python 无法安全地强制终止任意同步函数，因此教学版 timeout 使用 daemon worker 停止
外层等待，同时 MiniMax provider 自身也设置 socket timeout。生产级异步服务建议改用
asyncio/httpx，而不是无限增加后台线程。

预算语义也与 TypeScript 版一致：每次 `run()` 重新累计，MiniMax 返回一条完整响应后产生
`usage` 事件，达到上限时不再开始下一次模型调用。需要成本预算时，再按 `.env.example`
填写 `AGENT_MAX_COST`、币种和当前套餐的真实 token 单价。

Python 的 `ModelRateLimiter` 同样跨多次 `run()` 共享，并在等待前产生
`rate_limit_wait`。同步教学版使用 `time.sleep()`；迁移到 asyncio 时可直接替换为
`await asyncio.sleep()`，限流算法不需要改变。

设置 `AGENT_TOOL_EXECUTION=parallel` 后，Python 版使用标准库 `ThreadPoolExecutor`
并发执行同一轮的独立工具；future 虽然并行完成，结果仍按模型原始顺序读取和写回。

`tracing.py` 只使用标准库，并与 TypeScript 输出相同的 JSON 字段。一次 run、每次模型调用
和工具执行形成父子 span；不设置 `AGENT_TRACE_FILE` 时不会创建文件，也没有额外运行开销。

## 为什么用 `yield`

如果 `run()` 只返回最终字符串，外部就不知道模型何时请求工具。生成器允许每走一步就
发出一个事件：

```python
for event in agent.run("6 × 7 是多少？"):
    print(event["type"])
```

Notebook、CLI 和未来的日志系统都能消费相同事件。

## MiniMax 国内版

`MiniMaxProvider` 默认请求：

```text
https://api.minimaxi.com/anthropic/v1/messages
```

它只用标准库 `urllib`，方便读者直接看见 headers、messages 和 tools 如何成为 HTTP
请求。真实项目可以换成支持连接池、重试和异步流式响应的客户端。
