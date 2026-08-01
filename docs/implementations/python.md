# Python 版

Python 版位于 `python/from_scratch_agent/`，不依赖任何第三方运行时库。它保持同步 API，
但现在与 TypeScript 版共享 Tools、Memory、Skills 和可靠性策略的设计语义。

## 阅读顺序

1. `types.py`：Tool、ModelProvider 和 Context；
2. `agent.py`：完整循环；
3. `tools.py`：计算器和时间工具；
4. `minimax.py`：国内 MiniMax 协议适配；
5. `registry.py`：按名称加载工具；
6. `memory.py`：内存与 JSON ConversationStore；
7. `skills.py`：读取、选择和注入 SKILL.md；
8. `reliability.py`：timeout、retry 和指数退避；
9. `budget.py`：单次任务的 token / 成本软预算；
10. `runtime.py`：统一读取环境变量；
11. `cli.py`：终端交互外壳。

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
AGENT_MEMORY_FILE=.agent-data/conversations.json
AGENT_SESSION_ID=python-cli
AGENT_SKILLS_DIR=skills
AGENT_SKILLS=tool-first
AGENT_MODEL_TIMEOUT_MS=120000
AGENT_MODEL_MAX_RETRIES=1
AGENT_RETRY_DELAY_MS=500
AGENT_MAX_RETRY_DELAY_MS=8000
AGENT_MAX_TOTAL_TOKENS=120000
```

不设置 `AGENT_MEMORY_FILE` 时仍是纯内存对话；不设置 `AGENT_SKILLS` 时不会加载任何
skill。工具参数会在执行前通过与 TypeScript 版相同的 JSON Schema 子集校验。

Python 无法安全地强制终止任意同步函数，因此教学版 timeout 使用 daemon worker 停止
外层等待，同时 MiniMax provider 自身也设置 socket timeout。生产级异步服务建议改用
asyncio/httpx，而不是无限增加后台线程。

预算语义也与 TypeScript 版一致：每次 `run()` 重新累计，MiniMax 返回一条完整响应后产生
`usage` 事件，达到上限时不再开始下一次模型调用。需要成本预算时，再按 `.env.example`
填写 `AGENT_MAX_COST`、币种和当前套餐的真实 token 单价。

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
