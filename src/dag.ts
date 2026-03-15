/**
 * Task DAG 核心逻辑
 * 
 * 实现 DAG 的 CRUD 操作、状态管理、Mermaid 生成
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { addEvent, setCurrentAgentId as setAgentId } from './events.js';
export { setCurrentAgentId } from './events.js';
import { 
  Task, 
  TaskDAG, 
  TaskStatus, 
  CreateTaskInput, 
  UpdateTaskInput,
  createTask,
  detectCycleInDAG,
  recalculateTaskStatus,
  getTaskStats
} from './types.js';

// ============= 常量 =============

const DEFAULT_WORKSPACE = path.join(os.homedir(), '.openclaw', 'workspace');
const DAG_DIR = 'tasks';
const DAG_FILE = 'dag.json';

// ============= Agent 上下文 =============

let currentAgentId = 'main';

/**
 * 设置当前 Agent ID
 * 由 tools.ts 在执行时调用
 */


/**
 * 获取当前 Agent ID
 */
export function getCurrentAgentId(): string {
  return currentAgentId;
}

// ============= 存储路径 =============

function getDAGDir(): string {
  const workspace = process.env.WORKSPACE_DIR || DEFAULT_WORKSPACE;
  const dir = path.join(workspace, DAG_DIR, currentAgentId);
  // 同步设置 events 模块的 agent ID
  setAgentId(currentAgentId);
  return dir;
}

function getDAGFile(): string {
  return path.join(getDAGDir(), DAG_FILE);
}

// ============= 基础操作 =============

/**
 * 确保 DAG 目录存在
 */
