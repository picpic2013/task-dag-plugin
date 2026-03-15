# Task DAG - 任务编排与子Agent调度器

> 🎯 为复杂多步骤任务提供 DAG 依赖管理 + 自动子Agent追踪

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-Skill-blue)](https://openclaw.ai)
[![Version](https://img.shields.io/badge/Version-0.3.0-brightgreen)]()
[![ClawdHub](https://img.shields.io/badge/ClawdHub-v0.3.0-brightgreen)](https://www.clawhub.ai)

---

## ✨ 为什么需要 Task DAG？

当你的 Agent 需要处理复杂的多步骤任务时：

- 🔀 **任务依赖** - 任务B需要等任务A完成后才能开始
- 🔄 **并行执行** - 多个独立任务可以同时处理
- 🤖 **子Agent管理** - 需要 Spawn 多个子Agent并行工作
- 📊 **进度追踪** - 每个任务的完成度需要实时可见
- 🔔 **完成通知** - 任务完成时需要自动通知

**Task DAG 就是为解决这些问题而生的。**

---

## 🎯 核心功能

### 1️⃣ DAG 依赖管理

支持任务之间的依赖关系，自动计算执行顺序：

```
A ──┐
     ├──→ C ──→ D
B ──┘
```

| 命令 | 说明 |
|------|------|
| `task_dag_create` | 创建任务 DAG |
| `task_dag_ready` | 获取可执行的任务 |
| `task_dag_resume` | 重置任务及下游任务 |

### 2️⃣ 自动子Agent生命周期追踪

自动管理子Agent的Spawn、等待、完成通知：

| Hook | 说明 |
|------|------|
| `subagent_spawned` | 子Agent启动时自动关联任务 |
| `subagent_ended` | 子Agent结束时自动更新任务状态 |

### 3️⃣ 状态自动更新（兜底机制）

当子Agent完成任务后，系统自动标记任务为 `done`：

- ✅ 任务成功完成 → 自动标记 `done`
- ❌ 执行出错 → 自动标记 `failed`

**注意：建议主动调用 `task_dag_update` 更新状态，自动更新仅作为兜底。**

### 4️⃣ 完整事件日志

所有操作自动记录：

- 任务创建/更新/完成
- 子Agent启动/结束
- 进度日志

---

## 🚀 快速开始

### 创建任务

```bash
# 创建依赖任务
task_dag_create name="项目" tasks=[
  {id:"t1",name:"任务1"},
  {id:"t2",dependencies:["t1"],name:"任务2"}
]
```

### Spawn 子Agent（重要：必须包含 label）

```bash
# 启动子Agent执行任务1
sessions_spawn task="执行任务1" label="task:t1"

# 必须等待完成
task_dag_wait task_id="t1"

# 查看结果
task_dag_show
```

### 更新任务状态

```bash
# 开始执行
task_dag_update task_id="t1" status="running"

# 进度更新
task_dag_update task_id="t1" progress=50 log={"message": "完成50%"}

# 任务完成
task_dag_update task_id="t1" status="done" output_summary="最终结果"
```

---

## 📁 目录结构

任务数据存储在 Agent 的 workspace 中：

```
.openclaw/
├── workspace-tasks/              # main agent
│   └── {dag_id}/
│       ├── dag.json
│       └── events.jsonl
│
├── workspace-{agent_id}/         # 其他 agent
│   └── {dag_id}/
│       ├── dag.json
│       └── events.jsonl
```

| 文件 | 说明 |
|------|------|
| `dag.json` | DAG 定义和任务状态 |
| `events.jsonl` | 事件日志 |

---

## 📖 详细文档

完整使用说明请参考 [SKILL.md](SKILL.md)

---

## 🔗 相关链接

- **📦 ClawdHub**: https://www.clawhub.ai
- **🐙 GitHub**: https://github.com/picpic2013/task-dag-plugin
- **📚 OpenClaw Docs**: https://docs.openclaw.ai

---

## 📝 任务状态更新规则（重要）

| 阶段 | 操作 | 示例 |
|------|------|------|
| **开始** | 设置 status=running | `task_dag_update task_id="t1" status="running"` |
| **进度** | 更新 progress 和 log | `task_dag_update task_id="t1" progress=50 log={"message": "完成50%"}` |
| **完成** | 设置 status=done | `task_dag_update task_id="t1" status="done" output_summary="最终结果"` |
| **失败** | 设置 status=failed | `task_dag_update task_id="t1" status="failed" output_summary="错误原因"` |

---

## ⚠️ 重要规则

1. **Spawn 时必须指定 label** - 使用 `label="task:TASK_ID"` 关联任务
2. **Spawn 后必须调用 wait** - 使用 `task_dag_wait` 等待任务完成
3. **主动更新状态** - 不要依赖自动完成机制，主动调用 `task_dag_update`

---

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE)
