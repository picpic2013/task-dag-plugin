---
name: task-dag
description: "Use for complex task orchestration with DAG dependencies, subagent bindings, deterministic hook cleanup, and parent-session continuation."
---

# Task DAG

当任务同时满足以下任一条件时，应使用这个 skill：

- 需要显式的任务拆分和依赖关系
- 需要多个子 agent 并行工作
- 需要父 agent 和子 agent 混合执行
- 需要在子 agent 完成后，让父会话继续处理并可能继续给用户发消息
- 需要尽量减少对模型记忆协议的依赖

## 核心原则

1. 优先使用插件提供的高层工具，不要自己拼低层协议。
2. 不要把 `task_dag_wait` 当成阻塞工具。
3. 父会话的“继续”使用 `task_dag_continue`，不是恢复旧工具调用。
4. 子 agent 完成后的状态推进主要依赖 hook 和 pending events。
5. 只有在需要兼容旧流程时才使用 `task_dag_update`、`task_dag_notify` 这类旧接口。

## 当前推荐流程

### 父 agent 直接执行 task

```bash
task_dag_claim task_id="t1" executor_type="parent"
task_dag_progress task_id="t1" progress=40 message="处理中"
task_dag_complete task_id="t1" output_summary="已完成"
task_dag_continue task_id="t1"
```

### 子 agent 执行单个 task

```bash
task_dag_spawn task_id="t1" task="完成这个子任务" target_agent_id="worker"

# 父会话后续新一轮里
task_dag_continue task_id="t1"
```

### 一个子 agent 处理多个 task

```bash
task_dag_spawn task_id="t1" task="先做第一个任务" target_agent_id="worker"
task_dag_assign run_id="run-xxx" task_ids=["t2","t3"] executor_agent_id="worker"
task_dag_continue run_id="run-xxx"
```

## 工具选择

### DAG 与查询

- `task_dag_create`
- `task_dag_show`
- `task_dag_ready`
- `task_dag_get`
- `task_dag_context`
- `task_dag_logs`
- `task_dag_resume`

### 父执行

- `task_dag_claim`
- `task_dag_progress`
- `task_dag_complete`
- `task_dag_fail`

### 子执行

- `task_dag_spawn`
- `task_dag_assign`

### 继续与恢复

- `task_dag_wait`
  - 非阻塞检查
- `task_dag_poll_events`
  - 查看未消费事件
- `task_dag_ack_event`
  - 手工确认事件
- `task_dag_continue`
  - 让父会话决定继续等待、触发下游还是回复用户
- `task_dag_reconcile`
  - 修复 hook 时序差异、孤儿 binding、半完成状态

## 如何判断是否该给用户回复

优先用 `task_dag_continue`，不要自己猜。

它会返回：

- `action="continue_waiting"`
  - 还有 active bindings，继续等
- `action="trigger_downstream"`
  - 新的下游任务 ready 了，继续 DAG
- `action="user_reply"`
  - 有新的终态事件，适合给用户输出
- `action="idle"`
  - 没有新的 continuation 动作

还会返回：

- `completed_task_ids`
- `failed_task_ids`
- `ready_task_ids`
- `waiting_task_ids`
- `summary`

## 兼容层说明

### `task_dag_wait`

旧行为：

- 阻塞轮询直到完成

现行为：

- 立即返回 `waiting / completed / failed / notified`

因此：

- 不要在 prompt 里写“spawn 后必须 wait 到结束”
- 应该写“spawn 后由 runtime auto-announce + task_dag_continue 继续”

### `task_dag_update`

仍可用，但更推荐：

- `task_dag_claim`
- `task_dag_progress`
- `task_dag_complete`
- `task_dag_fail`

## 推荐实践

1. 创建 DAG 后，先看 `task_dag_ready`。
2. 父 agent 能自己完成的 task，就直接 claim/progress/complete。
3. 只有确实需要并行或隔离执行时，才用 `task_dag_spawn`。
4. 如果一个 worker 要连续做多个 task，用 `task_dag_assign` 绑定到同一 run/session。
5. 子 agent 完成后，父会话在下一轮使用 `task_dag_continue`。
6. 如果 hook 或时序看起来不一致，使用 `task_dag_reconcile`。

## 反模式

不要这样做：

```bash
sessions_spawn task="..." label="task:t1"
task_dag_wait task_id="t1"   # 当作阻塞工具
```

不要把这些职责压给模型记忆：

- 记住某个 session 到底对应哪个 task
- 自己猜某个 task 属于哪个 DAG
- 自己判断多个 completion 哪一个该给用户输出

这些应优先交给插件的 binding、hook 和 continuation 工具。
