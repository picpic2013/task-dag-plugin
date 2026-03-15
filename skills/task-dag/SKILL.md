---
name: task-dag
description: "Task DAG management - create, show, modify, and monitor tasks"
metadata:
  openclaw:
    requires:
      bins: ["python3"]
---

# Task DAG Management

Manage task DAGs for project planning and execution.

## Overview

This skill provides a complete task orchestration system:
- DAG-based dependency management
- Automatic sub-agent lifecycle tracking
- Event logging (automatic)
- Wait and notification mechanism

## Commands

### create

Create a new task DAG.

```
task-dag create "项目名" '[{"name":"任务1","assigned_agent":"scout"},{"name":"任务2","dependencies":["t1"],"assigned_agent":"writer"}]'
```

### show

Show current DAG progress with Mermaid diagram.

```
task-dag show
```

### ready

Get tasks that are ready to run (dependencies completed).

```
task-dag ready
```

### get

Get task details.

```
task-dag get t1
```

### update

Update task status and/or progress.

```
task-dag update t1 running 50
task-dag update t1 done 100 "output summary"
```

### modify

Modify task graph.

```
task-dag modify add '{"name":"新任务","assigned_agent":"scout"}'
task-dag modify remove t3
task-dag modify update t1 '{"name":"新名字"}'
```

### subtask

Create or list subtasks.

```
task-dag subtask create t1 '{"name":"子任务","assigned_agent":"scout"}'
task-dag subtask list t1
```

### context

Get task context including dependency outputs.

```
task-dag context t2
```

### logs

Get task execution logs.

```
task-dag logs t1
```

### resume

Resume from a specific task.

```
task-dag resume t3
```

### wait

Wait for a task to complete.

```
task-dag wait t1
task-dag wait t1 3600
```

### notify

Notify about task progress.

```
task-dag notify t1 "进度50%" progress
task-dag notify t1 "遇到问题" issue
```

---

## Wait Function Principle (Important)

### Why Wait is Required

After spawning a sub-agent, you **MUST** call `task_dag_wait` to wait for completion.

### How It Works

```
1. You call sessions_spawn(task="...", label="task:t1")
           ↓
2. subagent_spawned hook: automatically maps session → task
           ↓
3. You MUST call task_dag_wait(task_id="t1")
           ↓
   ┌─────────────────────────────────────┐
   │ 4. Register wait (agent waiting for t1)    │
   │ 5. Polling loop (default 5s interval)      │
   │ 6. Check notification queue                │
   │ 7. Check task status (done/failed)         │
   │ 8. Timeout (default 3600s)                │
   └─────────────────────────────────────┘
           ↓
9. Return: completed / failed / notified / timeout
```

### Return Values

| Status | Meaning |
|--------|---------|
| `completed` | Task finished successfully |
| `failed` | Task failed |
| `notified` | Received progress/issue notification |
| `timeout` | Wait timed out (continue=true) |

### Example

```bash
# Step 1: Create task
task_dag_create(name="项目", tasks=[{id:"t1", name:"分析数据"}])

# Step 2: Spawn sub-agent (IMPORTANT: include label!)
sessions_spawn(task="分析这个数据", label="task:t1")

# Step 3: MUST wait!
task_dag_wait(task_id="t1", timeout=3600)

# Step 4: Check result
task_dag_show
# t1 should now show as "done" automatically!
```

---

## Sub-agent Automatic Association

When using `sessions_spawn`, use the `label` parameter to associate with a task.

### Label Formats

| Format | Example | Description |
|--------|---------|-------------|
| `task:ID` | `task:t1` | Recommended |
| `task_id=ID` | `task_id=t1` | Alternative |
| Pure ID | `t1` | Shorthand |

### How It Works

1. You call `sessions_spawn(task="...", label="task:t1")`
2. `subagent_spawned` hook automatically:
   - Saves session ↔ task mapping
   - Saves parent-child hierarchy
3. When sub-agent ends, `subagent_ended` hook automatically:
   - Updates task status to `done` or `failed`
   - Records event in `events.jsonl`

---

## Event Logging (Automatic)

All events are automatically recorded to `~/.openclaw/workspace/tasks/events.jsonl`.

### Automatic Events

| Event | When |
|-------|------|
| `dag_created` | DAG created |
| `task_created` | Task created |
| `task_updated` | Task status changed |
| `subtask_spawned` | Sub-agent started |
| `subtask_ended` | Sub-agent ended |

---

## Validation Standards

**Core Principle: No validation, no delivery**

### Validation Requirements

| Task Type | Validation |
|------------|------------|
| Code | Must have passing tests |
| Research | Must have source citations |
| Data | Must have quality checks |
| Documentation | Must have structure review |

### Validation Flow

```
1. Task execution complete
         ↓
2. Validate output
         ↓
3. Pass → task_dag_update status=done
   Fail → task_dag_update status=failed
```

---

## Model Selection Strategy

### By Complexity

| Complexity | Example | Recommended Model |
|------------|---------|-------------------|
| Simple | Format output, simple query | MiniMax High Speed |
| Medium | Script writing, data processing | GPT-5.2 Codex |
| Complex | Architecture design, complex debugging | GPT-5.3 Codex |

### Usage

```bash
# Simple task
sessions_spawn(task="Format this JSON", label="task:t1", model="minimax/MiniMax-M2.5-highspeed")

# Complex task
sessions_spawn(task="Design system architecture", label="task:t2", model="openai-codex/gpt-5.3-codex")
```

---

## Interaction Guidelines

### Progress Sync

For long-running tasks, use periodic progress updates:

- Format: `[Phase] Status | Progress`
- Use `task_dag_notify` to send progress

### Reply Format

- Short task: ✅ Task complete
- Long task: Include task ID + status

### Decision Boundary

- Uncertain: Ask user first
- Certain: Can decide autonomously

---

## Examples

### Example 1: Complete Workflow

```bash
# 1. Create project with dependencies
task_dag_create "竞品分析" '[{"id":"t1","name":"收集信息"},{"id":"t2","name":"分析","dependencies":["t1"]},{"id":"t3","name":"报告","dependencies":["t2"]}]'

# 2. Show progress
task_dag_show

# 3. Start sub-agent for t1
sessions_spawn(task="收集竞品信息", label="task:t1")

# 4. MUST wait
task_dag_wait task_id="t1" timeout=3600

# 5. Check - t1 should be done automatically
task_dag_show

# 6. Continue with t2
sessions_spawn(task="分析信息", label="task:t2")
task_dag_wait task_id="t2"

# 7. Continue with t3
sessions_spawn(task="写报告", label="task:t3")
task_dag_wait task_id="t3"

# 8. Done!
task_dag_show
```

### Example 2: With Dependencies

```bash
# Create DAG with dependencies
task_dag_create "项目" '[{"id":"t1","name":"任务1"},{"id":"t2","name":"任务2","dependencies":["t1"]}]'

# t1 is ready, t2 is blocked
task_dag_ready

# Start t1
sessions_spawn(task="执行任务1", label="task:t1")
task_dag_wait task_id="t1"

# Now t2 becomes ready automatically
task_dag_ready

# Continue t2
sessions_spawn(task="执行任务2", label="task:t2")
task_dag_wait task_id="t2"
```

---

## Notes

- Task IDs: Auto-generated (t1, t2, t3...) or custom
- Progress: 0-100
- Dependencies: Task IDs (e.g., ["t1", "t2"])
- **Always use `task_dag_wait` after spawning sub-agents!**
