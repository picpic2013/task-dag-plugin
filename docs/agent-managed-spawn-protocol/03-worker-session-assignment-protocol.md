# 03 Worker Session Assignment Protocol

## 设计目标

支持同一个子 session 多轮对话、每轮处理一个 task。

## 要解决的问题

首次 `sessions_spawn` 之后，后续多轮任务分配通常通过 `sessions_send` 完成。但：

- `sessions_send` 不会再次触发 `subagent_spawned`
- 没有通用自定义 metadata 能透传给 hook
- 不能靠消息文本推断“这轮在做哪个 task”

因此需要独立的 assignment 协议。

## 设计方案

### 核心变化

引入 assignment intent。

assignment intent 表示：

- 某个现有 worker session
- 在下一轮执行中
- 被分配去处理哪个 task

### worker 模式主流程

1. 首次 spawn 一个 `mode="session"` 的 worker
2. `subagent_spawned` hook 登记该 worker session
3. 父 agent 想给它下发 task A：
   - 先调用插件 assignment 工具登记 task A
   - 再调用 `sessions_send`
4. run 结束，`subagent_ended` hook 根据当前 assignment 收口 task A
5. 下一轮重复 task B、task C ...

### assignment 的逻辑职责

assignment 必须记录：

- `session_key`
- `run_id` 或“下一轮待绑定 run”
- `dag_id`
- `task_id`
- `parent_agent_id`
- `assignment_status`

assignment 不是 binding 的重复，而是“后续 run 还未 ended 前，这一轮期望处理哪个 task”的声明。

## 执行方案

1. 引入 assignment 持久化结构
2. 新增或重定义 assignment 工具
3. 要求所有多轮 worker 任务分配必须先 assignment，再 `sessions_send`
4. `subagent_ended` 通过 assignment 找到这轮 task
5. task 完成后 assignment 标记为已消费/已收口

## 测试方案

### 单元测试

1. 一个 session 可被多次 assignment 到不同 task
2. 未 assignment 的 `sessions_send` 不应被 task-dag ended 收口
3. assignment 收口后会从 active 状态移除

### 集成测试

1. worker session 第 1 轮处理 task A，ended 收口 A
2. 同一 session 第 2 轮处理 task B，ended 收口 B
3. 同一 session 不会把 task A 的 ended 误记到 task B

## 测试预期结果

1. 同一 child session 可多轮、多 task 稳定工作
2. 每轮任务的归属由 assignment 明确决定
3. 不需要依赖消息文本解析来确定 task
