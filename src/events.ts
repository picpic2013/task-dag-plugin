/**
 * 事件日志模块
 * 
 * 自动记录任务事件到 events.jsonl
 * 事件存储在父 agent 的 workspace 中
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DEFAULT_WORKSPACE = process.env.WORKSPACE_DIR || path.join(os.homedir(), '.openclaw');
const WORKSPACE_PREFIX = 'workspace-';
const DAG_DIR = 'tasks';

// 当前 agent ID（由 dag.ts 设置）
let currentAgentId = 'main';

// 当前 DAG ID（用于区分同一 agent 的不同 DAG）
let currentDagId: string | null = null;

/**
 * 设置当前 Agent ID
 */
export function setCurrentAgentId(agentId: string): void {
  currentAgentId = agentId;
}

/**
 * 获取当前 Agent ID
 */
export function getCurrentAgentId(): string {
  return currentAgentId;
}

/**
 * 设置当前 DAG ID
 */
export function setCurrentDagId(dagId: string): void {
  currentDagId = dagId;
}

/**
 * 获取当前 DAG ID
 */
export function getCurrentDagId(): string | null {
  return currentDagId;
}

function getEventsFile(): string {
  const baseDir = process.env.WORKSPACE_DIR || DEFAULT_WORKSPACE;
  const agentId = currentAgentId;
  const dagId = currentDagId || 'default';
  
  if (agentId === 'main') {
    // main 走旧路径: workspace/tasks/{dag_id}/events.jsonl
    return path.join(baseDir, 'workspace', DAG_DIR, dagId, 'events.jsonl');
  }
  
  // 其他 agent 走新路径: workspace-{agent_id}/tasks/{dag_id}/events.jsonl
  return path.join(baseDir, `${WORKSPACE_PREFIX}${agentId}`, DAG_DIR, dagId, 'events.jsonl');
}

function ensureDir(): void {
  const filePath = getEventsFile();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

interface Event {
  timestamp: string;
  event: string;
  task_id?: string;
  details?: string;
  [key: string]: any;
}

/**
 * 追加事件到日志
 */
export function addEvent(event: { event: string; task_id?: string; details?: string; [key: string]: any }): void {
  ensureDir();
  
  const fullEvent = {
    timestamp: new Date().toISOString(),
    agent_id: currentAgentId,
    ...event
  };
  
  fs.appendFileSync(getEventsFile(), JSON.stringify(fullEvent) + '\n');
}

/**
 * 获取事件列表
 */
export function getEvents(taskId?: string, limit: number = 100): Event[] {
  const filePath = getEventsFile();
  
  if (!fs.existsSync(filePath)) {
    return [];
  }
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  
  let events = lines
    .map(line => {
      try {
        return JSON.parse(line) as Event;
      } catch {
        return null;
      }
    })
    .filter((e): e is Event => e !== null);
  
  if (taskId) {
    events = events.filter(e => e.task_id === taskId);
  }
  
  return events.slice(-limit);
}
