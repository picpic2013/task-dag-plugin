# 父会话继续机制修复

本目录对应“子 agent 完成后，父 agent 没有继续反应”的专项修复。

问题范围：

- 只修改 task-dag 插件
- 不修改 OpenClaw runtime
- 目标是让插件在 runtime 原生 completion flow 之上，自己建立可靠的父会话继续机制

本次修复拆分为 4 个里程碑：

- `01-hook-contract对齐与上下文恢复.md`
- `02-requester-session注册表.md`
- `03-ended-hook主动唤醒父会话.md`
- `04-文档测试与收口.md`

统一目标：

1. hook 必须按 OpenClaw 的真实签名 `(event, ctx)` 工作
2. 插件不能再假设 runtime 会把 `dagId/parentAgentId` 塞进 hook event
3. 插件要自己维护 `requesterSessionKey -> parentAgentId/dagId/active runs` 的确定性注册表
4. 子 agent 结束后，插件要能主动唤醒父 session，而不是只等模型自己下一轮调用 `task_dag_continue`

统一验收：

- `npm run build`
- `node test_runner.mjs`
- `bash test-all.sh`

统一预期：

- spawn 后 task 会进入 `waiting_subagent`
- hook 能在没有 `dagId/parentAgentId` 的 runtime 原始 event 下恢复上下文
- ended hook 能写出 completion event 并主动唤醒 requester session
- 父会话恢复链路由插件维护，不再主要依赖模型记忆协议
