# 04 spawn事件单一来源

## 问题所在

当前 `task_dag_spawn` 和 `subagent_spawned` hook 都会写入 `subagent_spawned` 事件，形成双写。工具侧事件没有 dedupe key，hook 侧有 dedupe key，导致事件流噪声和职责不清。

## 修复思路

- 明确 `subagent_spawned` 生命周期事件只由 hook 写入。
- `task_dag_spawn` 只做：
  - runtime spawn
  - session run 落盘
  - binding 落盘
  - task 状态切换到 `waiting_subagent`
- 如需工具侧可见性，只在 task log 中记录 spawn 行为，不再单独写 pending event。

## 测试

- 更新测试：调用 `spawnTaskExecution()` 后，不再断言存在工具侧 `subagent_spawned` event。
- 保留 hook 测试：`subagent_spawned` hook 仍应写出唯一 `subagent_spawned` pending event。
- 新增测试：同一次 spawn + hook 执行后，`subagent_spawned` 事件只有一条。

## 测试预期结果

- `subagent_spawned` 事件只存在一个权威来源。
- continuation 与调试视图中不会出现重复 spawn 事件。