function ensureDir(): void {
  const dir = getDAGDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 从文件加载 DAG
 */
export function loadDAG(): TaskDAG | null {
  try {
    const file = getDAGFile();
    if (!fs.existsSync(file)) {
      return null;
    }
    const data = fs.readFileSync(file, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('[dag] Failed to load DAG:', error);
    return null;
  }
}

/**
 * 保存 DAG 到文件
 */
export function saveDAG(dag: TaskDAG): void {
  ensureDir();
  const file = getDAGFile();
  fs.writeFileSync(file, JSON.stringify(dag, null, 2));
}

// ============= CRUD 操作 =============

/**
 * 创建新 DAG
 */
export function createDAG(name: string, tasks: CreateTaskInput[]): TaskDAG {
  const dag: TaskDAG = {
    id: `dag-${Date.now()}`,
    name,
    created_at: new Date().toISOString(),
    tasks: {}
  };

  // 添加所有任务
  tasks.forEach((t, i) => {
    const taskId = t.id || `t${i + 1}`;
    const task = createTask({ ...t, id: taskId });
    dag.tasks[taskId] = task;
  });

  // 处理嵌套关系
  for (const task of Object.values(dag.tasks)) {
    if (task.parent_id && dag.tasks[task.parent_id]) {
      dag.tasks[task.parent_id].subtasks.push(task.id);
    }
  }

  // 重新计算状态
  recalculateAllStatuses(dag);
  saveDAG(dag);
  
  addEvent({
    event: 'dag_created',
    details: `DAG "${name}" created with ${tasks.length} tasks`
  });
  
  return dag;
}

/**
 * 获取单个任务
 */
export function getTask(taskId: string): Task | null {
  const dag = loadDAG();
  return dag?.tasks[taskId] || null;
}

/**
 * 添加任务
 */
export function addTask(input: CreateTaskInput): Task {
  const dag = loadDAG();
  if (!dag) {
    throw new Error('No DAG exists. Use createDAG first.');
  }

  const task = createTask(input);
  
  // 检测循环依赖
  const testDAG = { ...dag, tasks: { ...dag.tasks, [task.id]: task } };
  const cycles = detectCycleInDAG(testDAG);
  if (cycles.length > 0) {
    throw new Error(`Cycle detected: ${cycles.join(' -> ')}`);
  }

  dag.tasks[task.id] = task;

  // 处理嵌套关系
  if (task.parent_id && dag.tasks[task.parent_id]) {
    dag.tasks[task.parent_id].subtasks.push(task.id);
  }

  recalculateAllStatuses(dag);
  saveDAG(dag);
  
  addEvent({
    event: 'task_created',
    task_id: task.id,
    details: `Task "${task.name}" created`
  });
  
  return task;
}

/**
 * 更新任务
 */
export function updateTask(taskId: string, updates: UpdateTaskInput): Task | null {
  const dag = loadDAG();
  if (!dag || !dag.tasks[taskId]) {
    return null;
  }

  const task = dag.tasks[taskId];

  // 更新基本字段
  if (updates.name !== undefined) task.name = updates.name;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.status !== undefined) task.status = updates.status;
  if (updates.progress !== undefined) task.progress = updates.progress;
  if (updates.output_summary !== undefined) task.output_summary = updates.output_summary;
  if (updates.doc_path !== undefined) task.doc_path = updates.doc_path;
  if (updates.checkpoint !== undefined) task.checkpoint = updates.checkpoint;

  // 添加日志
  if (updates.log) {
    task.logs.push({
      timestamp: new Date().toISOString(),
      level: updates.log.level || 'info',
      message: updates.log.message,
      progress: updates.log.progress
    });
    // 如果日志带进度，同步更新
    if (updates.log.progress !== undefined) {
      task.progress = updates.log.progress;
    }
  }

  // 更新时间戳
  if (updates.status === 'running' && !task.started_at) {
    task.started_at = new Date().toISOString();
  }
  if (updates.status === 'done' && !task.completed_at) {
    task.completed_at = new Date().toISOString();
    task.progress = 100;
  }

  // 记录状态变更事件
  if (updates.status) {
    addEvent({
      event: 'task_updated',
      task_id: taskId,
      details: `Status changed to ${updates.status}`
    });
  }

  recalculateAllStatuses(dag);
  saveDAG(dag);
  return task;
}

/**
 * 删除任务
 */
export function removeTask(taskId: string): boolean {
  const dag = loadDAG();
  if (!dag || !dag.tasks[taskId]) {
    return false;
  }

  const task = dag.tasks[taskId];

  // 从父任务的 subtasks 中移除
  if (task.parent_id && dag.tasks[task.parent_id]) {
    const parent = dag.tasks[task.parent_id];
    parent.subtasks = parent.subtasks.filter(id => id !== taskId);
  }

  // 从依赖中移除
  for (const otherTask of Object.values(dag.tasks)) {
    otherTask.dependencies = otherTask.dependencies.filter(id => id !== taskId);
  }

  // 删除子任务（递归）
  const deleteSubtasks = (id: string) => {
    const t = dag.tasks[id];
    if (t) {
      for (const subId of t.subtasks) {
        deleteSubtasks(subId);
      }
      delete dag.tasks[id];
    }
  };
  deleteSubtasks(taskId);

  saveDAG(dag);
  return true;
}

// ============= 嵌套任务 =============

/**
 * 添加子任务
 */
export function addSubtask(parentId: string, input: CreateTaskInput): Task | null {
  const dag = loadDAG();
  if (!dag || !dag.tasks[parentId]) {
    return null;
  }

  const subtask = createTask({ ...input, parent_id: parentId });
  dag.tasks[subtask.id] = subtask;
  dag.tasks[parentId].subtasks.push(subtask.id);

  recalculateAllStatuses(dag);
  saveDAG(dag);
  return subtask;
}

/**
 * 获取子任务列表
 */
export function getSubtasks(taskId: string): Task[] {
  const dag = loadDAG();
  if (!dag || !dag.tasks[taskId]) {
    return [];
  }

  return dag.tasks[taskId].subtasks
    .map(id => dag.tasks[id])
    .filter(Boolean);
}

// ============= 上下文 =============

/**
 * 获取任务上下文
 */
export function getContext(taskId: string): {
  task: Task;
  dependency_outputs: Array<{ id: string; name: string; description: string; doc_path: string | undefined; output_summary: string | undefined; status: TaskStatus }>;
  parent: { id: string; name: string; description: string; doc_path: string | undefined } | null;
  dag_name: string;
  dag_id: string;
} | null {
  const dag = loadDAG();
  if (!dag || !dag.tasks[taskId]) {
    return null;
  }

  const task = dag.tasks[taskId];

  // 收集依赖任务的输出
  const dependencyOutputs = task.dependencies.map(depId => {
    const dep = dag.tasks[depId];
    return {
      id: depId,
      name: dep?.name || '',
      description: dep?.description || '',
      doc_path: dep?.doc_path,
      output_summary: dep?.output_summary,
      status: dep?.status || 'pending' as TaskStatus
    };
  });

  // 收集父任务信息
  const parentTask = task.parent_id ? dag.tasks[task.parent_id] : null;

  return {
    task,
    dependency_outputs: dependencyOutputs,
    parent: parentTask ? { 
      id: parentTask.id, 
      name: parentTask.name,
      description: parentTask.description,
      doc_path: parentTask.doc_path
    } : null,
    dag_name: dag.name,
    dag_id: dag.id
  };
}

// ============= 状态管理 =============

/**
 * 获取就绪任务（依赖都已完成且状态为 pending/blocked）
 */
export function getReadyTasks(): Task[] {
  const dag = loadDAG();
  if (!dag) return [];

  const ready: Task[] = [];
  for (const task of Object.values(dag.tasks)) {
    // blocked 或 pending 状态都可以被激活
    if (task.status !== 'pending' && task.status !== 'blocked') continue;

    // 检查依赖是否都完成
    const allDepsDone = task.dependencies.every(depId => {
      const dep = dag.tasks[depId];
      return dep && dep.status === 'done';
    });

    if (allDepsDone) {
      ready.push(task);
    }
  }
  return ready;
}

/**
 * 重新计算所有任务的状态
 */
function recalculateAllStatuses(dag: TaskDAG): void {
  for (const task of Object.values(dag.tasks)) {
    // blocked 任务在依赖完成后变成 pending
    if (task.status === 'blocked') {
      const hasPendingDeps = task.dependencies.some(depId => {
        const dep = dag.tasks[depId];
        return !dep || dep.status !== 'done';
      });
      if (!hasPendingDeps) {
        task.status = 'pending';
      }
    }
    // pending 任务在依赖未完成时变成 blocked
    else if (task.status === 'pending') {
      const hasPendingDeps = task.dependencies.some(depId => {
        const dep = dag.tasks[depId];
        return !dep || dep.status !== 'done';
      });
      if (hasPendingDeps) {
        task.status = 'blocked';
      }
    }
  }
}

/**
 * 断点恢复
 */
export function resumeFrom(taskId: string): string[] {
  const dag = loadDAG();
  if (!dag || !dag.tasks[taskId]) {
    return [];
  }

  const resetTasks: string[] = [];

  // 重置指定任务及其下游任务
  const resetDownstream = (id: string) => {
    if (resetTasks.includes(id)) return;
    resetTasks.push(id);

    const task = dag.tasks[id];
    if (!task) return;

    // 重置当前任务
    task.status = 'pending';
    task.progress = 0;
    task.output_summary = undefined;
    task.checkpoint = undefined;

    // 重置所有下游任务
    for (const [otherId, otherTask] of Object.entries(dag.tasks)) {
      if (otherTask.dependencies.includes(id)) {
        resetDownstream(otherId);
      }
    }
  };

  resetDownstream(taskId);

  recalculateAllStatuses(dag);
  saveDAG(dag);
  return resetTasks;
}

// ============= 日志 =============

/**
 * 获取任务日志
 */
export function getLogs(taskId: string, since?: string): Array<{
  timestamp: string;
  level: string;
  message: string;
  progress?: number;
}> {
  const dag = loadDAG();
  if (!dag || !dag.tasks[taskId]) {
    return [];
  }

  const task = dag.tasks[taskId];
  if (!since) {
    return task.logs;
  }

  return task.logs.filter(log => log.timestamp >= since);
}

// ============= 文档操作 =============

/**
 * 获取任务文档目录
 */
function getTaskDocDir(): string {
  const workspace = process.env.WORKSPACE_DIR || path.join(os.homedir(), '.openclaw', 'workspace');
  const docDir = path.join(workspace, 'tasks', 'docs');
  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
  }
  return docDir;
}

