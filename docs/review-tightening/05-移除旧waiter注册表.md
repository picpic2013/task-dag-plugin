# 05 移除旧 waiter 注册表

## 问题所在

`task_dag_wait` 已删除，但 `spawn/complete/fail` 仍会写 `waiting.json`。该结构：

- 只按 `agent_id` 存一条记录
- 不区分 `dag_id/run_id/session_key`
- 与新 continuation 模型无关

这会造成伪状态和覆盖问题。

## 修复思路

- 删除 `waiter` 模块在主路径中的所有读写。
- 删除对应测试和导入。
- 如需“父会话仍在等待哪些子任务”，统一通过：
  - `task.status === waiting_subagent`
  - active bindings
  - pending events
  - `task_dag_continue`

## 测试

- 删除 waiter 模块相关单元测试。
- 回归测试：spawn/complete/fail/continue 在无 waiter 的情况下继续通过。
- 新增测试：不会生成 `waiting.json`。

## 测试预期结果

- 新架构不再产生 waiter 注册表文件。
- continuation 逻辑完全由 task/binding/event 体系支撑。
