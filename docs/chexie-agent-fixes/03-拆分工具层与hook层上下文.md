# 03 拆分工具层与 Hook 层上下文

## 修复目标

- 明确工具层和 hook 层的上下文来源不同，避免继续混用。
- 工具层只依赖显式参数，hook 层才依赖 runtime 回调上下文。

## 修复思路

- 将当前统一的上下文解析逻辑拆分为：
  - `setToolExecutionContext(...)`
  - `setHookExecutionContext(...)`
- 工具层不再假设存在 `session.agentId`、`requesterSessionKey` 等 runtime 上下文。
- hook 层继续使用 `ctx.requesterSessionKey`、`ctx.runId`、`ctx.childSessionKey`。
- 清理工具 helper 中对伪 context 的隐式读取。

## 测试方案

1. 工具调用不传 `agent_id`
   - 预期直接报错。
2. hook 事件回调带 `ctx`
   - 预期仍能恢复正确 `agent_id` / `dag_id`。
3. `task_dag_spawn` 与 `subagent_ended` 路径联测。

## 测试预期结果

- 工具上下文来源完全显式。
- hook 上下文恢复能力保持不变。
