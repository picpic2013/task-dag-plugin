# 05 Migration Skill Readme And Tests

## 设计目标

把 task-dag 从“插件直接 spawn”模型迁移到“agent 自己 spawn / send，插件负责管理”的新协议，并同步文档、skill 和测试矩阵。

## 要解决的问题

如果只改代码而不改 skill / README：

- 模型仍会按旧路径理解 `task_dag_spawn`
- 普通使用者仍会误以为插件自己能直接 spawn
- worker 多轮模式不会被正确使用

## 设计方案

### 文档迁移

README 要明确：

- `task_dag_spawn` 的新语义
- 需要先登记，再调用原生 `sessions_spawn`
- worker 多轮模式需要 assignment + `sessions_send`
- task-dag 只接管带协议 label 的 subagent

SKILL 要明确：

- 什么时候该新建 worker session
- 什么时候该复用已有 session
- 什么情况下必须先 assignment
- 不能直接依赖消息文本让插件猜 task 归属

### 测试迁移

测试矩阵需要覆盖：

1. 普通 subagent 不受 task-dag hook 影响
2. 单任务 spawn intent -> spawned -> ended
3. worker session 多轮 assignment -> send -> ended
4. continuation 在两种模式下都可工作

## 执行方案

1. README 重写运行模型图
2. SKILL 重写推荐流程
3. 新增 worker session 使用示例
4. 新增回归测试矩阵
5. 将旧“插件内部直接 spawn”的表述完全移除

## 测试方案

### 文档回归

1. README 与 SKILL 不再描述插件直接调用 `sessions_spawn`
2. 示例都体现新协议边界

### 代码回归

1. 单任务模式回归
2. worker 多轮模式回归
3. 普通 subagent 兼容性回归

## 测试预期结果

1. 文档、skill、实现三者一致
2. 模型会被引导使用新协议
3. 旧路径不再是推荐主路径
