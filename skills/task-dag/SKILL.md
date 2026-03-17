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
2. 父会话的“继续”使用 `task_dag_continue`，不是恢复旧工具调用。
3. 子 agent 完成后的状态推进主要依赖 hook、requester session 注册表和 pending events。
4. 不要使用已经移除的旧接口：`task_dag_wait`、`task_dag_update`、`task_dag_notify`。
5. 工具层不依赖隐式 runtime session context；非 `main` agent 必须显式传 `agent_id`。
6. `task_dag_spawn` 是 prepare-spawn 工具；若需要父会话恢复，必须显式传 `requester_session_key`。
7. 单任务子 agent：先 `task_dag_spawn`，再由 agent 自己调用原生 `sessions_spawn`。
8. worker 多轮模式：先 `task_dag_assign`，再由 agent 自己调用原生 `sessions_send`。
9. `task_dag_continue` 必须显式带 continuation scope：`run_id`、`session_key`、`task_id`、`task_ids` 之一。
10. 一旦 task 已进入 subagent 生命周期，父 agent 不应再对同一 task `claim/complete/fail`。
11. 父 agent 的模型是“返回后等触发”，不是“阻塞等待子 agent 完成”。
12. `resume_requested` 是 continuation 的权威事实来源；`sessions_send` 只是唤醒优化。

## 当前推荐流程

### 父 agent 直接执行 task

```bash
task_dag_claim agent_id="main" task_id="t1" executor_type="parent"
task_dag_progress agent_id="main" task_id="t1" progress=40 message="处理中"
task_dag_complete agent_id="main" task_id="t1" output_summary="已完成"
task_dag_continue agent_id="main" task_id="t1"
```

### 子 agent 执行单个 task

```bash
task_dag_spawn agent_id="main" requester_session_key="agent:main:feishu:group:xxx" task_id="t1" task="完成这个子任务" target_agent_id="worker"
sessions_spawn task="完成这个子任务" agentId="worker" label="taskdag:v1:dag=dag-xxx:task=t1"

# 插件会在 ended hook 后主动唤醒父 session
# 父 agent 当前轮次返回；父会话在被唤醒的新一轮里
task_dag_continue agent_id="main" task_id="t1"
```

要求：

- `sessions_spawn` 的参数应直接来自 `task_dag_spawn` 返回的 `spawn_plan`
- 不要手写或重组 `label`
- 不要自己猜 `agentId`、`mode`、`model`

### 一个子 agent 处理多个 task

```bash
task_dag_spawn agent_id="main" requester_session_key="agent:main:feishu:group:xxx" task_id="t1" task="先做第一个任务" target_agent_id="worker"
sessions_spawn task="先做第一个任务" agentId="worker" mode="session" label="taskdag:v1:dag=dag-xxx:task=t1"
task_dag_assign agent_id="main" session_key="agent:worker:subagent:shared-1" task_ids=["t2"]
sessions_send sessionKey="agent:worker:subagent:shared-1" message="处理 task t2"
task_dag_continue agent_id="main" session_key="agent:worker:subagent:shared-1"
```

要求：

- `session_key` 必须来自真实存在的 worker session
- 推荐一轮只给一个 task
- 一轮 worker run 对应一个 ended 收口
- 顺序必须是 `task_dag_assign -> sessions_send`，不要反过来

### 非 `main` agent 示例

