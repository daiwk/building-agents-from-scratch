# Agent Loop

## 普通聊天与 Agent 的区别

普通聊天通常只调用一次模型：

```text
用户 → 模型 → 文本
```

Agent 允许模型返回一种特殊内容：`tool_call`。宿主程序执行工具后，把结果作为新消息
追加到历史，再次调用模型：

```text
用户 → 模型 → tool_call → 执行函数 → tool_result → 模型 → 文本
```

模型不能直接运行 Python、JavaScript 或 shell。它只是在生成一个结构化请求。真正的
权限、超时和错误处理始终由宿主程序掌握。

## 四个角色

| 角色 | 责任 | 不负责什么 |
|---|---|---|
| Context | 保存 system prompt、消息和可用工具 | 不决定下一步 |
| ModelProvider | 把 Context 发给模型并解析响应 | 不执行工具 |
| Tool | 对参数做真实操作并返回结果 | 不推进循环 |
| Agent loop | 决定何时调用模型、工具和结束 | 不关心具体厂商 API |

## 最小伪代码

```python
messages.append(user_message)

for turn in range(max_turns):
    assistant = model.generate(messages, tools)
    messages.append(assistant)

    if assistant.has_no_tool_call():
        return assistant

    for call in assistant.tool_calls:
        result = execute(call)
        messages.append(result)  # 闭环发生在这里
```

## 为什么必须限制轮次

模型可能反复请求工具，或者收到错误后一直重试。`max_turns` 是资源与安全边界，不只是
调试选项。生产系统还应增加时间、token、成本、工具次数和递归深度预算。

## 下一步

阅读 [Python 实现](../implementations/python.md)，看看这段伪代码如何逐行落地。
