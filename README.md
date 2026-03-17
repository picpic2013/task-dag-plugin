# Task DAG

Task DAG 是一个面向 OpenClaw 的任务编排插件，用来管理复杂任务的 DAG、子 agent 分工、事件收尾和父会话继续处理。

当前实现已经切换到 agent-managed spawn 模型。核心运行模型不再是“插件直接 spawn 子 agent”，而是“agent 调原生 `sessions_spawn` / `sessions_send`，插件负责 intent、hook、binding、pending events 和 parent continuation”。

## 两种执行模式

同一个 `ready` task 只能选一条路：

```text
父 agent 自己执行:
task_dag_claim -> task_dag_progress -> task_dag_complete
```

```text
交给子 agent 执行:
task_dag_spawn -> sessions_spawn(直接使用 spawn_plan) -> task_dag_continue
```

不要先 `task_dag_claim` 再 `task_dag_spawn`。
不要手写或覆盖 `spawn_plan.label`。

这意味着：

- 子 agent 完成后的收尾主要依赖 `subagent_spawned` / `subagent_ended` hook
- 父会话继续输出不再只依赖模型记得下一轮调用 `task_dag_continue`
- 插件会在 ended hook 后主动向 requester session 发送 continuation 消息
- 父 agent 的正确模型是：逻辑上等待，执行上返回；后续靠 continuation 触发新一轮继续
- `resume_requested` 是 continuation 的权威事实来源；`sessions_send` 只是唤醒优化
- 一个子 agent 可以绑定多个 task
- 父 agent 也可以直接 claim/complete/fail task，不必强制走子 agent
- 普通 subagent 不会被 task-dag hook 接管；只有带 task-dag 协议 label 或已登记 session/run 的子 agent 会进入这条链路

## 显式上下文要求

当前版本不再依赖工具层的隐式 runtime session context。使用 task-dag 工具时，应遵守下面的硬规则：

- 非 `main` agent 必须显式传 `agent_id`
- `task_dag_create` 不会再静默回退到 `main`
- `task_dag_spawn` 是 prepare-spawn 工具；若希望父会话在子 agent 完成后继续处理，必须显式传 `requester_session_key`
- `task_dag_continue` 必须显式提供 continuation scope：
  - `run_id`
  - `session_key`
  - `task_id`
  - `task_ids`
  以上至少一个

如果不满足这些条件，工具会直接报错，而不是猜测上下文。

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

- `task_dag_diagnose`
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
task_dag_create agent_id="main" name="复杂项目" tasks=[
  {id:"t1",name:"调研"},
  {id:"t2",name:"分析",dependencies:["t1"]},
  {id:"t3",name:"报告",dependencies:["t2"]}
]
```

### 2. 父 agent 直接执行

```bash
task_dag_claim agent_id="main" task_id="t1" executor_type="parent" message="开始调研"
task_dag_progress agent_id="main" task_id="t1" progress=50 message="已完成一半资料收集"
task_dag_complete agent_id="main" task_id="t1" output_summary="调研已完成"
task_dag_continue agent_id="main" task_id="t1"
```

边界：

- 一旦 task 已进入 subagent 生命周期（prepared spawn / active binding / active assignment），父 agent 不应再 `claim/complete/fail` 该 task
- 这类 task 默认应由 subagent hook 或带 `session_key/run_id` 的 subagent-scoped 收口来推进

### 3. 子 agent 执行单个任务

```bash
task_dag_spawn agent_id="main" requester_session_key="agent:main:feishu:group:xxx" task_id="t2" task="完成分析工作并给出结论" target_agent_id="worker"

# 直接使用上一步返回的 spawn_plan
# 不要先 claim，不要手写 label
sessions_spawn task="完成分析工作并给出结论" agentId="worker" label="taskdag:v1:dag=dag-xxx:task=t2"

# 父会话在被 runtime 新一轮唤醒后继续
task_dag_continue agent_id="main" task_id="t2"
```

### 4. 一个子 agent 处理多个任务

```bash
task_dag_spawn agent_id="main" requester_session_key="agent:main:feishu:group:xxx" task_id="t1" task="先做第一个子任务" target_agent_id="worker"
sessions_spawn task="先做第一个子任务" agentId="worker" mode="session" label="taskdag:v1:dag=dag-xxx:task=t1"

