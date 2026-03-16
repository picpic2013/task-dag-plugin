# Migration Guide

这个文档说明从旧版 Task DAG 使用方式迁移到当前运行模型时，需要注意的兼容变化。

## 变化概览

### 旧模型

```text
create DAG
-> sessions_spawn(label="task:t1")
-> task_dag_wait(阻塞)
-> task 自动 done
```

### 新模型

```text
create DAG
-> task_dag_spawn
-> hook + bindings + pending events
-> task_dag_continue
-> 父会话继续等待 / 触发下游 / 给用户回复
```

## 兼容变化

### `task_dag_wait`

旧行为：

- 在工具内部轮询
- 阻塞直到完成、失败或超时

新行为：

- 非阻塞检查
- 立即返回：
  - `waiting`
  - `completed`
  - `failed`
  - `notified`

迁移建议：

- 不要再把它当成阻塞原语
- 用 `task_dag_continue` 作为父会话后续新一轮的 continuation 工具

### `sessions_spawn + label="task:t1"`

旧建议：

- 业务层自己调用 `sessions_spawn`
- 自己保证 label 正确
- 自己再 `wait`

新建议：

- 优先用 `task_dag_spawn`
- 如果必须直接调用 `sessions_spawn`，仍建议带 `label="task:t1"`
- 但父会话恢复要走 `task_dag_continue`

### `task_dag_update`

旧用途：

- 负责运行、进度、完成、失败全部状态

新建议：

- 用下面这些更明确的高层工具替代：
  - `task_dag_claim`
  - `task_dag_progress`
  - `task_dag_complete`
  - `task_dag_fail`

`task_dag_update` 仍保留兼容，但不再是主路径。

## 数据兼容

当前实现兼容旧数据的原则：

- 保留旧的 `session -> task` 映射读取能力
- 主收尾逻辑迁到 binding 层
- 如果 hook 时序不一致或状态半完成，可以用 `task_dag_reconcile`

新数据文件：

- `dag.json`
- `task-bindings.json`
- `session-runs.json`
- `pending-events.jsonl`
- `events.jsonl`

## 推荐迁移顺序

1. 先把 prompt / skill / 文档里的“阻塞 wait”表述删掉。
2. 把 spawn 主路径改成 `task_dag_spawn`。
3. 把父会话恢复主路径改成 `task_dag_continue`。
4. 把状态推进从 `task_dag_update` 逐步迁到 `claim/progress/complete/fail`。
5. 把多任务 worker 场景改成 `task_dag_assign`。

## 何时用 `task_dag_continue`

在这些场景都应优先用它：

- 子 agent 刚完成，父会话新一轮继续
- 多个子 agent 完成后需要汇总
- 想判断当前是继续等待还是该给用户回复

## 何时用 `task_dag_reconcile`

在这些场景可用它兜底：

- hook 晚到
- completion 已到但 binding 状态不一致
- 旧数据和新 binding 混用
- 重启恢复后的半完成状态

## 已知边界

这个插件版本已经把主要 continuation 逻辑落在插件内部，但它仍依赖 OpenClaw runtime 提供 requester session 的 auto-announce 新一轮处理。

也就是说：

- 插件已经能确定性判断“现在该不该继续回复用户”
- 但“新一轮是否一定发生”仍依赖 runtime 原生 completion flow
