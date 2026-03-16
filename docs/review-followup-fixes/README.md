# 后续深度问题修复计划

本目录对应最新一轮只读调研后发现的 6 个后续问题。

里程碑：

- `01-任务文档路径隔离.md`
- `02-session-key多run映射.md`
- `03-task-dag-continue显式scope.md`
- `04-删除任务时清理运行时元数据.md`
- `05-task-dag-get-parent参数解析修复.md`
- `06-notification隔离与降级.md`

统一执行原则：

- 继续收紧“显式上下文”和“单一事实来源”。
- 避免任何跨 DAG、跨 agent 的物理文件碰撞。
- 在 scope 不明确时直接拒绝或要求更精确输入，不再扫描全局猜测。
- 删除或修改 DAG 结构时，同步清理运行时元数据，避免产生长期脏状态。

统一测试：

- `npm run build`
- `node test_runner.mjs`
- `bash test-all.sh`

统一预期：

- 新增回归全部通过。
- 主链路不再依赖含糊的 session/run 解析。
- 文档、绑定、事件和通知都具备至少与 DAG 数据同级别的隔离能力。
