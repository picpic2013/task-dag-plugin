# Chexie Agent Task-DAG Fix Plan

本目录记录 `chexie` agent 在 2026-03-17 凌晨测试 Task DAG 时暴露出的修复计划。

核心结论：

1. `task_dag_create` 在未显式传入 `agent_id` 时会静默回退到 `main`，导致 `chexie` 实际没有在自己的目录下创建 DAG。
2. 插件工具的 `execute` 签名与 OpenClaw runtime 的真实调用契约不一致。运行时实际调用为 `execute(toolCallId, params, signal, onUpdate)`，而插件大量代码按 `execute(params, context)` 假设编写。
3. 由于第 2 点，执行类工具中的参数会错位，`task_id` 在部分路径上变成 `undefined`，从而出现 `Task undefined not found`。
4. 工具层与 hook 层的上下文模型被混用，导致 `agent_id` / `dag_id` / requester session 的来源不可靠。

里程碑顺序：

1. `01-禁止create静默回退main.md`
2. `02-修正execute签名契约.md`
3. `03-拆分工具层与hook层上下文.md`
4. `04-统一读写工具参数契约.md`
5. `05-chexie场景回归测试.md`

执行原则：

- 每个里程碑完成后立即运行测试。
- 该里程碑测试通过后立刻提交一次 commit。
- 所有修复只改插件，不改 OpenClaw runtime。
