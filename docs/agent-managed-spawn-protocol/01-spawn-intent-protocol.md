# 01 Spawn Intent Protocol

## 设计目标

把当前“插件直接 spawn 子 agent”的设计改造成“插件准备 spawn，agent 自己调用 `sessions_spawn`”。

这一里程碑只解决首次 spawn 的协议边界，不处理多轮 worker session 的后续任务分配。

## 要解决的问题

当前问题是：

- 插件 runtime 中没有 `sessions_spawn`
- 插件不能直接执行 OpenClaw 原生 spawn
- 但插件仍然需要在 spawn 前把 task、dag、requester、label 协议准备好

## 设计方案

### 核心变化

将当前 `task_dag_spawn` 从“执行 spawn”改造成“准备 spawn”。

插件要做的是：

1. 校验 task 当前是否允许进入 subagent 执行
2. 生成 task-dag 专用 label
3. 生成 spawn intent
4. 返回给 agent 一份标准化的 spawn 参数包

随后由 agent 自己调用原生 `sessions_spawn`。

### 关键逻辑

spawn intent 至少要记录：

- `dag_id`
- `task_id`
- `parent_agent_id`
- `requester_session_key`
- `target_agent_id`
- `expected_label`
- `intent_status`

spawn intent 的职责是：

- 为 `subagent_spawned` hook 提供“这次 spawn 本来想干什么”的可查依据
- 避免 hook 在 only-label 场景下必须猜上下文

### 工具协议变化

逻辑上：

- 保留 `task_dag_spawn` 这个名字也可以
- 但语义要改为 “prepare spawn”

返回值应该表达：

- task 是否已进入等待中的预备态
- 应调用的 `sessions_spawn` 参数模板
- 这次 spawn 使用的协议 label

## 执行方案

1. 删除工具内部直接调用 `runtime.sessions_spawn` 的前提
2. 增加 spawn intent 持久化
3. 将 `task_dag_spawn` 改成返回 spawn plan
4. 将 task 状态从 `ready` 推进到新的预备态，或在现有 `waiting_subagent` 中增加更明确的“awaiting_spawn_confirmation”语义
5. 明确只有 `subagent_spawned` hook 才能把预备态升级成正式等待态

## 测试方案

### 单元测试

1. `task_dag_spawn` 不再直接依赖 `runtime.sessions_spawn`
2. `task_dag_spawn` 返回结构化 spawn plan
3. spawn intent 正确落盘
4. 非法状态 task 不能进入 spawn intent

### 集成测试

1. 父 agent 先 prepare spawn，再模拟调用 `sessions_spawn`
2. hook 使用 label + requester session key 成功接上该 intent

## 测试预期结果

1. 插件内部不再出现 “sessions_spawn is not available” 作为主流程错误
2. 所有新的 subagent spawn 都必须先经过 spawn intent
3. spawn 生命周期的权威起点从“插件直接调用 spawn”改成“插件登记 + agent 执行 spawn”
