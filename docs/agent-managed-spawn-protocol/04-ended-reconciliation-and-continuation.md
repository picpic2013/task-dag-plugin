# 04 Ended Reconciliation And Continuation

## 设计目标

让 `subagent_ended` 在单任务模式和 worker 模式下都能稳定收口，并继续驱动父会话 continuation。

## 要解决的问题

OpenClaw 的 `subagent_ended` 是按 run 触发的，而不是按 session 只触发一次。

这意味着：

- 同一个 worker session 会多次 ended
- 每次 ended 都必须只收口当前 run 对应的 task
- 收口之后还要正确推进 downstream 和父会话 continuation

## 设计方案

### ended 收口原则

1. 按 run 收口
2. 若 run 未命中，退回 session + active assignment 收口
3. 若仍未命中，则忽略，不作为 task-dag ended

### 收口动作

`subagent_ended` 命中 task-dag run 后应完成：

1. 关闭该 run 的 active binding / assignment
2. 根据 outcome 推进 task：
   - `done`
   - `failed`
3. 更新 pending events
4. 计算是否有 downstream task 进入 ready
5. 触发 requester session continuation

### continuation 逻辑

保留现有 `task_dag_continue` 主模型，但要让它消费新的 ended / assignment 事件流。

它仍然负责：

- `continue_waiting`
- `trigger_downstream`
- `user_reply`
- `idle`

## 执行方案

1. 调整 ended hook 的解析顺序：run -> session+assignment -> ignore
2. 将 ended 事件和 assignment 状态统一写入 pending events
3. 保持 downstream ready 推进逻辑
4. 保持 requester session 唤醒和 `task_dag_continue` 入口

## 测试方案

### 单元测试

1. 单任务 spawn 的 ended 可正确收口
2. 同一 session 多次 ended 能分别收口不同 task
3. ended 未命中 task-dag binding 时被忽略
4. downstream ready 能正确触发

### 集成测试

1. worker session 连续完成多个 task，每次 ended 都能推动 DAG
2. 父 session 在被唤醒后能继续调用 `task_dag_continue`

## 测试预期结果

1. ended 不再被当成“一次性 session 终态”
2. worker 模式的每轮任务都能独立收口
3. 父会话 continuation 继续保持可预测
