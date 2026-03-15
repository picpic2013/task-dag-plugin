---
name: task-dag
description: "Task DAG for complex multi-step tasks with dependency management, automatic sub-agent tracking. Use when: parallel execution, dependency chains, task orchestration."
---

# Task DAG

> Use when: complex multi-step tasks, parallel execution, dependency management.

**When to use:** Complex multi-step tasks, parallel execution, dependency management.

**Quick Start:**
```bash
# Create tasks with dependencies
task_dag_create name="项目" tasks=[{id:"t1",name:"任务1"},{id:"t2",dependencies:["t1"]}]

# Spawn sub-agent (IMPORTANT: include label!)
sessions_spawn task="执行任务1" label="task:t1"

# Must wait for completion
task_dag_wait task_id="t1"

# Check result - status updated automatically!
task_dag_show
```

**Key Features:**
- DAG dependency management
- Auto sub-agent lifecycle tracking  
- Automatic status updates
- Event logging

**Rules:**
1. Always use `label="task:TASK_ID"` when spawning
2. Always call `task_dag_wait` after spawning
3. Check with `task_dag_ready` for available tasks

---

For detailed docs, see below.

## Commands

### create
```
task_dag_create name="项目" tasks=[{name:"任务1"},{name:"任务2",dependencies:["t1"]}]
```

### show
```
task_dag_show
```

### ready
```
task_dag_ready
```

### get
```
task_dag_get t1
```

### update
```
task_dag_update task_id="t1" status="running" progress=50
task_dag_update task_id="t1" status="done" progress=100 output_summary="完成"
```
Parameters: task_id, status (pending/running/done/failed/cancelled), progress (0-100), output_summary

### modify (add/remove)
```
# Add new task
task_dag_modify action="add" task={"name":"新任务","assigned_agent":"scout"}

# Remove task
task_dag_modify action="remove" task_id="t1"
```

### subtask_create
```
task_dag_subtask_create parent_id="t1" task={"name":"子任务","assigned_agent":"writer"}
```

### subtask_list
```
task_dag_subtask_list t1
```

### context
```
task_dag_context t1
```
Returns: task info + dependency outputs.

### resume
```
task_dag_resume t1
```
Reset task and downstream tasks to pending.

### logs
```
task_dag_logs t1
task_dag_logs t1 "2026-01-01T00:00:00Z"
```

### set_doc / get_doc
```
task_dag_set_doc task_id="t1" content="# 文档内容"
task_dag_get_doc t1
```

### wait
```
task_dag_wait t1
task_dag_wait task_id="t1" timeout=3600
```
Returns: completed/failed/notified/timeout. After timeout, check sub-agent status and wait again if needed.

### notify
```
task_dag_notify task_id="t1" message="进度50%" type="progress"
```

---

## Wait Function Principle

**Required:** After spawning a sub-agent, you MUST call `task_dag_wait`.

**Flow:**
```
sessions_spawn(task="...", label="task:t1")
         ↓
task_dag_wait(task_id="t1")
         ↓
[Polling loop: check notification queue → check task status → timeout]
         ↓
Return: completed | failed | notified | timeout
```

---

## Sub-agent Context

Sub-agents can access task context:
```
task_dag_context t1
```
Returns: task info + dependency outputs.

---

## Splitting Tasks (Subtasks)

For complex tasks, sub-agents can create subtasks under a parent task:

```bash
# Sub-agent creates subtasks under t1
task_dag_subtask_create parent_id="t1" task={"name":"竞品分析"}
task_dag_subtask_create parent_id="t1" task={"name":"用户访谈"}

# View subtasks
task_dag_subtask_list t1
```

Result:
```
t1 (parent)
├── t1_1 (竞品分析)
└── t1_2 (用户访谈)
```

**Note:** Subtasks automatically belong to the parent task's DAG. No need to create a new DAG.

---

## Event Logging

Automatic. Events stored in parent agent's workspace.

---

## Markdown Docs

Use standard read/write tools for markdown files. Task references doc_path.

---

## Examples

### Complete Flow
```bash
task_dag_create "项目" tasks=[{id:"t1",name:"任务1"},{id:"t2",dependencies:["t1"]}]
sessions_spawn task="做任务1" label="task:t1"
task_dag_wait t1
# t1 done automatically!
task_dag_show
```

### With Multiple Tasks
```bash
task_dag_create "项目" tasks=[{id:"t1",name:"收集"},{id:"t2",name:"分析",dependencies:["t1"]},{id:"t3",name:"报告",dependencies:["t2"]}]
# t1 ready
sessions_spawn task="收集信息" label="task:t1"
task_dag_wait t1
# t2 ready
sessions_spawn task="分析" label="task:t2"
task_dag_wait t2
# t3 ready
sessions_spawn task="写报告" label="task:t3"
task_dag_wait t3
```
