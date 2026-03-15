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

This skill provides a command-line interface to manage task DAGs. It supports:
- Creating new task DAGs
- Showing progress with Mermaid diagrams
- Updating task status and progress
- Modifying task graph (add/remove/update tasks)
- Creating subtasks
- Getting task context
- Resuming from checkpoints

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

## Examples

### Example 1: Create and manage a project

```
# Create a new project
task-dag create "竞品分析" '[{"id":"t1","name":"收集信息","assigned_agent":"scout"},{"id":"t2","name":"分析","dependencies":["t1"],"assigned_agent":"ideator"},{"id":"t3","name":"报告","dependencies":["t2"],"assigned_agent":"writer"}]'

# Show progress
task-dag show

# Update progress
task-dag update t1 running 30
task-dag update t1 done 100 "已收集5个竞品的详细信息"

# Check ready tasks
task-dag ready
```

### Example 2: Add subtasks dynamically

```
# Add a subtask to t1
task-dag subtask create t1 '{"name":"用户访谈","assigned_agent":"scout"}'

# Show updated progress
task-dag show
```

## Notes

- Task IDs are auto-generated if not provided (t1, t2, t3, ...)
- Progress values should be 0-100
- Dependencies are task IDs (e.g., ["t1", "t2"])
