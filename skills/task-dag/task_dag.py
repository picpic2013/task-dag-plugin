#!/usr/bin/env python3
"""
Task DAG CLI - Python wrapper for DAG operations
"""
import json
import sys
import os
from pathlib import Path
from datetime import datetime

WORKSPACE = os.path.expanduser("~/.openclaw/workspace")
DAG_DIR = os.path.join(WORKSPACE, "tasks")
DAG_FILE = os.path.join(DAG_DIR, "dag.json")

def ensure_dir():
    Path(DAG_DIR).mkdir(parents=True, exist_ok=True)

def load_dag():
    ensure_dir()
    if not os.path.exists(DAG_FILE):
        return None
    with open(DAG_FILE) as f:
        return json.load(f)

def save_dag(dag):
    ensure_dir()
    with open(DAG_FILE, 'w') as f:
        json.dump(dag, f, indent=2)

def create_task_id(dag):
    """Generate unique task ID"""
    existing = list(dag.get('tasks', {}).keys())
    i = 1
    while f't{i}' in existing:
        i += 1
    return f't{i}'

def create_dag(name, tasks):
    """Create new DAG"""
    dag = {
        "id": f"dag-{int(datetime.now().timestamp() * 1000)}",
        "name": name,
        "created_at": datetime.now().isoformat(),
        "tasks": {}
    }
    
    for t in tasks:
        tid = t.get('id') or create_task_id(dag)
        dag["tasks"][tid] = {
            "id": tid,
            "name": t.get("name", ""),
            "description": t.get("description", ""),
            "status": "blocked" if t.get("dependencies") else "pending",
            "progress": 0,
            "parent_id": t.get("parent_id"),
            "subtasks": [],
            "assigned_agent": t.get("assigned_agent", "default"),
            "dependencies": t.get("dependencies", []),
            "output_summary": None,
            "logs": [],
            "created_at": datetime.now().isoformat()
        }
    
    # 处理嵌套关系
    for tid, task in dag["tasks"].items():
        if task.get("parent_id") and task["parent_id"] in dag["tasks"]:
            dag["tasks"][task["parent_id"]]["subtasks"].append(tid)
    
    # 重新计算 blocked 状态
    recalculate_status(dag)
    save_dag(dag)
    return dag

def recalculate_status(dag):
    """重新计算任务状态"""
    for tid, task in dag["tasks"].items():
        if task["status"] == "blocked":
            # 检查依赖是否都完成
            deps = task.get("dependencies", [])
            all_done = all(
                dag["tasks"].get(d, {}).get("status") == "done"
                for d in deps
            )
            if all_done:
                task["status"] = "pending"
        elif task["status"] == "pending":
            # 检查依赖是否都完成
            deps = task.get("dependencies", [])
            has_pending = any(
                dag["tasks"].get(d, {}).get("status") != "done"
                for d in deps
            )
            if has_pending:
                task["status"] = "blocked"

def show_progress():
    """Generate Mermaid progress diagram"""
    dag = load_dag()
    if not dag:
        return "No active task DAG"
    
    lines = ["graph TD"]
    status_emoji = {"done": "🟢", "running": "🔵", "pending": "⚪", "failed": "🔴", "cancelled": "⚫", "blocked": "🟡"}
    
    for tid, task in dag["tasks"].items():
        emoji = status_emoji.get(task["status"], "⚪")
        progress = f" ({task['progress']}%)" if task.get("progress", 0) > 0 else ""
        name = task["name"].replace('"', "'")
        lines.append(f'  {tid}["{name} {emoji}{progress}"]')
        
        for dep in task.get("dependencies", []):
            lines.append(f"  {dep} --> {tid}")
    
    # 统计
    stats = {s: 0 for s in status_emoji}
    for t in dag["tasks"].values():
        stats[t["status"]] = stats.get(t["status"], 0) + 1
    
    total = len(dag["tasks"])
    lines.append(f"\n**进度**: {stats.get('done', 0)}/{total} 完成")
    
    return "\n".join(lines)

def get_ready_tasks():
    """Get ready tasks"""
    dag = load_dag()
    if not dag:
        return []
    
    ready = []
    for tid, task in dag["tasks"].items():
        if task["status"] not in ["pending", "blocked"]:
            continue
        deps = task.get("dependencies", [])
        if all(dag["tasks"].get(d, {}).get("status") == "done" for d in deps):
            ready.append({"id": tid, "name": task["name"], "assigned_agent": task.get("assigned_agent")})
    return ready

def get_task(task_id):
    """Get task details"""
    dag = load_dag()
    if not dag or task_id not in dag["tasks"]:
        return None
    return dag["tasks"][task_id]

