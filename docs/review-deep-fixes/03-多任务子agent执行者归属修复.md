# 03 多任务子 Agent 执行者归属修复

## 修复目标

- 修正 `assignTasksToSession()` 把 `executor_agent_id` 错写成父 agent 的问题。

## 修复思路

- 为 `SessionRun` 持久化增加 `child_agent_id`。
- `task_dag_spawn` 和 `subagent_spawned` 在创建 session run 时写入真实子 agent。
- `task_dag_assign` 优先使用 `executor_agent_id`，否则退回 `sessionRun.child_agent_id`。
- 当两者都没有时，直接报错，不再回退到父 agent。

## 测试方案

- 验证 `task_dag_spawn` 后 `session-runs.json` 保存 `child_agent_id`。
- 验证 `task_dag_assign` 未显式传 `executor_agent_id` 时，task executor 仍然写入子 agent。
- 验证缺少 `child_agent_id` 且未传 `executor_agent_id` 时，工具报错。

## 预期结果

- 多任务 worker 场景下，task executor 元数据指向真实子 agent。
- 不再出现父 agent 误冒充子 agent 的执行归属。
