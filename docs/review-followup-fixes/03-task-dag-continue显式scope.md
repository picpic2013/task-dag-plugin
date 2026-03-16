# 03 task_dag_continue 显式 Scope

## 修复目标

- 阻止 `task_dag_continue` 在 scope 缺失时扫描整个 DAG 的 subagent 任务。
- 强制父会话 continuation 在明确 run、session 或 task 范围内进行。

## 修复思路

- 将 continuation scope 约束为至少提供以下之一：
  - `run_id`
  - `session_key`
  - `task_id`
  - `task_ids`
- 若只提供 `session_key` 且关联多个 run，则返回错误，要求补充 `run_id`。
- 删除“默认扫描全 DAG 中所有 subagent task”的退化逻辑。

## 测试方案

- 新增回归：未提供任何 scope 时，`task_dag_continue` 返回错误。
- 新增回归：多 run session 仅传 `session_key` 时返回错误。
- 保留现有单 run、单 task、multi-task continuation 用例，验证主路径不回归。

## 预期结果

- continuation 只处理明确范围内的事件和任务。
- 父会话不会把不相关并行 run 混进同一次汇总。
