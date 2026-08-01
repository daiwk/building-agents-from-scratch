# Durable Runtime

内存 checkpoint 能暂停，但进程退出后会丢失。Stage 12 把两类状态放入 SQLite：

- `SqliteGraphCheckpointStore`：保存 state、next node、steps 和 interrupt value；
- `SqliteDurableTaskStore`：保存 task、worker lease、result/error 与 append-only events。

## 恢复流程

```text
enqueue(taskId)
  → worker claim + lease
  → progress events
  → completed / failed

worker 崩溃
  → lease 到期
  → task 回到 pending
  → 新 worker claim
```

同一个 task ID 再次提交相同 kind/payload 会返回已有任务；不同 payload 会报幂等冲突，
避免网络重试悄悄执行另一份工作。

Graph interrupt 也可以在关闭数据库、重新创建 Store 后使用同一 checkpoint ID resume。
Graph 节点本身仍需做到可重试：外部副作用应带幂等键，不能假设“节点只执行一次”。

教学版面向单机和清晰的事务边界。生产队列还需要 heartbeat、dead-letter queue、调度公平、
指标告警和多 worker 竞争测试。
