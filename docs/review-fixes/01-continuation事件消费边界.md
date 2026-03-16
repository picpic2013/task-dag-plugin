# 01 Continuation 事件消费边界

## 问题描述

`task_dag_continue` 在 `action="continue_waiting"` 时会把当前 scope 内所有 pending events 一起消费，包括 `task_ready`。这会导致：

- 父会话虽然知道“还有子任务在跑”，但同时把后续应该触发的 ready 信号提前吃掉
- 当剩余子任务结束后，父会话可能看不到原本已经 ready 的下游任务事件

## 修改目标

把 `task_dag_continue` 的事件消费策略改成“按动作选择性消费”：

- `continue_waiting`
  - 只消费本轮已处理的 completion 类事件
  - 不消费 `task_ready`
- `trigger_downstream`
  - 消费本轮要处理的 `task_ready`
- `user_reply`
  - 消费本轮已纳入回复摘要的 completion / ready 事件
- `idle`
  - 不消费任何事件

## 修改方案

1. 在 `continueParentSession()` 中按事件类型分组
2. 引入“本轮应消费事件”的选择逻辑，而不是直接把 scope 内全部 pending events 消费掉
3. 保证 `task_ready` 在 `continue_waiting` 分支下仍保留为未消费状态
4. 增加针对 continuation 分支消费差异的测试

## 测试方案

1. 构造一个 run，包含：
   - 一个已完成子任务
   - 一个仍在等待的子任务
   - 一个 `task_ready` 事件
2. 调用 `task_dag_continue`
3. 断言：
   - `action === "continue_waiting"`
   - completion 事件被消费
   - `task_ready` 事件仍未消费
4. 再模拟剩余任务完成，调用 `task_dag_continue`
5. 断言：
   - 最终可以看到 `user_reply` 或 `trigger_downstream`
   - `task_ready` 没有在前一轮被错误丢失

## 预期结果

- 多阶段 continuation 下不会丢 ready 事件
- 多子任务场景的父会话行为更稳定
- continuation 的消费边界与动作语义一致