def update_task(task_id, status=None, progress=None, output=None, log_message=None):
    """Update task"""
    dag = load_dag()
    if not dag or task_id not in dag["tasks"]:
        return {"error": f"Task {task_id} not found"}
    
    task = dag["tasks"][task_id]
    if status:
        task["status"] = status
    if progress is not None:
        task["progress"] = progress
    if output:
        task["output_summary"] = output
    
    # 添加日志
    if log_message:
        task["logs"].append({
            "timestamp": datetime.now().isoformat(),
            "level": "info",
            "message": log_message,
            "progress": progress
        })
    
    # 更新时间戳
    if status == "running" and not task.get("started_at"):
        task["started_at"] = datetime.now().isoformat()
    if status == "done" and not task.get("completed_at"):
        task["completed_at"] = datetime.now().isoformat()
        task["progress"] = 100
    
    recalculate_status(dag)
    save_dag(dag)
    return {"success": True}

def add_task(name, assigned_agent="default", dependencies=None, description=""):
    """Add a new task"""
    dag = load_dag()
    if not dag:
        return {"error": "No DAG exists. Use create first."}
    
    tid = create_task_id(dag)
    task = {
        "id": tid,
        "name": name,
        "description": description,
        "status": "blocked" if dependencies else "pending",
        "progress": 0,
        "subtasks": [],
        "assigned_agent": assigned_agent,
        "dependencies": dependencies or [],
        "output_summary": None,
        "logs": [],
        "created_at": datetime.now().isoformat()
    }
    
    dag["tasks"][tid] = task
    recalculate_status(dag)
    save_dag(dag)
    return {"success": True, "task_id": tid}

def remove_task(task_id):
    """Remove a task"""
    dag = load_dag()
    if not dag or task_id not in dag["tasks"]:
        return {"error": f"Task {task_id} not found"}
    
    # 从父任务中移除
    task = dag["tasks"][task_id]
    if task.get("parent_id") and task["parent_id"] in dag["tasks"]:
        dag["tasks"][task["parent_id"]]["subtasks"] = [
            t for t in dag["tasks"][task["parent_id"]]["subtasks"] if t != task_id
        ]
    
    # 从依赖中移除
    for t in dag["tasks"].values():
        if task_id in t.get("dependencies", []):
            t["dependencies"] = [d for d in t["dependencies"] if d != task_id]
    
    del dag["tasks"][task_id]
    save_dag(dag)
    return {"success": True}

def add_subtask(parent_id, name, assigned_agent="default"):
    """Add a subtask"""
    dag = load_dag()
    if not dag or parent_id not in dag["tasks"]:
        return {"error": f"Parent task {parent_id} not found"}
    
    tid = create_task_id(dag)
    task = {
        "id": tid,
        "name": name,
        "description": "",
        "status": "pending",
        "progress": 0,
        "parent_id": parent_id,
        "subtasks": [],
        "assigned_agent": assigned_agent,
        "dependencies": [],
        "output_summary": None,
        "logs": [],
        "created_at": datetime.now().isoformat()
    }
    
    dag["tasks"][tid] = task
    dag["tasks"][parent_id]["subtasks"].append(tid)
    save_dag(dag)
    return {"success": True, "task_id": tid}

def get_subtasks(task_id):
    """Get subtasks"""
    dag = load_dag()
    if not dag or task_id not in dag["tasks"]:
        return []
    
    return [
        {"id": sid, "name": dag["tasks"][sid]["name"], "status": dag["tasks"][sid]["status"]}
        for sid in dag["tasks"][task_id].get("subtasks", [])
        if sid in dag["tasks"]
    ]

def get_context(task_id):
    """Get task context"""
    dag = load_dag()
    if not dag or task_id not in dag["tasks"]:
        return None
    
    task = dag["tasks"][task_id]
    
    # 依赖输出
    dep_outputs = []
    for dep_id in task.get("dependencies", []):
        dep = dag["tasks"].get(dep_id)
        if dep:
            dep_outputs.append({
                "id": dep_id,
                "name": dep["name"],
                "output_summary": dep.get("output_summary"),
                "status": dep["status"]
            })
    
    # 父任务
    parent = None
    if task.get("parent_id") and task["parent_id"] in dag["tasks"]:
        parent = {"id": task["parent_id"], "name": dag["tasks"][task["parent_id"]]["name"]}
    
    return {
        "task_name": task["name"],
        "parent_task": parent,
        "dependency_outputs": dep_outputs,
        "dag_name": dag["name"]
    }

