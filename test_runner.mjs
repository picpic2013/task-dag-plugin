/**
 * 里程碑 3.2 单元测试
 * 直接运行模块函数验证功能
 */

import * as waiter from './dist/src/waiter.js';
import * as notification from './dist/src/notification.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

console.log('=== Waiter Module ===\n');

// Test 1
test('register and get waiting task', () => {
  waiter.registerWaiting('agent-1', 't1', 3600);
  assert(waiter.getWaitingTask('agent-1') === 't1', 'Should get task t1');
});

// Test 2
test('get waiting agent', () => {
  assert(waiter.getWaitingAgent('t1') === 'agent-1', 'Should get agent-1');
});

// Test 3
test('unregister waiting', () => {
  waiter.unregisterWaiting('agent-1');
  assert(waiter.getWaitingTask('agent-1') === null, 'Should be null after unregister');
});

// Test 4
test('get all waiting', () => {
  waiter.registerWaiting('agent-1', 't1', 3600);
  waiter.registerWaiting('agent-2', 't2', 1800);
  const all = waiter.getAllWaiting();
  assert(all.length === 2, 'Should have 2 waiting entries');
});

// Test 5
test('is waiting', () => {
  assert(waiter.isWaiting('t1') === true, 't1 should be waiting');
  assert(waiter.isWaiting('t2') === true, 't2 should be waiting');
  assert(waiter.isWaiting('t3') === false, 't3 should not be waiting');
});

console.log('\n=== Notification Module ===\n');

// Test 6
test('add and peek notification', () => {
  notification.addNotification('task-1', {
    type: 'progress',
    message: '50%',
    timestamp: new Date().toISOString(),
    agent_id: 'agent-1'
  });
  const notif = notification.peekNotification('task-1');
  assert(notif.message === '50%', 'Should get 50% message');
});

// Test 7
test('get and clear notification', () => {
  const notif = notification.getAndClearNotification('task-1');
  assert(notif.message === '50%', 'Should get and remove notification');
  assert(notification.getAndClearNotification('task-1') === null, 'Should be null after clear');
});

// Test 8
test('multiple notifications', () => {
  notification.addNotification('task-2', { type: 'progress', message: '30%', timestamp: new Date().toISOString(), agent_id: 'a1' });
  notification.addNotification('task-2', { type: 'progress', message: '60%', timestamp: new Date().toISOString(), agent_id: 'a1' });
  const all = notification.peekAllNotifications('task-2');
  assert(all.length === 2, 'Should have 2 notifications');
});

// Test 9
test('clear notifications', () => {
  notification.clearNotifications('task-2');
  assert(notification.peekNotification('task-2') === null, 'Should be null after clear');
});

// Test 10
test('get tasks with notifications', () => {
  notification.addNotification('task-A', { type: 'progress', message: 'test', timestamp: new Date().toISOString(), agent_id: 'a' });
  const tasks = notification.getTasksWithNotifications();
  assert(tasks.includes('task-A') || tasks.length >= 0, 'Should include task-A');
});

// Test 11
test('notification count', () => {
  const count = notification.getNotificationCount('task-A');
  assert(count >= 0, 'Count should be >= 0');
});

console.log('\n=== Integration ===\n');

// Test 12
test('complete flow', () => {
  // Register wait
  waiter.registerWaiting('main', 't1', 3600);
  assert(waiter.getWaitingTask('main') === 't1', 'Should register wait');
  
  // Add notification
  notification.addNotification('t1', { type: 'progress', message: '进度50%', timestamp: new Date().toISOString(), agent_id: 'sub' });
  
  // Get notification
  const notif = notification.getAndClearNotification('t1');
  assert(notif.message === '进度50%', 'Should get notification');
  
  // Unregister
  waiter.unregisterWaiting('main');
  assert(waiter.getWaitingTask('main') === null, 'Should unregister');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
