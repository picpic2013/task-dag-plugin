# 04 Requester Session 精确匹配与清理

## 修复目标

- 去掉 requester scope 的启发式单项回退。
- 降低 stale scope 长期堆积导致错误恢复 DAG 的概率。

## 修复思路

- 将 `scope_id` 改为 `requester_session_key + parent_agent_id + dag_id`，避免不同父 agent 的 scope 冲突。
- `findRequesterSessionScope()` 只接受精确匹配：
  - 优先 `run_id`
  - 其次 `task_id`
  - 再次显式 `dag_id`
  - 不再因为“只剩一个 scope”就自动返回
- `completeRequesterSessionRun()` 在 `active_run_ids` 和 `active_task_ids` 全清空后，直接删除 scope。

## 测试方案

- 构造同一 requester session 下多个 scope，验证无 `run_id/task_id/dag_id` 时不会瞎匹配。
- 验证 `completeRequesterSessionRun()` 后空 scope 会被清理。

## 预期结果

- hook 恢复 DAG 时优先依赖确定性标识，而不是数量启发式。
- requester scope 不会无限堆积为陈旧垃圾数据。
