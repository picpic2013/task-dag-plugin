# 05 Chexie 场景回归测试

## 修复目标

- 把这次 `chexie` 的实际失败路径固化为回归测试。
- 防止后续再次出现“建到 main”或“查得到但写不了”的问题。

## 修复思路

- 增加真实场景测试：
  1. `task_dag_create(agent_id="chexie")`
  2. `task_dag_ready(agent_id="chexie", dag_id=...)`
  3. `task_dag_claim(agent_id="chexie", dag_id=..., task_id="t1")`
  4. `task_dag_progress(...)`
  5. `task_dag_complete(...)`
  6. `task_dag_continue(...)`
- 再增加错误路径测试：
  - 不传 `agent_id` 创建 DAG，必须失败。

## 测试方案

- 扩展 `test_runner.mjs`
- 如有必要，增加直接调用 `tool.execute(toolCallId, params, signal, onUpdate)` 的 runtime 风格测试

## 测试预期结果

- `chexie` 的 DAG 只落在 `workspace-chexie`。
- `claim/progress/complete` 全链路正常。
- 无 `agent_id` 的创建请求不会再静默成功。
