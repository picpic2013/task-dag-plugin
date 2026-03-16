# 02 修正 Execute 签名契约

## 修复目标

- 让插件工具的 `execute` 函数与 OpenClaw runtime 的真实调用签名一致。
- 消除执行类工具中的参数错位问题，彻底去掉 `Task undefined not found`。

## 修复思路

- 更新本地 `plugin-sdk.d.ts` 中 `ToolDefinition.execute` 的类型定义。
- 所有工具统一使用真实签名：
  - `execute(toolCallId, params, signal, onUpdate)`
- 新增统一的工具参数适配层，避免每个工具各自错误理解参数位置。
- 所有执行 helper 改为只接收真实 `params`，不再把第二个参数当作伪 context。

## 测试方案

1. 模拟 runtime 直接调用：
   - `tool.execute("call-1", { agent_id: "chexie", dag_id: "...", task_id: "t1" })`
2. 覆盖工具：
   - `task_dag_claim`
   - `task_dag_progress`
   - `task_dag_complete`
   - `task_dag_fail`
   - `task_dag_spawn`
   - `task_dag_continue`
3. 检查各工具内部收到的 `params.task_id`、`params.agent_id`、`params.dag_id` 是否正确。

## 测试预期结果

- 所有执行类工具都能从真实 `params` 中读取到正确字段。
- 不再出现 `Task undefined not found`。
