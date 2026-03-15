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
task_dag_update t1 running 50
task_dag_update t1 done 100 "完成"
```
**Note:** Just use task ID (e.g., "t1"), NOT "dag-xxx_t1".
Parameters: status (running/done/failed), progress (0-100), output summary

### wait
```
task_dag_wait t1
task_dag_wait t1 3600
```
Returns: completed/failed/notified/timeout. After timeout, check sub-agent status and wait again if needed.

### notify
```
task_dag_notify t1 "进度50%" progress
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