```bash
task_dag_create agent_id="chexie" name="Chexie README Flow" tasks=[
  {id:"t1",name:"阅读前端 README",assigned_agent:"parent"},
  {id:"t2",name:"阅读后端 README",assigned_agent:"parent"}
]

task_dag_claim agent_id="chexie" dag_id="dag-xxx" task_id="t1" executor_type="parent" executor_agent_id="chexie"
task_dag_complete agent_id="chexie" dag_id="dag-xxx" task_id="t1" output_summary="前端 README 已总结"
task_dag_continue agent_id="chexie" dag_id="dag-xxx" task_ids=["t1","t2"]
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

- `task_dag_diagnose`
  - 首选诊断入口，判断当前应该 continue、wait、execute_ready 还是 repair
- `task_dag_poll_events`
  - 查看未消费事件；偏调试用途
- `task_dag_ack_event`
  - 手工确认事件
- `task_dag_continue`
  - 让父会话在被插件唤醒后决定继续等待、触发下游还是回复用户
- `task_dag_reconcile`
  - 修复 hook 时序差异、孤儿 binding、半完成状态；不是正常等待工具

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
- `no_new_events`
- `retry_not_recommended`
- `polling_guidance`

如果返回：

- `action="idle"`
- `no_new_events=true`

表示当前没有新的 completion / ready / resume 事件。不要立即再次调用 `task_dag_continue`。
这时优先等待新事件，或先调用 `task_dag_diagnose`。

## 已移除接口

以下旧接口已不再提供：

- `task_dag_wait`
- `task_dag_update`
- `task_dag_notify`

状态推进只能通过：

- `task_dag_claim`
- `task_dag_progress`
- `task_dag_complete`
- `task_dag_fail`

## 推荐实践

1. 创建 DAG 后，先看 `task_dag_ready`。
1.1. 创建 DAG 时显式传 `agent_id`；不要假设会自动继承当前 agent。
2. 父 agent 能自己完成的 task，就直接 claim/progress/complete。
3. 只有确实需要并行或隔离执行时，才用 `task_dag_spawn`，并显式传 `requester_session_key`。
4. `task_dag_spawn` 返回的是 spawn plan，不是已经执行完成的 spawn；下一步要由 agent 自己调用原生 `sessions_spawn`。
5. 如果一个 worker 要连续做多个 task，先 `task_dag_assign`，再调用原生 `sessions_send`。
6. 子 agent 完成后，插件会主动向 requester session 发送 continuation 消息；父会话在被唤醒的新一轮使用 `task_dag_continue`。
6.1. 即使唤醒消息没有成功发出，只要父会话后续进入新一轮，未消费的 `resume_requested` 仍会触发 continuation 注入。
7. 调 `task_dag_continue` 时显式传 `run_id/session_key/task_id/task_ids` 之一，不要空调用。
8. 如果 hook 或时序看起来不一致，使用 `task_dag_reconcile`。
9. worker 模式下一次只分配一个下一轮任务，避免让同一个 ended 收口多任务。
10. 如果不确定当前该继续、等待还是修复，先用 `task_dag_diagnose`。

## 反模式

不要这样做：

```bash
sessions_spawn task="..." label="task:t1"
```

应改为：

```bash
task_dag_spawn agent_id="main" requester_session_key="agent:main:feishu:group:xxx" task_id="t1" task="..."
sessions_spawn task="..." agentId="worker" label="taskdag:v1:dag=dag-xxx:task=t1"
task_dag_continue agent_id="main" task_id="t1"
```

不要把这些职责压给模型记忆：

- 猜当前 DAG 到底属于 `main` 还是某个非 `main` agent
- 记住某个 session 到底对应哪个 task
- 自己猜某个 task 属于哪个 DAG
- 记住哪个 requester session 该在 completion 后被继续唤醒
- 自己判断多个 completion 哪一个该给用户输出
- 把“completion 先发给谁”误当成“能不能继续 DAG”的前提
- 在 worker 多轮模式下，靠消息文本让插件自己猜“这一轮对应哪个 task”
- 在没有 assignment 的情况下，先 `sessions_send` 再补登记
- 手写 task-dag label 或猜测 worker `session_key`
- 子 agent 已接手后，父 agent 继续自己执行同一 task
- 在 `no_new_events=true` 的情况下继续反复调用 `task_dag_continue`

不要省略这些关键参数：

- `agent_id`
- `requester_session_key`
- `task_dag_continue` 的 scope 参数

这些应优先交给插件的 binding、requester session 注册表、hook 和 continuation 工具。
