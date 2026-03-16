# 深度 Review 修复计划

本目录对应最新一轮 code review 的 5 个问题修复，目标是继续收紧纯新架构里的隐式状态、双写源和软协议依赖。

里程碑：

- `01-hook上下文与显式落盘.md`
- `02-spawn元数据单一来源.md`
- `03-多任务子agent执行者归属修复.md`
- `04-requester-session精确匹配与清理.md`
- `05-父会话恢复注入与测试收口.md`

统一执行原则：

- 关键落盘操作必须使用显式 `agent_id/dag_id`，不再依赖全局残留上下文。
- `spawn` 生命周期的结构化元数据只能有一个权威来源，另一侧只能做补全或兜底。
- 一个子 agent 执行多个 task 时，`executor_agent_id` 必须指向真实子 agent。
- requester session 恢复必须优先依赖精确标识，不能靠“只剩一个 scope”猜测。
- 父会话恢复要尽量前推到插件 hook 层，不再只靠模型阅读一段文本消息。

统一测试：

- `npm run build`
- `node test_runner.mjs`

统一预期：

- 新增回归全部通过。
- hook、tool、binding、requester scope 的职责边界更明确。
- 父会话恢复链路对模型文本理解的依赖进一步下降。
