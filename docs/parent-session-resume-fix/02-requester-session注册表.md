# 02 requester session 注册表

## 修改目标

让插件自己持久化 `requesterSessionKey -> parentAgentId/dagId/active run/task` 关系，使 hook 在收到 runtime 回调时可以恢复父 DAG。

## 问题所在

- runtime 只提供 `requesterSessionKey`
- 当前插件没有稳定的 requester session 注册表
- hook 即使拿到 `requesterSessionKey`，也无法确定这次 completion 属于哪个 DAG

## 执行方案

1. 新增持久化文件
   - 建议文件：`requester-sessions.json`
2. 新增注册表读写模块
   - 保存：
     - `requester_session_key`
     - `parent_agent_id`
     - `dag_id`
     - `active_run_ids`
     - `active_task_ids`
     - `updated_at`
   - 支持：
     - upsert
     - 根据 requester session 查询
     - 在 run 完成后收缩 active runs/tasks
3. 在以下工具接入写入：
   - `task_dag_spawn`
   - `task_dag_assign`
   - `task_dag_continue`
4. 在 hook 中接入查询：
   - `subagent_spawned`
   - `subagent_ended`

## 测试方案

1. 新增测试：`task_dag_spawn` 后会为 requester session 建注册表
2. 新增测试：`task_dag_assign` 会更新 active task/run
3. 新增测试：hook 通过 `ctx.requesterSessionKey` 可恢复正确 DAG

## 预期结果

- requester session 成为插件内可恢复的父会话锚点
- hook 可以在没有 `dagId` 的情况下定位父 DAG
