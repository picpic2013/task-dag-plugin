/**
 * 通知队列管理模块
 * 
 * 管理子 Agent 对主 Agent 的通知
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const WORKSPACE = process.env.WORKSPACE_DIR || path.join(os.homedir(), '.openclaw', 'workspace');
const NOTIFICATIONS_FILE = path.join(WORKSPACE, 'tasks', 'notifications.json');

export type NotificationType = 'progress' | 'issue' | 'complete' | 'failed';

export interface Notification {
  type: NotificationType;
  message: string;
  timestamp: string;
  agent_id: string;
  progress?: number;
}

interface NotificationsData {
  queue: Record<string, Notification[]>;
}

// ============= 辅助函数 =============

function ensureDir(): void {
  const dir = path.dirname(NOTIFICATIONS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadNotifications(): NotificationsData {
  try {
    ensureDir();
    if (!fs.existsSync(NOTIFICATIONS_FILE)) {
      return { queue: {} };
    }
    const data = fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { queue: {} };
  }
}

function saveNotifications(data: NotificationsData): void {
  ensureDir();
  fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(data, null, 2));
}

// ============= 核心函数 =============

/**
 * 添加通知
 */
export function addNotification(taskId: string, notification: Notification): void {
  const notifications = loadNotifications();
  
  if (!notifications.queue[taskId]) {
    notifications.queue[taskId] = [];
  }
  
  notifications.queue[taskId].push(notification);
  saveNotifications(notifications);
}

/**
 * 获取并清除通知（取出后删除）
 */
export function getAndClearNotification(taskId: string): Notification | null {
  const notifications = loadNotifications();
  const list = notifications.queue[taskId];
  
  if (!list || list.length === 0) {
    return null;
  }
  
  // 取出第一个通知
  const notification = list.shift()!;
  
  // 如果列表为空，删除该 key
  if (list.length === 0) {
    delete notifications.queue[taskId];
  }
  
  saveNotifications(notifications);
  return notification;
}

/**
 * 查看通知（不删除）
 */
export function peekNotification(taskId: string): Notification | null {
  const notifications = loadNotifications();
  const list = notifications.queue[taskId];
  return list?.[0] || null;
}

/**
 * 查看所有通知（不删除）
 */
export function peekAllNotifications(taskId: string): Notification[] {
  const notifications = loadNotifications();
  return notifications.queue[taskId] || [];
}

/**
 * 清除所有通知
 */
export function clearNotifications(taskId: string): void {
  const notifications = loadNotifications();
  delete notifications.queue[taskId];
  saveNotifications(notifications);
}

/**
 * 获取所有有通知的任务
 */
export function getTasksWithNotifications(): string[] {
  const notifications = loadNotifications();
  return Object.keys(notifications.queue).filter(
    taskId => notifications.queue[taskId].length > 0
  );
}

/**
 * 通知数量
 */
export function getNotificationCount(taskId: string): number {
  const notifications = loadNotifications();
  return notifications.queue[taskId]?.length || 0;
}

/**
 * 清理旧通知（超过一定时间的）
 */
export function cleanupOldNotifications(maxAgeMs: number = 3600000): number {
  const notifications = loadNotifications();
  const now = Date.now();
  let count = 0;
  
  for (const taskId of Object.keys(notifications.queue)) {
    const list = notifications.queue[taskId];
    notifications.queue[taskId] = list.filter(n => {
      const age = now - new Date(n.timestamp).getTime();
      if (age > maxAgeMs) {
        count++;
        return false;
      }
      return true;
    });
    
    // 如果列表为空，删除该 key
    if (notifications.queue[taskId].length === 0) {
      delete notifications.queue[taskId];
    }
  }
  
  if (count > 0) {
    saveNotifications(notifications);
  }
  
  return count;
}