# 同一个 worker session 下一轮处理 t2
# session_key 必须来自真实已存在的 worker session，不要手写猜测
# 推荐一轮只分配一个 task；一轮 worker run 对应一个 ended 收口
task_dag_assign agent_id="main" session_key="agent:worker:subagent:shared-1" task_ids=["t2"]
sessions_send sessionKey="agent:worker:subagent:shared-1" message="处理 task t2：整理第二部分结果"

# ended 后父会话继续
task_dag_continue agent_id="main" session_key="agent:worker:subagent:shared-1"
```

### 5. 非 `main` agent 示例

`chexie` 这类非主 agent 必须显式声明 `agent_id`，否则 DAG 创建会直接失败：

```bash
task_dag_create agent_id="chexie" name="Chexie README Flow" tasks=[
  {id:"t1",name:"阅读前端 README",assigned_agent:"parent"},
  {id:"t2",name:"阅读后端 README",assigned_agent:"parent"}
]

task_dag_claim agent_id="chexie" dag_id="dag-xxx" task_id="t1" executor_type="parent" executor_agent_id="chexie"
task_dag_progress agent_id="chexie" dag_id="dag-xxx" task_id="t1" progress=50 message="正在阅读前端 README"
task_dag_complete agent_id="chexie" dag_id="dag-xxx" task_id="t1" output_summary="前端 README 已总结"
task_dag_continue agent_id="chexie" dag_id="dag-xxx" task_ids=["t1","t2"]
```

## 子 agent 与父会话的协作方式

### 单子任务

```text
task_dag_spawn
-> 返回 spawn plan
-> agent 调 sessions_spawn
-> 父 agent 当前轮次返回，不阻塞等待子 agent
-> subagent_spawned hook 建 binding
-> subagent_ended hook 收尾
-> plugin 写 resume_requested
-> plugin 尝试 sessions_send 唤醒 requester session
-> task_dag_continue 读 completion event
-> 父会话决定是否给用户回复
```

### 多轮 worker session

```text
首次 sessions_spawn(mode="session")
-> spawned hook 登记 worker session
-> task_dag_assign 登记下一轮 assignment intent
-> agent 调 sessions_send
-> subagent_ended 按 run + assignment 收口当前 task
-> 父会话继续
```

规则：

- 一个 worker session 可以服务多个 task
- 但推荐一轮只处理一个 task
- 一个 ended 只应收口一个当前 assignment
- 不要先 `sessions_send`，再补 `task_dag_assign`

## Continuation 语义

需要明确：

- completion 最终先发给谁，不是 task-dag 继续执行 DAG 的前提
- task-dag 的前提是：只要 managed subagent run ended，插件就会产出 `resume_requested`
- `sessions_send` 成功时，父会话通常会更快被拉起
- 即使 `sessions_send` 失败，只要父会话后续进入新一轮，`before_prompt_build` 仍会根据未消费的 `resume_requested` 注入继续指令
- `task_dag_continue` 在消费对应 scope 后，会清理该轮 continuation 的 requester scope 与 resume 事件

### 多子任务汇总

```text
多个 completion event 到达
-> task_dag_continue 检查 active bindings
-> 仍有未完成任务: continue_waiting
-> 全部完成: user_reply
```

### 诊断优先级

如果你不确定当前应该继续、等待还是修复，优先使用：

```bash
task_dag_diagnose agent_id="..." dag_id="..."
```

约定：

- `task_dag_diagnose` 是主诊断入口
- `task_dag_reconcile` 是修复工具，不是正常等待工具
- 不要把 `task_dag_poll_events`、`sessions_list`、`sessions_history` 组合成长期轮询链路

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

说明：

- `main` agent 使用 `.openclaw/workspace/tasks/{dag_id}`
- 非 `main` agent 使用 `.openclaw/workspace-{agent_id}/tasks/{dag_id}`
- 当前版本不会在缺少 `agent_id` 时把非 `main` agent 的 DAG 静默写到 `main`

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
- `task_dag_spawn`（prepare spawn）
- `task_dag_assign`
- `task_dag_continue`
- `task_dag_reconcile`

详细迁移说明见 [MIGRATION.md](/root/workspace/task-dag-project/task-dag-plugin/MIGRATION.md)。

## 常见错误与排查

### `Explicit agent context is required`

原因：

- 调用工具时没有显式传 `agent_id`
- 或者传了 `dag_id`，但没有对应的 `agent_id`

处理方式：

- `main` agent 也显式传 `agent_id="main"`
- 非 `main` agent 例如 `chexie`，必须显式传 `agent_id="chexie"`

### `Task undefined not found`

原因：

- 当前版本之前的典型问题是工具执行签名错位，导致 `task_id` 在执行层丢失
- 如果现在再看到这个错误，优先检查实际 tool call payload 里是否真的传了 `task_id`

处理方式：

- 确认工具调用参数中显式包含 `task_id`
- 确认调用的是当前版本插件，而不是旧构建产物
- 用 `task_dag_get agent_id="..." dag_id="..." task_id="..."` 先验证目标 task 确实存在

### `task_dag_continue` 返回 scope 相关错误

原因：

- `task_dag_continue` 现在不再扫描整个 DAG 猜测范围
- 必须显式提供 `run_id`、`session_key`、`task_id`、`task_ids` 之一

处理方式：

- 父 agent 单 task 收口：`task_dag_continue agent_id="..." dag_id="..." task_id="t1"`
- 多任务 worker 收口：`task_dag_continue agent_id="..." dag_id="..." run_id="run-xxx"`

### `task_dag_continue` 返回 `idle` / `no_new_events=true`

原因：

- 当前 scope 下没有新的 completion / ready / resume 事件
- 这通常表示应等待新的 hook 事件，而不是继续轮询

处理方式：

- 不要立即再次调用 `task_dag_continue`
- 优先等待新的 resume/completion 事件
- 如果不确定当前是“等待”还是“修复”，先调用 `task_dag_diagnose`

### 子 agent 直接把消息发给用户，父 agent 没继续

原因：

- 父会话没有先走 `task_dag_spawn`
- 或者虽然 prepare 成功，但没有按返回的 plan 调原生 `sessions_spawn`
- 或者 worker 模式下没有先 `task_dag_assign` 就直接 `sessions_send`
- 或者 `task_dag_spawn` 没显式传 `requester_session_key`
- 或者后续父会话没有用 `task_dag_continue` 消费 continuation

处理方式：

- 不要直接裸用 `sessions_spawn`
- 先用 `task_dag_spawn agent_id="..." requester_session_key="..." ...`
- 再按返回的 plan 调原生 `sessions_spawn`
- worker 多轮模式下，先 `task_dag_assign`，再 `sessions_send`
- 不要自己手写 task-dag label 或猜测 worker `session_key`
- 子 agent 完成后，父会话在被唤醒的新一轮调用 `task_dag_continue`

注意：

- 即使 completion 已被 runtime 发到用户通道，只要这个 run 是 task-dag managed run，插件仍会尝试产出 parent continuation
- 本插件不要求“completion 一定先发给父 agent”才能继续 DAG

### 父 agent 想接管一个已经交给 subagent 的 task

原因：

- 这个 task 已经存在 prepared spawn、active binding 或 active assignment
- 当前版本默认禁止父 agent 对这类 task 再次 `claim/complete/fail`

处理方式：

- 不要让父 agent继续执行同一 task
- 等待 `subagent_spawned/subagent_ended` 收口
- 若只是判断当前是否应继续，先用 `task_dag_diagnose`

### `tool done ok` 但业务结果仍然是错误

说明：

- transport 层的 `tool done ok` 只表示插件函数正常返回
- 不代表 task-dag 业务语义成功
- 调试时必须同时看工具返回 payload，确认是否有：
  - `error`
  - `success: false`
  - 不符合预期的 `action`

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
- 非 `main` agent（`chexie`）自建 DAG、自执行 task
- OpenClaw runtime 真实 `execute(toolCallId, params, signal, onUpdate)` 调用签名

验证命令：

```bash
npm run build
node test_runner.mjs
```

## Skill

使用说明见 [SKILL.md](/root/workspace/task-dag-project/task-dag-plugin/skills/task-dag/SKILL.md)。
