# 02 Label And Hook Recognition

## 设计目标

建立 task-dag subagent 的识别协议，同时保证普通 subagent 不被误接管。

## 要解决的问题

当前 hook 必须兼容两种情况：

1. 使用 task-dag 协议的 subagent
2. 完全普通的 OpenClaw subagent

如果没有明确识别协议，hook 会面临两个风险：

- 把普通 subagent 误当成 task-dag
- task-dag subagent 在 ended 时无法稳定回到正确 DAG

## 设计方案

### 核心变化

使用 `sessions_spawn.label` 作为首次识别标记。

要求：

- task-dag 管理的 spawn 必须带协议前缀 label
- 普通 subagent 不要求遵守该前缀

### hook 识别逻辑

`subagent_spawned` hook：

1. 先看 label 是否命中 task-dag 协议前缀
2. 如果未命中，再看是否能通过 spawn intent 命中
3. 若都未命中，则直接忽略

`subagent_ended` hook：

1. 不再依赖 label
2. 按 `runId` / `childSessionKey` 查正式 binding
3. 若没有命中 binding，则忽略，不把它当成 task-dag run

## 执行方案

1. 定义 label 协议格式
2. 将 hook 判断入口统一收敛到“是否命中 task-dag 管理对象”
3. spawned 时将 label 解析结果落盘
4. ended 时完全以 run/session binding 为准，不再回头猜 label

## 测试方案

### 单元测试

1. task-dag label 能被正确识别
2. 普通 label 会被 hook 忽略
3. spawned 可通过 label + intent 建立 binding
4. ended 只会处理已登记 binding 的 run

### 集成测试

1. 普通 `sessions_spawn` 不触发 task-dag 状态推进
2. task-dag `sessions_spawn` 正常进入等待态与收尾链路

## 测试预期结果

1. task-dag 与普通 subagent 共存时互不干扰
2. task-dag hook 只处理已明确标记或登记过的 spawn/run
3. `subagent_ended` 不再靠猜测去关联任务
