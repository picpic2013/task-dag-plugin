# 02 Spawn 元数据单一来源

## 修复目标

- 避免 `task_dag_spawn` 和 `subagent_spawned` hook 对同一 `session-run/task-binding` 结构做无差别双写。

## 修复思路

- 保留工具侧的立即落盘能力，确保 `spawn` 返回前 task 已进入 `waiting_subagent`。
- hook 改为“补全或兜底”角色：
  - 若 `session-run` 已存在，则不重复新建。
  - 若对应 active binding 已存在，则不重复新建。
  - 若是外部低层 `sessions_spawn` 绕过工具触发，hook 仍能补建缺失结构。
- hook 继续负责 `subagent_spawned` 事件写入，因为这属于 runtime 生命周期观察结果。

## 测试方案

- 在先调用 `task_dag_spawn` 再触发 `subagent_spawned` hook 的场景下，验证只保留一条 binding 和一个 session run。
- 在只触发 hook、不走工具的场景下，验证 hook 仍能补建缺失结构。

## 预期结果

- 同一 run/session 不再出现重复 binding 或重复 session-run。
- hook 与 tool 的职责边界清晰：工具负责预注册，hook 负责 runtime 生命周期确认。