/**
 * 为任务创建或更新文档
 */
export function setTaskDoc(taskId: string, content: string): string | null {
  const dag = loadDAG();
  if (!dag || !dag.tasks[taskId]) {
    return null;
  }

  const docDir = getTaskDocDir();
  const docPath = path.join(docDir, `${taskId}.md`);
  
  fs.writeFileSync(docPath, content, 'utf-8');
  
  // 更新任务的 doc_path
  dag.tasks[taskId].doc_path = docPath;
  saveDAG(dag);
  
  return docPath;
}

/**
 * 读取任务文档内容
 */
export function getTaskDoc(taskId: string): string | null {
  const dag = loadDAG();
  if (!dag || !dag.tasks[taskId]) {
    return null;
  }

  const docPath = dag.tasks[taskId].doc_path;
  if (!docPath || !fs.existsSync(docPath)) {
    return null;
  }

  return fs.readFileSync(docPath, 'utf-8');
}

/**
 * 删除任务文档
 */
export function deleteTaskDoc(taskId: string): boolean {
  const dag = loadDAG();
  if (!dag || !dag.tasks[taskId]) {
    return false;
  }

  const docPath = dag.tasks[taskId].doc_path;
  if (docPath && fs.existsSync(docPath)) {
    fs.unlinkSync(docPath);
  }

  dag.tasks[taskId].doc_path = undefined;
  saveDAG(dag);
  
  return true;
}

