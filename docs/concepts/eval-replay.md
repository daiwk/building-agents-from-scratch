# Trace Replay 与 Eval Workbench

Stage 6 定义了安全发布门槛，Stage 7 负责把失败运行变成可以重复执行的回归测试。

## 为什么需要 Replay

每次调用真实模型都会带来随机性、延迟和费用。Replay 保存已经完成的事件与最终输出，之后
可以反复检查 rubric、数据集格式和 gate，而不再次调用模型或工具。

```text
失败 trace → 人工确认失败模式 → promoteTraceToCase()
             → JSONL eval/holdout dataset → replay → diff → report
```

Replay 不能证明新模型在线上一定表现相同。它是快速、确定性的回归层；真实模型 eval、人工
抽查和线上监控仍然不可省略。

## JSONL Dataset

每行是一条独立 case，包含 `id/input/split/expected/rubric/runs`。rubric 只允许明确的
`equals` 或 `contains`；更复杂业务可以实现自己的 `ArtifactEvaluator`。

```bash
npm run eval -- run \
  --dataset examples/evals/dataset.jsonl \
  --baseline examples/evals/baseline.json \
  --candidate examples/evals/candidate.json
```

命令会输出 dataset SHA-256 fingerprint、两版指标、gate 结果和 report 文件路径。gate 失败
时进程退出码为 2，CI 可以据此阻止发布。

Python 使用相同 dataset：

```bash
PYTHONPATH=python .venv/bin/python -m from_scratch_agent.eval_cli \
  --dataset examples/evals/dataset.jsonl \
  --baseline examples/evals/baseline.json \
  --candidate examples/evals/candidate.json
```

## Trace 不变量

`TraceReplayEvaluator` 会拒绝：

- 没有从 `agentStart` 开始或以 `agentEnd` 结束；
- 重复的 tool call ID；
- 没有对应 `toolStart` 的 `toolEnd`；
- 运行结束后仍未完成的工具调用；
- dataset 缺少 eval 或 holdout；
- case/version 和 recorded run 不一致。

Report 使用权限为 `0600` 的原子文件写入。教学实现保存在 JSON；生产环境可替换为数据库或
对象存储，并给 dataset、rubric 和人工标注单独做版本管理。
