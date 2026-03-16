# 01 禁止 Create 静默回退 Main

## 修复目标

- `task_dag_create` 在未显式提供 `agent_id` 时，不再默认把 DAG 建到 `main`。
- 非 `main` agent 不会因为参数遗漏而悄悄污染 `main` 目录。

## 修复思路

- 修改 `task_dag_create` 的执行路径，去掉 `allowDefaultMain: true`。
- 工具层如果无法从显式参数得到 `agent_id`，则直接报错。
- 报错信息明确说明：当前工具调用缺少 `agent_id`，无法确定应写入哪个 agent 的目录。
- 保留 `main` 的显式支持，但必须由调用方明确传入。

## 测试方案

1. `task_dag_create` 不传 `agent_id`
   - 预期失败，错误信息明确要求提供 `agent_id`。
2. `task_dag_create(agent_id="chexie")`
   - 预期成功。
   - DAG 文件应落在 `workspace-chexie/tasks/{dag_id}`。
3. `task_dag_create(agent_id="main")`
   - 预期成功。
   - DAG 文件应落在 `workspace/tasks/{dag_id}`。

## 测试预期结果

- 无显式 `agent_id` 时不会再默默写进 `main`。
- `chexie` 与 `main` 的 DAG 目录隔离清晰。
