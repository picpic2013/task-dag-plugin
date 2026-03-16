# 02 Session Key 多 Run 映射

## 修复目标

- 支持同一个 `session_key` 关联多个 `run_id`，避免新 run 覆盖旧 run。
- 在需要精确 run 的路径上，禁止用单值 `session_key -> run_id` 猜测。

## 修复思路

- 将 `session-runs.json` 的 `by_session` 从单值映射改为数组映射。
- 新增 `listSessionRunsBySessionKey()`。
- `getSessionRunBySessionKey()` 调整为：
  - 若只有一个匹配 run，返回它
  - 若存在多个活跃 run，返回 `null`，由上层要求显式 `run_id`
  - 若只有一个未完成 run，也可返回该 run
- `assignTasksToSession()`、`continueParentSession()` 等调用方在仅传 `session_key` 且存在多 run 时，直接报错。

## 测试方案

- 新增回归：同一个 `session_key` 保存两个 run，验证 `listSessionRunsBySessionKey()` 返回两个。
- 新增回归：`assignTasksToSession(session_key=...)` 在多 run 冲突时返回错误。
- 新增回归：ended hook 在缺少 `run_id` 且同 session 多 run 时不盲猜。

## 预期结果

- 同一子 session 的多 run 不会互相覆盖。
- 需要精确 run 的路径不再靠 session_key 模糊匹配。