def resume_from(task_id):
    """Resume from a task"""
    dag = load_dag()
    if not dag or task_id not in dag["tasks"]:
        return {"error": f"Task {task_id} not found"}
    
    reset_tasks = []
    
    def reset_downstream(tid):
        if tid in reset_tasks:
            return
        reset_tasks.append(tid)
        
        task = dag["tasks"].get(tid)
        if not task:
            return
        
        task["status"] = "pending"
        task["progress"] = 0
        task["output_summary"] = None
        
        # 重置下游任务
        for other_id, other_task in dag["tasks"].items():
            if task_id in other_task.get("dependencies", []):
                reset_downstream(other_id)
    
    reset_downstream(task_id)
    recalculate_status(dag)
    save_dag(dag)
    
    return {"success": True, "reset_tasks": reset_tasks}

def get_logs(task_id):
    """Get task logs"""
    dag = load_dag()
    if not dag or task_id not in dag["tasks"]:
        return []
    return dag["tasks"][task_id].get("logs", [])

# CLI 分发
if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(show_progress())
        sys.exit(0)
    
    cmd = args[0]
    
    if cmd == "create":
        if len(args) < 3:
            print("Usage: task_dag.py create <name> <tasks_json>")
            sys.exit(1)
        name = args[1]
        tasks = json.loads(args[2])
        dag = create_dag(name, tasks)
        print(json.dumps({"success": True, "dag_id": dag["id"]}))
    
    elif cmd == "show":
        print(show_progress())
    
    elif cmd == "ready":
        print(json.dumps(get_ready_tasks()))
    
    elif cmd == "get":
        if len(args) < 2:
            print("Usage: task_dag.py get <task_id>")
            sys.exit(1)
        task = get_task(args[1])
        if task:
            print(json.dumps(task))
        else:
            print(json.dumps({"error": "Task not found"}))
    
    elif cmd == "update":
        if len(args) < 3:
            print("Usage: task_dag.py update <task_id> <status> [progress] [output]")
            sys.exit(1)
        task_id = args[1]
        status = args[2] if args[2] in ["pending", "running", "done", "failed", "cancelled"] else None
        progress = int(args[3]) if len(args) > 3 and args[3].isdigit() else None
        output = args[4] if len(args) > 4 else None
        result = update_task(task_id, status, progress, output)
        print(json.dumps(result))
    
    elif cmd == "modify":
        if len(args) < 3:
            print("Usage: task_dag.py modify <add|remove> [args...]")
            sys.exit(1)
        action = args[1]
        if action == "add":
            if len(args) < 3:
                print("Usage: task_dag.py modify add '<task_json>'")
                sys.exit(1)
            task = json.loads(args[2])
            result = add_task(task.get("name"), task.get("assigned_agent"), task.get("dependencies"))
            print(json.dumps(result))
        elif action == "remove":
            if len(args) < 3:
                print("Usage: task_dag.py modify remove <task_id>")
                sys.exit(1)
            result = remove_task(args[2])
            print(json.dumps(result))
        else:
            print(f"Unknown modify action: {action}")
    
    elif cmd == "subtask":
        if len(args) < 3:
            print("Usage: task_dag.py subtask <create|list> [args...]")
            sys.exit(1)
        action = args[1]
        if action == "create":
            if len(args) < 4:
                print("Usage: task_dag.py subtask create <parent_id> '<task_json>'")
                sys.exit(1)
            task = json.loads(args[3])
            result = add_subtask(args[2], task.get("name"), task.get("assigned_agent"))
            print(json.dumps(result))
        elif action == "list":
            if len(args) < 3:
                print("Usage: task_dag.py subtask list <task_id>")
                sys.exit(1)
            print(json.dumps(get_subtasks(args[2])))
    
    elif cmd == "context":
        if len(args) < 2:
            print("Usage: task_dag.py context <task_id>")
            sys.exit(1)
        ctx = get_context(args[1])
        if ctx:
            print(json.dumps(ctx))
        else:
            print(json.dumps({"error": "Task not found"}))
    
    elif cmd == "resume":
        if len(args) < 2:
            print("Usage: task_dag.py resume <task_id>")
            sys.exit(1)
        result = resume_from(args[1])
        print(json.dumps(result))
    
    elif cmd == "logs":
        if len(args) < 2:
            print("Usage: task_dag.py logs <task_id>")
            sys.exit(1)
        print(json.dumps(get_logs(args[1])))
    
    else:
        print(f"Unknown command: {cmd}")
        print("Available commands: create, show, ready, get, update, modify, subtask, context, resume, logs")
