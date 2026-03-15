/**
 * 事件日志模块
 * 
 * 自动记录任务事件到 events.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const WORKSPACE = process.env.WORKSPACE_DIR || path.join(os.homedir(), '.openclaw', 'workspace');
const EVENTS_FILE = path.join(WORKSPACE, 'tasks', 'events.jsonl');

interface Event {
  timestamp: string;
  event: string;
  task_id?: string;
  details?: string;
  [key: string]: any;
}

function ensureDir(): void {
  const dir = path.dirname(EVENTS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 追加事件到日志
 */
export function addEvent(event: { event: string; task_id?: string; details?: string; [key: string]: any }): void {
  ensureDir();
  
  const fullEvent = {
    timestamp: new Date().toISOString(),
    ...event
  };
  
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(fullEvent) + '\n');
}

/**
 * 获取事件列表
 */
export function getEvents(taskId?: string, limit: number = 100): Event[] {
  ensureDir();
  
  if (!fs.existsSync(EVENTS_FILE)) {
    return [];
  }
  
  const content = fs.readFileSync(EVENTS_FILE, 'utf-8');
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
  
  // 按 taskId 过滤
  if (taskId) {
    events = events.filter(e => e.task_id === taskId);
  }
  
  // 返回最新的 limit 条
  return events.slice(-limit);
}

/**
 * 获取某任务的事件数量
 */
export function getEventCount(taskId?: string): number {
  return getEvents(taskId, 10000).length;
}
