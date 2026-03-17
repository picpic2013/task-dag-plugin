# Agent-Managed Spawn Protocol

## 背景

当前 task-dag 插件已经完成了 DAG、binding、hook、continuation、requester session 恢复等基础设施，但有一个前提需要调整：

- 插件代码不能直接调用 OpenClaw 的 `sessions_spawn`
- `sessions_spawn` 是 agent 可调用工具，不是插件 runtime 直接暴露给插件代码的 API

因此，后续架构必须从“插件直接 spawn 子 agent”切换到“agent 自己调用 `sessions_spawn` / `sessions_send`，插件负责生命周期管理”。

## 目标

这套设计要同时满足以下目标：

1. 主 agent 自己调用 OpenClaw 原生 `sessions_spawn`
2. 插件不直接 spawn，但仍然确定性接管 task 生命周期
3. 兼容普通 subagent，不把所有 subagent 都当成 task-dag subagent
4. 支持单次子任务执行
5. 支持一个子 session 多轮对话、每轮完成一个 task
6. 支持父 agent 直接完成 task
7. 尽量依赖 hook、label、binding、registry 和显式 assignment，而不是依赖模型记忆

## 设计原则

### 1. 执行与编排分离

- `sessions_spawn` / `sessions_send` 由 agent 调用
- DAG、binding、assignment、continuation 由插件维护

### 2. 只接管带 task-dag 标记的 subagent

- 普通 subagent 不受影响
- 只有命中 task-dag 协议的 spawn/session 才进入插件管理

### 3. session 和 run 分离

- `childSessionKey` 表示长期 worker 身份
- `runId` 表示某一轮执行
- `subagent_ended` 按 run 收口，不按 session 收口

### 4. 多轮 worker 模式必须显式 assignment

- 后续 `sessions_send` 只负责送消息
- “这一轮消息对应哪个 task”必须由插件显式登记
- 不依赖消息文本内容推断 task

## 核心对象

### DAG

一个任务图。

### Task

一个任务节点。关注：

- 当前状态
- 当前执行者
- 当前等待对象
- 输出摘要

### Worker Session

一个长期存在的子 session，可多轮处理任务。

### Run

一个具体执行轮次。一个 worker session 可以对应多个 run。

### Spawn Intent

一次“即将新建 subagent session 处理 task”的预登记对象。

### Assignment Intent

一次“将某个 task 分配给现有 worker session 下一轮处理”的预登记对象。

## 协议分层

### 第一层：OpenClaw 原生执行协议

由 agent 直接调用：

- `sessions_spawn`
- `sessions_send`

### 第二层：task-dag 生命周期协议

由插件和 hook 维护：

- spawn intent
- assignment intent
- task/session/run binding
- requester session scope
- pending events
- continuation

## 两种执行模式

### 模式 A：单任务子 agent

流程：

1. 父 agent 选择 ready task
2. 父 agent 调用插件工具准备 spawn
3. 父 agent 按插件返回的协议调用 `sessions_spawn`
4. `subagent_spawned` hook 建立正式 binding
5. task 进入 `waiting_subagent`
6. `subagent_ended` hook 收口该 run 对应 task
7. 插件触发 continuation
8. 父 session 继续 DAG

### 模式 B：多轮 worker session

流程：

1. 父 agent 首次创建 worker session
2. `subagent_spawned` hook 登记 worker session
3. 父 agent 分配 task A：
   - 先调用插件工具登记 assignment
   - 再调用 `sessions_send`
4. run 结束，`subagent_ended` hook 收口 task A
5. 父 agent 分配 task B：
   - 再次登记 assignment
   - 再次 `sessions_send`
6. 重复以上过程

## 协议识别方式

### 首次 spawn 识别

通过 `sessions_spawn.label` 识别。

逻辑要求：

- 普通 subagent：插件忽略
- task-dag subagent：label 必须使用 task-dag 协议前缀

### 后续多轮识别

不能只靠 hook 自动推断。

需要：

- spawned 时建立 session registry
- 每次后续分配 task 前登记 assignment intent
- ended 时通过 `runId` / `childSessionKey` 回查当前 active assignment

## Hook 使用边界

### `subagent_spawned`

用于：

- 识别 task-dag spawn
- 将 spawn intent 转为正式 binding
- 建立 `requesterSessionKey / dag / task / run / session` 映射

### `subagent_ended`

用于：

- 基于 `runId` 或 `childSessionKey` 查找 binding / assignment
- 收口任务
- 推进 downstream
- 触发 continuation

## 为什么不能只靠 hook

对于同一 worker session 的多轮任务：

- `sessions_send` 不会像 `sessions_spawn` 一样提供新的 task-dag label 生命周期
- 没有我目前确认存在的“任意自定义 metadata 透传给 hook”的机制
- 因此后续每轮任务都必须先在插件里显式登记 assignment

## 架构变更总览

当前架构需要完成以下方向性调整：

1. 废弃“插件直接调用 `api.runtime.sessions_spawn`”的设计
2. 将 `task_dag_spawn` 改造成“prepare spawn”语义
3. 引入 spawn intent
4. 引入 assignment intent
5. 将 worker session 多轮模型纳入正式状态机
6. 将 `subagent_spawned` / `subagent_ended` 改为围绕 intent + binding 运转
7. 保留 `task_dag_continue`，但让它消费新事件流

## 里程碑

1. [01-spawn-intent-protocol.md](/root/workspace/task-dag-project/task-dag-plugin/docs/agent-managed-spawn-protocol/01-spawn-intent-protocol.md)
2. [02-label-and-hook-recognition.md](/root/workspace/task-dag-project/task-dag-plugin/docs/agent-managed-spawn-protocol/02-label-and-hook-recognition.md)
3. [03-worker-session-assignment-protocol.md](/root/workspace/task-dag-project/task-dag-plugin/docs/agent-managed-spawn-protocol/03-worker-session-assignment-protocol.md)
4. [04-ended-reconciliation-and-continuation.md](/root/workspace/task-dag-project/task-dag-plugin/docs/agent-managed-spawn-protocol/04-ended-reconciliation-and-continuation.md)
5. [05-migration-skill-readme-and-tests.md](/root/workspace/task-dag-project/task-dag-plugin/docs/agent-managed-spawn-protocol/05-migration-skill-readme-and-tests.md)

## 完成标准

完成这套协议后，应达到：

1. 插件不再直接依赖 `api.runtime.sessions_spawn`
2. 普通 subagent 与 task-dag subagent 可以并存
3. 单 task subagent 模式可稳定工作
4. 多轮 worker session 模式可稳定工作
5. `subagent_ended` 可多次按 run 收口同一 session 的不同任务
6. 父会话 continuation 继续保持确定性
