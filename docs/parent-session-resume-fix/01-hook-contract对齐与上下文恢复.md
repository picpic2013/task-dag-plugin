# 01 hook contract 对齐与上下文恢复

## 修改目标

让插件的 `subagent_spawned/subagent_ended` hook 真正按 OpenClaw 的实际调用方式工作，不再因为 event 字段假设错误而直接失效。

## 问题所在

- OpenClaw 的 hook handler 实际签名是 `(event, ctx)`
- 当前插件只接收 `event`，直接丢掉 `ctx`
- 当前插件错误假设 `event` 自带 `dagId/parentAgentId`
- runtime 实际只在 `ctx` 里提供 `requesterSessionKey/runId/childSessionKey`，而不会把插件需要的 DAG 信息直接放到 `event`

## 执行方案

1. 更新插件本地 SDK 类型
   - `HookHandler` 改为支持第二个 `ctx`
2. 修改 `registerTaskDagHooks`
   - `subagent_spawned` / `subagent_ended` handler 都显式接收 `(event, ctx)`
3. 修改 `handleSubagentSpawnedEvent` / `handleSubagentEndedEvent`
   - 接收 `ctx`
   - 上下文恢复优先从 `ctx.requesterSessionKey / ctx.runId / ctx.childSessionKey` 获取
4. 去掉对 `event.dagId/event.parentAgentId` 的硬依赖

## 测试方案

1. 新增测试：使用 runtime 原始 shape 的 `subagent_spawned(event, ctx)`，`event` 不带 `dagId/parentAgentId`
2. 新增测试：使用 runtime 原始 shape 的 `subagent_ended(event, ctx)`，`event` 不带 `dagId/parentAgentId`
3. 保留现有 hook 测试，确保已有行为不退化

## 预期结果

- hook 不再因为缺少 `event.dagId` 或 `event.parentAgentId` 而直接退出
- runtime 原生 event shape 可以被插件正确消费