// ============= 可视化 =============

/**
 * 生成 Mermaid 进度图
 */
export function showProgress(): string {
  const dag = loadDAG();
  if (!dag) {
    return 'No active task DAG';
  }

  const lines: string[] = ['graph TD'];
  
  const statusEmoji: Record<TaskStatus, string> = {
    pending: '⚪',
    running: '🔵',
    done: '🟢',
    failed: '🔴',
    cancelled: '⚫',
    blocked: '🟡'
  };

  // 添加节点
  for (const [id, task] of Object.entries(dag.tasks)) {
    const emoji = statusEmoji[task.status] || '⚪';
    const progress = task.progress > 0 ? ` (${task.progress}%)` : '';
    const label = task.name.replace(/"/g, "'");
    lines.push(`  ${id}["${label} ${emoji}${progress}"]`);
  }

  // 添加边
  for (const [id, task] of Object.entries(dag.tasks)) {
    for (const dep of task.dependencies) {
      lines.push(`  ${dep} --> ${id}`);
    }
  }

  // 添加样式
  lines.push('');
  lines.push('  classDef pending fill:#D3D3D3');
  lines.push('  classDef running fill:#87CEEB');
  lines.push('  classDef done fill:#90EE90');
  lines.push('  classDef failed fill:#FFB6C1');
  lines.push('  classDef cancelled fill:#808080');
  lines.push('  classDef blocked fill:#FFFFE0');

  // 添加统计
  const stats = getTaskStats(dag);
  lines.push(`\n**进度**: ${stats.done}/${stats.total} 完成`);

  return lines.join('\n');
}

// ============= 工具函数 =============

/**
 * 获取 DAG 统计信息
 */
export function getStats(): Record<string, number> {
  const dag = loadDAG();
  if (!dag) {
    return { total: 0, pending: 0, running: 0, done: 0, failed: 0, blocked: 0 };
  }
  return getTaskStats(dag);
}

/**
 * 检查 DAG 是否存在
 */
export function hasDAG(): boolean {
  const file = getDAGFile();
  return fs.existsSync(file);
}
