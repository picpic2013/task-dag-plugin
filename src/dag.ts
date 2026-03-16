/**
 * Task DAG 核心逻辑
 * 
 * 实现 DAG 的 CRUD 操作、状态管理、Mermaid 生成
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { addEvent, setCurrentAgentId, getCurrentAgentId, setCurrentDagId, getCurrentDagId } from './events.js';
export { setCurrentAgentId, getCurrentAgentId, setCurrentDagId, getCurrentDagId } from './events.js';
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

const DEFAULT_WORKSPACE = path.join(os.homedir(), '.openclaw');
const WORKSPACE_PREFIX = 'workspace-';
const DAG_DIR = 'tasks';
const DAG_FILE = 'dag.json';

// ============= Agent 上下文 =============

// currentAgentId 和 currentDagId 现在从 events.ts 导入
// 每个 DAG 保存在独立的子目录：tasks/{agent_id}/{dag_id}/

// ============= 存储路径 =============

/**
 * 为指定 Agent 和 DAG 获取目录
 * 格式：
 *   - main: ~/.openclaw/workspace/tasks/{dag_id}/
 *   - 其他: ~/.openclaw/workspace-{agent_id}/tasks/{dag_id}/
 */
export function getDAGDirForAgent(agentId: string, dagId?: string): string {
  const baseDir = process.env.WORKSPACE_DIR || DEFAULT_WORKSPACE;
  const dagDir = dagId || getCurrentDagId() || 'default';
  
  if (agentId === 'main') {
    // main 走旧路径
    return path.join(baseDir, 'workspace', DAG_DIR, dagDir);
  }
  
  // 其他 agent 走新路径
  return path.join(baseDir, `${WORKSPACE_PREFIX}${agentId}`, DAG_DIR, dagDir);
}

function getDAGDir(): string {
  return getDAGDirForAgent(getCurrentAgentId());
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
 * 跨 Agent 加载 DAG
 * 用于子 agent 访问父 agent 的任务
 */
export function loadDAGForAgent(agentId: string, dagId?: string): TaskDAG | null {
  try {
    const baseDir = process.env.WORKSPACE_DIR || DEFAULT_WORKSPACE;
    const targetDagId = dagId || getCurrentDagId();
    
    // 确定路径
    let agentTasksDir: string;
    if (agentId === 'main') {
      agentTasksDir = path.join(baseDir, 'workspace', DAG_DIR);
    } else {
      agentTasksDir = path.join(baseDir, `${WORKSPACE_PREFIX}${agentId}`, DAG_DIR);
    }
    
    if (!targetDagId) {
      // 没有指定 dagId，返回该 agent 的最新 DAG
      if (!fs.existsSync(agentTasksDir)) {
        return null;
      }
      // 查找最新的 DAG 子目录
      const subDirs = fs.readdirSync(agentTasksDir).filter(d => d.startsWith('dag-'));
      if (subDirs.length === 0) return null;
      subDirs.sort().reverse();
      const latestDagId = subDirs[0];
      const file = path.join(agentTasksDir, latestDagId, DAG_FILE);
      if (!fs.existsSync(file)) return null;
      const data = fs.readFileSync(file, 'utf-8');
      return JSON.parse(data);
    }
    
    const file = path.join(agentTasksDir, targetDagId, DAG_FILE);
    if (!fs.existsSync(file)) {
      return null;
    }
    const data = fs.readFileSync(file, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('[dag] Failed to load DAG for agent:', error);
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
  const dagId = `dag-${Date.now()}`;
  const dag: TaskDAG = {
    id: dagId,
    name,
    created_at: new Date().toISOString(),
    tasks: {}
  };

  // 设置当前 DAG ID，使后续操作使用正确的子目录
  setCurrentDagId(dagId);

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
  if (updates.executor !== undefined) task.executor = updates.executor;
  if (updates.waiting_for !== undefined) task.waiting_for = updates.waiting_for;

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
  if (
    (updates.status === 'done' || updates.status === 'failed' || updates.status === 'cancelled') &&
    !task.completed_at
  ) {
    task.completed_at = new Date().toISOString();
    if (updates.status === 'done') {
      task.progress = 100;
    }
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
 * 获取就绪任务（依赖都已完成且状态为 ready）
 */
export function getReadyTasks(): Task[] {
  const dag = loadDAG();
  if (!dag) return [];

  return Object.values(dag.tasks).filter(task => task.status === 'ready');
}

/**
 * 重新计算所有任务的状态
 */
function recalculateAllStatuses(dag: TaskDAG): void {
  for (const task of Object.values(dag.tasks)) {
    task.status = recalculateTaskStatus(task, dag.tasks);
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
    task.executor = undefined;
    task.waiting_for = undefined;
    task.started_at = undefined;
    task.completed_at = undefined;

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
  const baseDir = process.env.WORKSPACE_DIR || path.join(os.homedir(), '.openclaw');
  // 格式：~/.openclaw/workspace-{agent_id}/tasks/docs
  const docDir = path.join(baseDir, `${WORKSPACE_PREFIX}${getCurrentAgentId()}`, DAG_DIR, 'docs');
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
    ready: '🟣',
    running: '🔵',
    waiting_subagent: '🟠',
    waiting_children: '🟤',
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
  lines.push('  classDef ready fill:#E6E6FA');
  lines.push('  classDef running fill:#87CEEB');
  lines.push('  classDef waiting_subagent fill:#FFDAB9');
  lines.push('  classDef waiting_children fill:#F5DEB3');
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
