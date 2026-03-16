# 03 ended hook 主动唤醒父会话

## 修改目标

在子 agent 结束后，由插件主动唤醒父 session，而不是只把 continuation 能力暴露给模型等它自己再来调用。

## 问题所在

- OpenClaw completion flow 可能直接把结果发给用户
- 这种情况下父 session 不一定会再被自动拉起执行插件工具
- 当前插件只写 completion event，但不会主动通知 requester session

## 执行方案

1. 扩展 hook 注册入口，使 `handleSubagentEndedEvent` 能访问 `api.runtime.sessions_send`
2. 在 `subagent_ended` 成功收尾后：
   - 根据 `ctx.requesterSessionKey` 或 requester 注册表，向父 session 发送一条结构化 continuation 消息
3. continuation 消息内容包含：
   - `dag_id`
   - `run_id`
   - `completed_task_ids`
   - `failed_task_ids`
   - `continuation_reason`
4. 为避免重复唤醒：
   - 使用 pending event 或专门 dedupe key 做幂等控制

## 测试方案

1. 新增测试：ended hook 收尾后会调用 `sessions_send`
2. 新增测试：重复 ended 不会重复唤醒
3. 新增测试：没有 requester session 时不会抛错，只记录 warning

## 预期结果

- 子 agent 完成后，父会话会被插件主动唤醒
- continuation 不再主要依赖模型“记得下一轮调用 `task_dag_continue`”
