# 05 task_dag_get_parent 参数解析修复

## 修复目标

- 修正 `task_dag_get_parent` 使用 `context || params` 导致显式参数被忽略的问题。

## 修复思路

- 统一改为 `const args = { ...(context || {}), ...(params || {}) }`，确保参数优先于上下文。
- 保持其它工具已经使用的合并方式一致。

## 测试方案

- 新增回归：上下文里给出一个错误的 `parent_agent_id`，参数里给出正确值，验证工具以参数为准。

## 预期结果

- `task_dag_get_parent` 不再因为上下文存在而吞掉用户显式参数。
