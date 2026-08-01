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
| ModelProvider | 把 Context 发给模型并解析完整响应或 delta | 不执行工具 |
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

## Streaming 不改变反馈环

支持 streaming 的 provider 会先不断产生临时事件：

```text
textDelta → thinkingDelta → toolArgumentsDelta → 完整 AssistantMessage
```

CLI 和 Web UI 可以立即消费 delta，但 `AgentContext.messages` 此时仍只有之前的完整
消息。只有 provider 正常结束并返回完整 `AssistantMessage`，loop 才把它写入历史：

```ts
const stream = model.stream(request);
while (true) {
  const next = await stream.next();
  if (next.done) {
    context.messages.push(next.value); // 只在这里提交完整消息
    break;
  }
  yield next.value; // 临时 UI 事件
}
```

如果 provider 没有实现 `stream()`，Agent 会自动使用原来的 `generate()`，所以测试模型、
Codex CLI adapter 和初学者自己的最小 provider 不需要立刻改造。

## 同一轮有多个工具时

默认使用 `sequential`：一个工具完成并写入结果后，才执行下一个。这最容易理解，也适合
有副作用或互相依赖的工具。

确认同一轮工具彼此独立后，可以显式开启：

```dotenv
AGENT_TOOL_EXECUTION=parallel
```

并行模式会先按模型输出顺序完成全部 `beforeTool` 检查，再同时启动工具。即使后面的工具
先完成，`toolEnd` 事件和写回 Context 的结果仍保持模型原始顺序，因此下一轮模型看到的
history 是确定的。一个工具失败仍会变成普通 error result，不会取消同批其他工具。

!!! warning "不要盲目并行副作用"
    写同一文件、修改同一数据库记录、依赖前一个工具结果或需要逐个审批的工具，应保持
    `sequential`。并行缩短的是独立 I/O 的等待时间，不会让存在依赖的任务自动变安全。

## 为什么必须限制轮次

模型可能反复请求工具，或者收到错误后一直重试。`max_turns` 是资源与安全边界，不只是
调试选项。生产系统还应增加时间、token、成本、工具次数和递归深度预算。

## 下一步

阅读 [Python 实现](../implementations/python.md)，看看这段伪代码如何逐行落地。
