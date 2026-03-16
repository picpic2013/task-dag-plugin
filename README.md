# Task DAG

Task DAG 是一个面向 OpenClaw 的任务编排插件，用来管理复杂任务的 DAG、子 agent 分工、事件收尾和父会话继续处理。

当前实现已经完成方案 A 的前六个里程碑中的前五个，并完成了里程碑 06 的文档与迁移收口。核心运行模型已经从“阻塞 wait + 模型自觉维护状态”切换到“binding + hook + pending events + parent continuation”。

## 当前运行模型

推荐流程是：

```text
task_dag_spawn
-> runtime subagent hook
-> plugin requester-session registry
-> ended hook 主动 sessions_send 唤醒父 session
-> task_dag_continue
-> 继续等待 / 触发下游 / 给用户回复
```

这意味着：

- 子 agent 完成后的收尾主要依赖 `subagent_spawned` / `subagent_ended` hook
- 父会话继续输出不再只依赖模型记得下一轮调用 `task_dag_continue`
- 插件会在 ended hook 后主动向 requester session 发送 continuation 消息
- 一个子 agent 可以绑定多个 task
- 父 agent 也可以直接 claim/complete/fail task，不必强制走子 agent

## 核心能力

- DAG 任务状态机
  - `pending / ready / running / waiting_subagent / waiting_children / done / failed / cancelled / blocked`
- 子 agent 绑定层
  - `task-bindings.json`
  - `session-runs.json`
  - `pending-events.jsonl`
  - `requester-sessions.json`
- hook 驱动收尾
  - `subagent_spawned`
  - `subagent_ended`
- 父会话 continuation
  - 单子任务完成后继续
  - 多子任务汇总后再回复
  - 重复 completion 去重

## 推荐工具

创建与查询：

- `task_dag_create`
- `task_dag_show`
- `task_dag_ready`
- `task_dag_get`
- `task_dag_context`
- `task_dag_logs`
- `task_dag_resume`

父 agent 直接执行：

- `task_dag_claim`
- `task_dag_progress`
- `task_dag_complete`
- `task_dag_fail`

子 agent 执行：

- `task_dag_spawn`
- `task_dag_assign`

事件与恢复：

- `task_dag_poll_events`
- `task_dag_ack_event`
- `task_dag_continue`
- `task_dag_reconcile`

兼容层：

- `task_dag_modify`
- `task_dag_subtask_create`
- `task_dag_subtask_list`
- `task_dag_set_doc`
- `task_dag_get_doc`

## 快速开始

### 1. 创建 DAG

```bash
task_dag_create name="复杂项目" tasks=[
  {id:"t1",name:"调研"},
  {id:"t2",name:"分析",dependencies:["t1"]},
  {id:"t3",name:"报告",dependencies:["t2"]}
]
```

### 2. 父 agent 直接执行

```bash
task_dag_claim task_id="t1" executor_type="parent" message="开始调研"
task_dag_progress task_id="t1" progress=50 message="已完成一半资料收集"
task_dag_complete task_id="t1" output_summary="调研已完成"
task_dag_continue task_id="t1"
```

### 3. 子 agent 执行单个任务

```bash
task_dag_spawn task_id="t2" task="完成分析工作并给出结论" target_agent_id="worker"

# 父会话在被 runtime 新一轮唤醒后继续
task_dag_continue task_id="t2"
```

### 4. 一个子 agent 处理多个任务

```bash
task_dag_spawn task_id="t1" task="先做第一个子任务" target_agent_id="worker"
task_dag_assign run_id="run-xxx" task_ids=["t2","t3"] executor_agent_id="worker"
task_dag_continue run_id="run-xxx"
```

## 子 agent 与父会话的协作方式

### 单子任务

```text
task_dag_spawn
-> subagent_spawned hook 建 binding
-> subagent_ended hook 收尾
-> plugin sessions_send 唤醒 requester session
-> task_dag_continue 读 completion event
-> 父会话决定是否给用户回复
```

### 多子任务汇总

```text
多个 completion event 到达
-> task_dag_continue 检查 active bindings
-> 仍有未完成任务: continue_waiting
-> 全部完成: user_reply
```

## 数据落盘

任务数据存储在 agent 的 workspace 中：

```text
.openclaw/
├── workspace/
│   └── tasks/{dag_id}/
│       ├── dag.json
│       ├── task-bindings.json
│       ├── session-runs.json
│       ├── pending-events.jsonl
│       └── events.jsonl
├── requester-sessions.json
└── workspace-{agent_id}/
    └── tasks/{dag_id}/
        ├── dag.json
        ├── task-bindings.json
        ├── session-runs.json
        ├── pending-events.jsonl
        └── events.jsonl
```

文件说明：

- `dag.json`
  - DAG 定义、task 状态机、executor/waiting 元数据
- `task-bindings.json`
  - task 与 session/run 的绑定关系
- `session-runs.json`
  - run/session 的一对多任务视图
- `pending-events.jsonl`
  - 给父会话 continuation 消费的事件流
- `events.jsonl`
  - 审计和调试日志
- `requester-sessions.json`
  - `requesterSessionKey -> parentAgentId/dagId/active runs/tasks` 的全局恢复注册表

## 兼容迁移

当前版本已经移除的旧接口有：

1. `task_dag_wait`
2. `task_dag_update`
3. `task_dag_notify`
4. `TASK_COMPLETE / TASK_PROGRESS / TASK_FAILED` 文本协议主路径

当前主流程只保留：

- `task_dag_claim`
- `task_dag_progress`
- `task_dag_complete`
- `task_dag_fail`
- `task_dag_spawn`
- `task_dag_assign`
- `task_dag_continue`
- `task_dag_reconcile`

详细迁移说明见 [MIGRATION.md](/root/workspace/task-dag-project/task-dag-plugin/MIGRATION.md)。

## 测试状态

当前本地回归覆盖了：

- 父 agent 直接完成 task
- 单子 agent 单任务
- 单 session 多任务
- 多 session 并发
- runtime 原始 hook shape
- hook 收尾
- requester session 注册表恢复
- ended hook 主动唤醒父 session
- orphan binding
- 父会话 continuation
- 重复 completion 去重

验证命令：

```bash
npm run build
node test_runner.mjs
```

## Skill

使用说明见 [SKILL.md](/root/workspace/task-dag-project/task-dag-plugin/skills/task-dag/SKILL.md)。
