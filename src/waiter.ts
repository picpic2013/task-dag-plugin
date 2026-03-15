/**
 * 等待注册表管理模块
 * 
 * 管理主 Agent 对子任务的等待状态
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const WORKSPACE = process.env.WORKSPACE_DIR || path.join(os.homedir(), '.openclaw', 'workspace');
const WAITING_FILE = path.join(WORKSPACE, 'tasks', 'waiting.json');

interface WaitingEntry {
  agent_id: string;
  task_id: string;
  started_at: string;
  timeout: number;
}

interface WaitingData {
  waiting: WaitingEntry[];
}

// ============= 辅助函数 =============

function ensureDir(): void {
  const dir = path.dirname(WAITING_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadWaiting(): WaitingData {
  try {
    ensureDir();
    if (!fs.existsSync(WAITING_FILE)) {
      return { waiting: [] };
    }
    const data = fs.readFileSync(WAITING_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { waiting: [] };
  }
}

function saveWaiting(data: WaitingData): void {
  ensureDir();
  fs.writeFileSync(WAITING_FILE, JSON.stringify(data, null, 2));
}

// ============= 核心函数 =============

/**
 * 注册等待
 */
export function registerWaiting(agentId: string, taskId: string, timeout: number = 3600): void {
  const waiting = loadWaiting();
  
  // 移除该 agent 的已有等待
  waiting.waiting = waiting.waiting.filter(w => w.agent_id !== agentId);
  
  // 添加新的等待
  waiting.waiting.push({
    agent_id: agentId,
    task_id: taskId,
    started_at: new Date().toISOString(),
    timeout
  });
  
  saveWaiting(waiting);
}

/**
 * 取消等待
 */
export function unregisterWaiting(agentId: string): void {
  const waiting = loadWaiting();
  waiting.waiting = waiting.waiting.filter(w => w.agent_id !== agentId);
  saveWaiting(waiting);
}

/**
 * 获取 agent 正在等待的任务
 */
export function getWaitingTask(agentId: string): string | null {
  const waiting = loadWaiting();
  const entry = waiting.waiting.find(w => w.agent_id === agentId);
  return entry?.task_id || null;
}

/**
 * 获取等待某任务的 agent
 */
export function getWaitingAgent(taskId: string): string | null {
  const waiting = loadWaiting();
  const entry = waiting.waiting.find(w => w.task_id === taskId);
  return entry?.agent_id || null;
}

/**
 * 获取所有等待中的条目
 */
export function getAllWaiting(): WaitingEntry[] {
  const waiting = loadWaiting();
  return waiting.waiting;
}

/**
 * 检查是否有 agent 正在等待某任务
 */
export function isWaiting(taskId: string): boolean {
  return getWaitingAgent(taskId) !== null;
}

/**
 * 清理超时等待
 */
export function cleanupWaiting(): number {
  const waiting = loadWaiting();
  const now = Date.now();
  let count = 0;
  
  waiting.waiting = waiting.waiting.filter(w => {
    const started = new Date(w.started_at).getTime();
    const elapsed = now - started;
    if (elapsed > w.timeout * 1000) {
      count++;
      return false;
    }
    return true;
  });
  
  if (count > 0) {
    saveWaiting(waiting);
  }
  
  return count;
}

/**
 * 获取等待信息
 */
export function getWaitingInfo(agentId: string): WaitingEntry | null {
  const waiting = loadWaiting();
  return waiting.waiting.find(w => w.agent_id === agentId) || null;
}
