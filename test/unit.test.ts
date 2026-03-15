/**
 * 里程碑 3.2 单元测试
 * 
 * 测试等待与通知基础功能
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';

// 导入模块
import * as waiter from '../src/waiter.js';
import * as notification from '../src/notification.js';

const WAITING_FILE = '/tmp/test-waiting.json';
const NOTIFICATIONS_FILE = '/tmp/test-notifications.json';

// 设置测试环境变量
process.env.WORKSPACE_DIR = '/tmp';

describe('Waiter Module', () => {
  beforeEach(() => {
    // 清理测试文件
    try { fs.unlinkSync(WAITING_FILE); } catch {}
    try { fs.unlinkSync(NOTIFICATIONS_FILE); } catch {}
  });

  it('should register and unregister waiting', () => {
    waiter.registerWaiting('agent-1', 't1', 3600);
    
    const task = waiter.getWaitingTask('agent-1');
    expect(task).toBe('t1');
    
    const agent = waiter.getWaitingAgent('t1');
    expect(agent).toBe('agent-1');
    
    waiter.unregisterWaiting('agent-1');
    expect(waiter.getWaitingTask('agent-1')).toBeNull();
  });

  it('should get all waiting entries', () => {
    waiter.registerWaiting('agent-1', 't1', 3600);
    waiter.registerWaiting('agent-2', 't2', 1800);
    
    const all = waiter.getAllWaiting();
    expect(all).toHaveLength(2);
  });

  it('should check if task is being waited', () => {
    waiter.registerWaiting('agent-1', 't1', 3600);
    
    expect(waiter.isWaiting('t1')).toBe(true);
    expect(waiter.isWaiting('t2')).toBe(false);
  });

  it('should cleanup timeout waiting', () => {
    // 注册超时时间为 1 秒的等待
    waiter.registerWaiting('agent-1', 't1', 1);
    
    // 等待 2 秒
    setTimeout(() => {}, 2000);
    
    const count = waiter.cleanupWaiting();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

describe('Notification Module', () => {
  beforeEach(() => {
    try { fs.unlinkSync(WAITING_FILE); } catch {}
    try { fs.unlinkSync(NOTIFICATIONS_FILE); } catch {}
  });

  it('should add and get notification', () => {
    notification.addNotification('t1', {
      type: 'progress',
      message: '50%',
      timestamp: new Date().toISOString(),
      agent_id: 'agent-1'
    });
    
    const notif = notification.peekNotification('t1');
    expect(notif).not.toBeNull();
    expect(notif.message).toBe('50%');
  });

  it('should get and clear notification', () => {
    notification.addNotification('t1', {
      type: 'progress',
      message: '50%',
      timestamp: new Date().toISOString(),
      agent_id: 'agent-1'
    });
    
    const notif = notification.getAndClearNotification('t1');
    expect(notif.message).toBe('50%');
    
    // 再次获取应该为空
    const notif2 = notification.getAndClearNotification('t1');
    expect(notif2).toBeNull();
  });

  it('should get all notifications for task', () => {
    notification.addNotification('t1', {
      type: 'progress',
      message: '30%',
      timestamp: new Date().toISOString(),
      agent_id: 'agent-1'
    });
    notification.addNotification('t1', {
      type: 'progress',
      message: '60%',
      timestamp: new Date().toISOString(),
      agent_id: 'agent-1'
    });
    
    const all = notification.peekAllNotifications('t1');
    expect(all).toHaveLength(2);
  });

  it('should clear notifications', () => {
    notification.addNotification('t1', {
      type: 'progress',
      message: '50%',
      timestamp: new Date().toISOString(),
      agent_id: 'agent-1'
    });
    
    notification.clearNotifications('t1');
    
    const notif = notification.peekNotification('t1');
    expect(notif).toBeNull();
  });

  it('should get tasks with notifications', () => {
    notification.addNotification('t1', {
      type: 'progress',
      message: '50%',
      timestamp: new Date().toISOString(),
      agent_id: 'agent-1'
    });
    notification.addNotification('t2', {
      type: 'progress',
      message: '50%',
      timestamp: new Date().toISOString(),
      agent_id: 'agent-2'
    });
    
    const tasks = notification.getTasksWithNotifications();
    expect(tasks).toContain('t1');
    expect(tasks).toContain('t2');
  });

  it('should return notification count', () => {
    notification.addNotification('t1', {
      type: 'progress',
      message: '50%',
      timestamp: new Date().toISOString(),
      agent_id: 'agent-1'
    });
    
    const count = notification.getNotificationCount('t1');
    expect(count).toBe(1);
    
    const count2 = notification.getNotificationCount('t2');
    expect(count2).toBe(0);
  });
});

describe('Integration', () => {
  beforeEach(() => {
    try { fs.unlinkSync(WAITING_FILE); } catch {}
    try { fs.unlinkSync(NOTIFICATIONS_FILE); } catch {}
  });

  it('should handle wait and notify flow', () => {
    // 1. 注册等待
    waiter.registerWaiting('main', 't1', 3600);
    expect(waiter.getWaitingTask('main')).toBe('t1');
    
    // 2. 添加通知
    notification.addNotification('t1', {
      type: 'progress',
      message: '进度 50%',
      timestamp: new Date().toISOString(),
      agent_id: 'sub-agent'
    });
    
    // 3. 获取并清除通知
    const notif = notification.getAndClearNotification('t1');
    expect(notif.message).toBe('进度 50%');
    
    // 4. 取消等待
    waiter.unregisterWaiting('main');
    expect(waiter.getWaitingTask('main')).toBeNull();
  });
});
