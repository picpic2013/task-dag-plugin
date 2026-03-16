# 去兼容化重构计划

本计划用于把 Task DAG 从“新旧协议并存”收敛到“只保留方案 A 的主路径协议”。

当前目标不是继续兼容历史用户，而是主动删除会误导模型走旧架构的接口和兼容层。

## 重构目标

1. 删除阻塞式 wait 思维残留
2. 删除旧的主动 notify 协议
3. 删除万能式 `task_dag_update`
4. 删除文本消息协议 `TASK_COMPLETE / TASK_PROGRESS / TASK_FAILED`
5. 删除旧 `session -> task` 兼容读取路径
6. README / SKILL / 迁移文档只保留新协议

## 新主路径

```text
task_dag_create
-> task_dag_claim / task_dag_spawn / task_dag_assign
-> hook + bindings + pending-events
-> task_dag_continue / task_dag_reconcile
```

## 里程碑

- [01-删除旧执行接口.md](/root/workspace/task-dag-project/task-dag-plugin/docs/decompat-plan/01-删除旧执行接口.md)
- [02-删除旧消息协议与旧映射读取.md](/root/workspace/task-dag-project/task-dag-plugin/docs/decompat-plan/02-删除旧消息协议与旧映射读取.md)
- [03-文档技能与测试矩阵收口.md](/root/workspace/task-dag-project/task-dag-plugin/docs/decompat-plan/03-文档技能与测试矩阵收口.md)
