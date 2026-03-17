# Migration Guide

这个版本的 Task DAG 已经不再保留旧执行协议的兼容入口。

## 已删除接口

以下旧接口已经移除：

- `task_dag_wait`
- `task_dag_update`
- `task_dag_notify`

以下旧文本协议也不再作为主路径存在：

- `TASK_COMPLETE`
- `TASK_PROGRESS`
- `TASK_FAILED`

## 旧模型与新模型

### 旧模型

```text
create DAG
-> sessions_spawn(label="task:t1")
-> 模型自己等待
-> 模型自己更新状态
```

### 新模型

```text
create DAG
-> task_dag_claim / task_dag_spawn / task_dag_assign
-> agent 自己调用 sessions_spawn / sessions_send
-> hook + bindings + requester session registry + pending events
-> ended hook 主动唤醒 requester session
-> task_dag_continue / task_dag_reconcile
```

## 替代关系

### 替代 `task_dag_wait`

改用：

- `task_dag_continue`

### 替代 `task_dag_update`

改用：

- `task_dag_claim`
- `task_dag_progress`
- `task_dag_complete`
- `task_dag_fail`

### 替代 `task_dag_notify`

改用：

- `task_dag_progress`
- hook + pending events
- `task_dag_continue`

### 替代手工 `sessions_spawn`

改用：

- `task_dag_spawn` 先生成 spawn plan
- 然后由 agent 自己调用原生 `sessions_spawn`

### 替代“worker 多轮直接发消息”

改用：

- `task_dag_assign`
- 然后由 agent 自己调用原生 `sessions_send`

## 数据模型

当前实现以这些文件为唯一主路径：

- `dag.json`
- `task-bindings.json`
- `session-runs.json`
- `pending-events.jsonl`
- `events.jsonl`
- `requester-sessions.json`

## 推荐迁移顺序

1. 把所有 spawn 主路径替换成 `task_dag_spawn -> sessions_spawn`
2. 把状态推进替换成 `claim/progress/complete/fail`
3. 把 worker 多轮分配替换成 `task_dag_assign -> sessions_send`
4. 把父会话继续逻辑替换成 `task_dag_continue`
5. 把异常收尾替换成 `task_dag_reconcile`

## 已知边界

插件已经把主要 continuation 逻辑和 task 收尾逻辑代码化，并在 ended hook 后主动通过 `sessions_send` 唤醒 requester session。

仍然需要注意的边界：

- OpenClaw runtime 仍可能把 completion 直接发给用户
- 插件无法恢复“原来的工具调用栈”，只能触发父 session 新一轮继续
