# Review Fix Plan

本目录用于收口最近一次 code review 中确认的 3 个真实问题，并为每个问题提供独立的修复方案、测试方案和预期结果。

## 背景

当前分支已经完成里程碑 01 到 06，但 code review 发现仍有 3 个需要优先修复的问题：

1. `task_dag_continue` 在 `continue_waiting` 分支会过早消费 `task_ready` 事件
2. 兼容层工具没有统一走新的上下文解析，可能在多 DAG / 非 `main` agent 场景下读写错目录
3. `saveSessionMapping()` 的兼容路径把 `session-run.parent_agent_id` 写成了子 agent，语义错误

## 修复顺序

1. 先修 `task_dag_continue` 的事件消费边界
2. 再修兼容层工具的上下文解析
3. 最后修 `session-run.parent_agent_id` 的落盘语义

## 执行原则

- 每个问题单独修改、单独补测试
- 先写文档，再动代码
- 每修完一个问题就保留对应测试，最后跑全量回归

## 对应文档

- [01-continuation事件消费边界.md](/root/workspace/task-dag-project/task-dag-plugin/docs/review-fixes/01-continuation事件消费边界.md)
- [02-兼容层上下文统一.md](/root/workspace/task-dag-project/task-dag-plugin/docs/review-fixes/02-兼容层上下文统一.md)
- [03-session-run父agent语义修正.md](/root/workspace/task-dag-project/task-dag-plugin/docs/review-fixes/03-session-run父agent语义修正.md)
