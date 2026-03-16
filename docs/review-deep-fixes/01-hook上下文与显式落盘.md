# 01 Hook 上下文与显式落盘

## 修复目标

- 去掉 `subagent_ended` 注册逻辑对 `dag.getCurrentAgentId()` 的二次依赖。
- 降低 hook 执行期间全局 DAG 上下文泄漏到后续逻辑的风险。

## 修复思路

- 为 hook 增加 `withHookDagContext()` 包装器，进入 hook 时保存旧上下文，退出时恢复。
- `handleSubagentEndedEvent()` 返回显式 `agent_id`，后续 `resume_requested` 的查重和落盘全部使用返回值里的显式上下文。
- `subagent_spawned` 和 `subagent_ended` 内部的 DAG 读写都在显式上下文块中完成。

## 测试方案

- 增加 hook 回归，验证 `subagent_ended` 写出的 `resume_requested` 事件落在正确 DAG。
- 增加上下文恢复测试，验证 hook 执行后全局 DAG 指针回到先前值。

## 预期结果

- `resume_requested` 不再因为全局上下文漂移写错目录。
- hook 执行结束后，不污染后续工具或其它 hook 的 DAG 指针。
