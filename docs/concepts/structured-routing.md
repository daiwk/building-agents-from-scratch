# Structured Output 与模型路由

Structured Output 的可信边界不在 prompt，而在宿主：

```text
模型文本 → JSON parse → Schema validate
                    ├─ 通过 → typed value
                    └─ 失败 → 有限 repair → 再次 validate
```

repair 不是“让模型确认一次”，而是生成一份新 JSON，再经过完全相同的确定性校验。
`maxRepairAttempts` 防止坏输出形成无限循环。

`ModelRouter` 接收显式 route 列表，可按 task、generator/judge role 或
preferred model 选候选模型。当前模型调用失败后才尝试下一项；Schema 不通过不会被 router
偷偷解释为 provider 故障。

generator 和 judge 分开累计 requests、successes、failures、input/output tokens。这样可以
回答两个不同问题：

- 生成模型是否稳定、成本是多少？
- 评分模型是否稳定、是否正在吞掉评测预算？

LLM judge 仍需拿人工标签验证。路由和 JSON 约束提高工程可靠性，不会自动提高事实准确率。
