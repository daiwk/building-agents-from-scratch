# Python 版

Python 版位于 `python/from_scratch_agent/`，不依赖任何第三方运行时库。它刻意保持同步，
让第一次学习时只关注控制流。

## 阅读顺序

1. `types.py`：Tool、ModelProvider 和 Context；
2. `agent.py`：完整循环；
3. `tools.py`：计算器和时间工具；
4. `minimax.py`：国内 MiniMax 协议适配；
5. `cli.py`：终端交互外壳。

## 运行

```bash
PYTHONPATH=python .venv/bin/python -m from_scratch_agent.cli
```

测试不访问网络：

```bash
PYTHONPATH=python .venv/bin/python -m unittest discover -s python/tests -v
```

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
