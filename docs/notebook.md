# Notebook：所见即所得地调试

Notebook 位于 `notebooks/agent_from_scratch.ipynb`。它默认使用固定回复的假模型，因而：

- 不需要 API Key；
- 不访问网络；
- 每次执行都有相同结果；
- 可以清楚看到每一轮消息变化。

后半部分继续演示 Stage 2/3：可插拔 token counter、旧历史摘要、三类 MemoryIndex、
Skill 版本和依赖解析，以及 Stage 4/5 的结构化 sub-agent handoff 与 interrupt/resume
Graph，同样不需要 API Key。
最后的 Stage 6 单元格还会离线演示 candidate、eval/holdout、人工审批、发布和回滚。
Stage 7/9 继续演示 deterministic trace replay、workspace 路径边界和长输出 artifact。
Stage 10–12 再用离线 transport、脚本化模型和临时 SQLite 演示 MCP 白名单、JSON repair、
model fallback 以及进程重启后的 durable task 恢复。

## 打开

```bash
.venv/bin/jupyter notebook notebooks/agent_from_scratch.ipynb
```

从上到下逐格运行。你会看到：

1. 模型第一轮产生 `tool_call`；
2. Python 计算器返回 `42`；
3. `tool` 消息进入短期记忆；
4. 模型第二轮回答“答案是 42”；
5. 断言检查整个闭环。

## 重新生成

Notebook 由脚本生成，避免直接手改难以审查的 JSON：

```bash
.venv/bin/python scripts/build_notebook.py
```

生成后执行整本验证：

```bash
.venv/bin/jupyter nbconvert \
  --execute --to notebook --inplace \
  notebooks/agent_from_scratch.ipynb
```

## 可选真实调用

最后一个代码格只有在同时设置下面两个变量时才请求 MiniMax：

```bash
export MINIMAX_API_KEY=你的_Key
export RUN_LIVE_MINIMAX=1
```

这个双开关用来防止“全部运行”时意外消耗额度。
