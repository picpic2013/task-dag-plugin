/**
 * Task DAG 类型定义
 * 
 * 定义所有与任务图相关的数据结构
 */

// ============= 枚举 =============

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked';

export type LogLevel = 'info' | 'warn' | 'error';

// ============= 接口 =============

export interface TaskLog {
  timestamp: string;
  level: LogLevel;
  message: string;
  progress?: number;  // 可选：进度更新
}

export interface Task {
  id: string;
  name: string;
  description: string;
  status: TaskStatus;
  progress: number;           // 0-100
  parent_id?: string;       // 父任务 ID
  subtasks: string[];        // 子任务 ID 列表
  assigned_agent: string;
  dependencies: string[];    // 依赖任务 ID
  output_summary?: string;
  logs: TaskLog[];
  checkpoint?: Record<string, unknown>;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface TaskDAG {
  id: string;
  name: string;
  created_at: string;
  tasks: Record<string, Task>;
}

// ============= 输入类型 =============

export interface CreateTaskInput {
  id?: string;
  name: string;
  description?: string;
  assigned_agent?: string;
  dependencies?: string[];
  parent_id?: string;
}

export interface UpdateTaskInput {
  name?: string;
  description?: string;
  status?: TaskStatus;
  progress?: number;
  output_summary?: string;
  log?: {
    level?: LogLevel;
    message: string;
    progress?: number;
  };
  checkpoint?: Record<string, unknown>;
}

export interface ModifyAction {
  action: 'add' | 'remove' | 'update';
  task_id?: string;
  task?: CreateTaskInput | UpdateTaskInput;
}

// ============= 工具函数 =============

/**
 * 创建新任务
 */
export function createTask(input: CreateTaskInput): Task {
  const now = new Date().toISOString();
  const id = input.id || `t${Date.now()}`;
  
  return {
    id,
    name: input.name,
    description: input.description || '',
    status: 'pending',
    progress: 0,
    parent_id: input.parent_id,
    subtasks: [],
    assigned_agent: input.assigned_agent || 'default',
    dependencies: input.dependencies || [],
    output_summary: undefined,
    logs: [],
    checkpoint: undefined,
    created_at: now,
    started_at: undefined,
    completed_at: undefined,
  };
}

/**
 * 验证任务是否有效
 */
export function validateTask(task: Task): boolean {
  if (!task.id || !task.name) {
    return false;
  }
  if (!['pending', 'running', 'done', 'failed', 'cancelled'].includes(task.status)) {
    return false;
  }
  if (task.progress < 0 || task.progress > 100) {
    return false;
  }
  return true;
}

/**
 * 检测循环依赖
 * 使用 DFS 检测从指定任务是否能回到自身
 * 
 * 注意：task.dependencies 表示"依赖"关系，即 dep -> task
 * 我们需要检测的是：是否存在一条路径从 task 出发又回到 task
 */
export function detectCycle(dag: TaskDAG, startTaskId: string): boolean {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  
  function dfs(taskId: string): boolean {
    visited.add(taskId);
    recursionStack.add(taskId);
    
    const task = dag.tasks[taskId];
    if (!task) {
      recursionStack.delete(taskId);
      return false;
    }
    
    // 找到所有依赖当前任务的任务（即下游任务）
    const downstreamTasks = Object.values(dag.tasks)
      .filter(t => t.dependencies.includes(taskId))
      .map(t => t.id);
    
    for (const downstreamId of downstreamTasks) {
      if (!visited.has(downstreamId)) {
        if (dfs(downstreamId)) {
          return true;
        }
      } else if (recursionStack.has(downstreamId)) {
        // 发现循环
        return true;
      }
    }
    
    recursionStack.delete(taskId);
    return false;
  }
  
  return dfs(startTaskId);
}

/**
 * 检测整个 DAG 是否有循环
 */
export function detectCycleInDAG(dag: TaskDAG): string[] {
  const cycles: string[] = [];
  const visited = new Set<string>();
  
  for (const taskId of Object.keys(dag.tasks)) {
    if (!visited.has(taskId)) {
      if (detectCycle(dag, taskId)) {
        cycles.push(taskId);
      }
    }
  }
  
  return cycles;
}

/**
 * 重新计算任务状态（处理 blocked）
 */
export function recalculateTaskStatus(task: Task, allTasks: Record<string, Task>): TaskStatus {
  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
    return task.status;
  }
  
  // 检查是否有未完成的依赖
  const hasPendingDeps = task.dependencies.some(depId => {
    const dep = allTasks[depId];
    return !dep || dep.status !== 'done';
  });
  
  if (hasPendingDeps && task.status === 'pending') {
    return 'blocked';
  }
  
  return task.status;
}

/**
 * 格式化任务为 Mermaid 节点
 */
export function formatTaskNode(task: Task): string {
  const statusEmoji: Record<TaskStatus, string> = {
    pending: '⚪',
    running: '🔵',
    done: '🟢',
    failed: '🔴',
    cancelled: '⚫',
    blocked: '🟡',
  };
  
  const emoji = statusEmoji[task.status] || '⚪';
  const progress = task.progress > 0 ? ` (${task.progress}%)` : '';
  
  return `${task.id}["${task.name} ${emoji}${progress}"]`;
}

/**
 * 获取任务统计信息
 */
export function getTaskStats(dag: TaskDAG): Record<string, number> {
  const stats: Record<string, number> = {
    total: 0,
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    blocked: 0,
  };
  
  for (const task of Object.values(dag.tasks)) {
    stats.total++;
    
    // 计算 blocked（pending 但有未完成依赖）
    if (task.status === 'pending') {
      const hasPendingDeps = task.dependencies.some(depId => {
        const dep = dag.tasks[depId];
        return !dep || dep.status !== 'done';
      });
      if (hasPendingDeps) {
        stats.blocked++;
      } else {
        stats.pending++;
      }
    } else {
      stats[task.status]++;
    }
  }
  
  return stats;
}
