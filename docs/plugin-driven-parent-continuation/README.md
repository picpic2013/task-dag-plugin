# Plugin-Driven Parent Continuation

## 背景

当前 task-dag 插件已经具备：

1. `task_dag_spawn` / `task_dag_assign` 的显式执行协议。
2. `subagent_spawned` / `subagent_ended` 的生命周期 hook。
3. `binding` / `session run` / `requester scope` / `pending events` 持久化层。
4. `resume_requested + before_prompt_build + task_dag_continue` 的父会话恢复链路。

但这条链路当前仍然有一个核心问题：

- 子 agent 完成后，父 agent 是否能稳定继续执行 DAG，仍然没有被定义成一条足够硬的插件语义。

本轮调研后的结论是：

1. OpenClaw 原生模型不是“父 agent 阻塞等待子 agent 完成后恢复原工具调用栈”。
2. 正确模型应是：
   - 父 agent 发射子 agent
   - 当前轮次返回
   - 子 agent 独立执行
   - runtime 完成 announce / cleanup / hook
   - 插件产出 continuation 信号
   - 父 session 在新一轮被触发后继续执行 DAG
3. 子 agent 完成后到底先对谁说话，不是本轮一等问题。
4. 一等问题是：只要是 task-dag 管理的 subagent run ended，插件就必须稳定触发父 agent 更新上下文并继续执行任务。
5. 普通 subagent 必须保持兼容，不能被 task-dag hook 误接管。

## 调研结论

### OpenClaw 运行时结论

1. `sessions_spawn` 默认仍然是 `expectsCompletionMessage=true`。
2. 子 agent completion 的外部投递路径由 runtime 控制，插件不能完全重写其语义。
3. `subagent_ended` 是确定性收尾信号，但不一定是最早完成信号。
4. requester session 的继续，本质上是“新一轮内部投递”，不是恢复旧工具栈。
5. 因此父 agent 的正确模型应是：
   - 逻辑上等待
   - 执行上返回
   - 后续靠插件 continuation 触发继续

### 对 task-dag 的直接约束

1. 不能再把父 agent 的继续建立在阻塞等待工具上。
2. 必须把 “task-dag managed subagent ended” 定义为 continuation 的一等事实。
3. `sessions_send` 只是唤醒优化，不应作为 continuation 是否成立的前提。
4. `resume_requested` 必须升级为权威 continuation 载体。
5. `before_prompt_build` 必须把“先继续 DAG”前推到父 session 的新一轮上下文。
6. continuation 必须按 run/scope 可持久化、可去重、可重放。
7. 普通 subagent 必须严格隔离，不进入 task-dag continuation 链路。

## 本轮目标

把当前实现从“子 agent 完成后尽量恢复父会话”升级为：

1. 只要 task-dag 管理的 subagent run ended，就必然产出 continuation scope。
2. 父会话被唤醒后的下一轮，优先继续 DAG，而不是自由回复用户。
3. 并发 ended 不会丢 continuation。
4. 普通 subagent 不会被误接管。

## 里程碑

1. [01-续行信号与识别边界硬化.md](/root/workspace/task-dag-project/task-dag-plugin/docs/plugin-driven-parent-continuation/01-%E7%BB%AD%E8%A1%8C%E4%BF%A1%E5%8F%B7%E4%B8%8E%E8%AF%86%E5%88%AB%E8%BE%B9%E7%95%8C%E7%A1%AC%E5%8C%96.md)
2. [02-父会话恢复注入与消费模型重构.md](/root/workspace/task-dag-project/task-dag-plugin/docs/plugin-driven-parent-continuation/02-%E7%88%B6%E4%BC%9A%E8%AF%9D%E6%81%A2%E5%A4%8D%E6%B3%A8%E5%85%A5%E4%B8%8E%E6%B6%88%E8%B4%B9%E6%A8%A1%E5%9E%8B%E9%87%8D%E6%9E%84.md)
3. [03-并发续行持久化与去重策略.md](/root/workspace/task-dag-project/task-dag-plugin/docs/plugin-driven-parent-continuation/03-%E5%B9%B6%E5%8F%91%E7%BB%AD%E8%A1%8C%E6%8C%81%E4%B9%85%E5%8C%96%E4%B8%8E%E5%8E%BB%E9%87%8D%E7%AD%96%E7%95%A5.md)
4. [04-测试矩阵与文档收口.md](/root/workspace/task-dag-project/task-dag-plugin/docs/plugin-driven-parent-continuation/04-%E6%B5%8B%E8%AF%95%E7%9F%A9%E9%98%B5%E4%B8%8E%E6%96%87%E6%A1%A3%E6%94%B6%E5%8F%A3.md)

## 完成标准

完成本组里程碑后，应达到：

1. task-dag 管理的 subagent run 结束后，父会话一定拥有可消费 continuation scope。
2. 父 agent 不再通过阻塞等待子 agent，而是返回后等待插件触发继续。
3. `resume_requested` 成为 continuation 的权威事实来源。
4. `sessions_send` 失败不会导致 continuation 丢失。
5. 并发 ended 不会互相覆盖。
6. 普通 subagent 不会产生 task-dag continuation 副作用。
