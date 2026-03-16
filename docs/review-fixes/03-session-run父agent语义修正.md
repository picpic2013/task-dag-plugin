# 03 Session Run 父 Agent 语义修正

## 问题描述

`saveSessionMapping()` 的兼容路径在创建 `session-run` 时，把 `parent_agent_id` 写成了传入的 `agentId`。在 `subagent_spawned` 场景里，这个值通常代表子 agent，而不是父 agent。

这会导致：

- `session-runs.json` 中 `parent_agent_id` 语义错误
- 后续如果依赖它做恢复、汇总或默认执行者推导，会出现上下文污染

## 修改目标

确保 `session-run.parent_agent_id` 永远表示父 agent，而不是子 agent。

## 修改方案

1. 扩展 `saveSessionMapping()` 参数，显式接收 `parentAgentId`
2. 兼容旧调用：
   - 若传了 `parentAgentId`，优先使用
   - 否则退回当前旧逻辑
3. 在 hook 侧调用 `saveSessionMapping()` 时显式传入父 agent
4. 增加测试验证 `session-runs.json.parent_agent_id` 落盘值正确

## 测试方案

1. 模拟 `subagent_spawned`
2. 让父 agent 为 `main`，子 agent 为 `worker`
3. 调用 hook 后读取 `session-run`
4. 断言：
   - `parent_agent_id === "main"`
   - 不是 `worker`

## 预期结果

- `session-run` 元数据语义一致
- 后续基于 `parent_agent_id` 的恢复逻辑更可靠
- 兼容路径不再把父子 agent 混淆
