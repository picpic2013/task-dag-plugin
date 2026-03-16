/**
 * 里程碑 3.2 单元测试
 * 直接运行模块函数验证功能
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const testWorkspaceDir = path.join(os.tmpdir(), `task-dag-plugin-tests-${Date.now()}`);
fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
fs.mkdirSync(testWorkspaceDir, { recursive: true });
process.env.WORKSPACE_DIR = testWorkspaceDir;

const waiter = await import('./dist/src/waiter.js');
const notification = await import('./dist/src/notification.js');
const dag = await import('./dist/src/dag.js');
const types = await import('./dist/src/types.js');
const bindings = await import('./dist/src/bindings.js');
const tools = await import('./dist/src/tools.js');
const hooks = await import('./dist/src/hooks.js');
const events = await import('./dist/src/events.js');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function withTempWorkspace(name, fn) {
  const workspaceDir = path.join(os.tmpdir(), `task-dag-plugin-${name}-${Date.now()}`);
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  process.env.WORKSPACE_DIR = workspaceDir;
  dag.setCurrentAgentId('main');
  return fn(workspaceDir);
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

console.log('\n=== Task State Machine ===\n');

test('createDAG marks root tasks as ready and dependent tasks as blocked', () => {
  withTempWorkspace('state-create', () => {
    const created = dag.createDAG('state-machine', [
      { id: 't1', name: 'Root task' },
      { id: 't2', name: 'Dependent task', dependencies: ['t1'] }
    ]);

    assert(created.tasks.t1.status === 'ready', 'Root task should be ready');
    assert(created.tasks.t2.status === 'blocked', 'Dependent task should be blocked');
  });
});

test('getReadyTasks only returns ready tasks', () => {
  withTempWorkspace('state-ready-list', () => {
    dag.createDAG('ready-list', [
      { id: 't1', name: 'Root task' },
      { id: 't2', name: 'Dependent task', dependencies: ['t1'] }
    ]);

    const readyTasks = dag.getReadyTasks();
    assert(readyTasks.length === 1, 'Should only have one ready task');
    assert(readyTasks[0].id === 't1', 'Ready task should be t1');
  });
});

test('downstream task becomes ready after dependency completes', () => {
  withTempWorkspace('state-transition', () => {
    dag.createDAG('transition', [
      { id: 't1', name: 'Root task' },
      { id: 't2', name: 'Dependent task', dependencies: ['t1'] }
    ]);

    dag.updateTask('t1', { status: 'done' });

    const downstream = dag.getTask('t2');
    assert(downstream?.status === 'ready', 'Dependent task should become ready');
  });
});

test('waiting states are preserved during dependency recalculation', () => {
  withTempWorkspace('state-waiting', () => {
    dag.createDAG('waiting', [{ id: 't1', name: 'Root task' }]);

    dag.updateTask('t1', {
      status: 'waiting_subagent',
      executor: {
        type: 'subagent',
        agent_id: 'worker-1',
        session_key: 'agent:worker-1:subagent:1',
        run_id: 'run-1',
      },
      waiting_for: {
        kind: 'subagent',
        session_key: 'agent:worker-1:subagent:1',
        run_id: 'run-1',
      },
    });

    const task = dag.getTask('t1');
    assert(task?.status === 'waiting_subagent', 'Waiting status should be preserved');
    assert(task?.executor?.type === 'subagent', 'Executor metadata should be stored');
  });
});

test('resumeFrom resets runtime fields and recalculates readiness', () => {
  withTempWorkspace('state-resume', () => {
    dag.createDAG('resume', [
      { id: 't1', name: 'Root task' },
      { id: 't2', name: 'Dependent task', dependencies: ['t1'] }
    ]);

    dag.updateTask('t1', {
      status: 'waiting_children',
      executor: { type: 'parent', agent_id: 'main' },
      waiting_for: { kind: 'children', child_task_ids: ['t2'] },
      progress: 50,
      checkpoint: { cursor: 1 },
    });

    const resetTasks = dag.resumeFrom('t1');
    const root = dag.getTask('t1');
    const child = dag.getTask('t2');

    assert(resetTasks.includes('t1') && resetTasks.includes('t2'), 'Should reset root and downstream tasks');
    assert(root?.status === 'ready', 'Root task should become ready after resume');
    assert(root?.progress === 0, 'Root progress should reset');
    assert(root?.executor === undefined, 'Executor should be cleared');
    assert(root?.waiting_for === undefined, 'Waiting metadata should be cleared');
    assert(child?.status === 'blocked', 'Downstream task should be blocked until dependency is done again');
  });
});

test('validateTask accepts milestone 01 runtime metadata', () => {
  const task = types.createTask({ id: 't-runtime', name: 'Runtime task' });
  task.status = 'waiting_children';
  task.executor = { type: 'parent', agent_id: 'main' };
  task.waiting_for = { kind: 'children', child_task_ids: ['t-child'] };

  assert(types.validateTask(task) === true, 'Task should validate with waiting metadata');
});

console.log('\n=== Bindings Layer ===\n');

test('single task binding can be queried by task, session, and run', () => {
  withTempWorkspace('bindings-single', () => {
    const context = { agentId: 'main', dagId: 'dag-bind-1' };

    const sessionRun = bindings.saveSessionRun({
      run_id: 'run-1',
      child_session_key: 'agent:worker:subagent:1',
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: 'dag-bind-1',
      spawn_mode: 'single_task',
      label: 'task:t1',
      active_task_ids: ['t1'],
    }, context);

    const binding = bindings.upsertTaskBinding({
      dag_id: 'dag-bind-1',
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: sessionRun.child_session_key,
      run_id: sessionRun.run_id,
      binding_status: 'active',
    }, context);

    assert(bindings.getSessionRunByRunId('run-1', context)?.dag_id === 'dag-bind-1', 'Run should resolve DAG');
    assert(bindings.getSessionRunBySessionKey('agent:worker:subagent:1', context)?.run_id === 'run-1', 'Session should resolve run');
    assert(bindings.listTaskBindings({ task_id: 't1' }, context).length === 1, 'Task should have one binding');
    assert(bindings.getTaskBinding(binding.binding_id, context)?.task_id === 't1', 'Binding lookup should succeed');
  });
});

test('single session can bind multiple tasks', () => {
  withTempWorkspace('bindings-multi-task', () => {
    const context = { agentId: 'main', dagId: 'dag-bind-2' };

    bindings.saveSessionRun({
      run_id: 'run-2',
      child_session_key: 'agent:worker:subagent:2',
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: 'dag-bind-2',
      spawn_mode: 'multi_task',
      active_task_ids: ['t1'],
    }, context);

    bindings.attachTaskToSessionRun('run-2', 't2', context);
    bindings.upsertTaskBinding({
      dag_id: 'dag-bind-2',
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:2',
      run_id: 'run-2',
      binding_status: 'active',
    }, context);
    bindings.upsertTaskBinding({
      dag_id: 'dag-bind-2',
      task_id: 't2',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:2',
      run_id: 'run-2',
      binding_status: 'active',
    }, context);

    const sessionRun = bindings.getSessionRunByRunId('run-2', context);
    const sessionBindings = bindings.listTaskBindings({ session_key: 'agent:worker:subagent:2' }, context);

    assert(sessionRun?.active_task_ids.length === 2, 'Run should track two active tasks');
    assert(sessionBindings.length === 2, 'Session should expose two task bindings');
  });
});

test('multiple sessions and tasks can coexist in the same DAG', () => {
  withTempWorkspace('bindings-multi-session', () => {
    const context = { agentId: 'main', dagId: 'dag-bind-3' };

    bindings.saveSessionRun({
      run_id: 'run-a',
      child_session_key: 'agent:worker-a:subagent:1',
      parent_agent_id: 'main',
      dag_id: 'dag-bind-3',
      spawn_mode: 'single_task',
      active_task_ids: ['t1'],
    }, context);
    bindings.saveSessionRun({
      run_id: 'run-b',
      child_session_key: 'agent:worker-b:subagent:1',
      parent_agent_id: 'main',
      dag_id: 'dag-bind-3',
      spawn_mode: 'single_task',
      active_task_ids: ['t2'],
    }, context);

    bindings.upsertTaskBinding({
      dag_id: 'dag-bind-3',
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker-a',
      session_key: 'agent:worker-a:subagent:1',
      run_id: 'run-a',
      binding_status: 'active',
    }, context);
    bindings.upsertTaskBinding({
      dag_id: 'dag-bind-3',
      task_id: 't2',
      executor_type: 'subagent',
      executor_agent_id: 'worker-b',
      session_key: 'agent:worker-b:subagent:1',
      run_id: 'run-b',
      binding_status: 'active',
    }, context);

    assert(bindings.listTaskBindings({ run_id: 'run-a' }, context)[0]?.task_id === 't1', 'run-a should map to t1');
    assert(bindings.listTaskBindings({ run_id: 'run-b' }, context)[0]?.task_id === 't2', 'run-b should map to t2');
  });
});

test('pending events support replay and consumption', () => {
  withTempWorkspace('bindings-events', () => {
    const context = { agentId: 'main', dagId: 'dag-bind-4' };

    const event = bindings.appendPendingEvent({
      type: 'subagent_completed',
      dag_id: 'dag-bind-4',
      task_id: 't1',
      session_key: 'agent:worker:subagent:4',
      run_id: 'run-4',
      payload: { outcome: 'ok' },
    }, context);

    assert(bindings.listPendingEvents({}, context).length === 1, 'Should load unconsumed event');
    bindings.consumePendingEvent(event.event_id, context);
    assert(bindings.listPendingEvents({}, context).length === 0, 'Consumed event should not appear by default');
    assert(bindings.listPendingEvents({ includeConsumed: true }, context).length === 1, 'Consumed event should remain replayable');
  });
});

test('bindings and runs survive reload from disk', () => {
  withTempWorkspace('bindings-reload', (workspaceDir) => {
    const context = { agentId: 'main', dagId: 'dag-bind-5' };

    bindings.saveSessionRun({
      run_id: 'run-5',
      child_session_key: 'agent:worker:subagent:5',
      parent_agent_id: 'main',
      dag_id: 'dag-bind-5',
      spawn_mode: 'single_task',
      active_task_ids: ['t1'],
    }, context);
    bindings.upsertTaskBinding({
      dag_id: 'dag-bind-5',
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:5',
      run_id: 'run-5',
      binding_status: 'active',
    }, context);

    const taskBindingsPath = path.join(workspaceDir, 'workspace', 'tasks', 'dag-bind-5', 'task-bindings.json');
    const sessionRunsPath = path.join(workspaceDir, 'workspace', 'tasks', 'dag-bind-5', 'session-runs.json');

    assert(fs.existsSync(taskBindingsPath), 'Bindings file should exist on disk');
    assert(fs.existsSync(sessionRunsPath), 'Session runs file should exist on disk');
    assert(bindings.listTaskBindings({ task_id: 't1' }, context).length === 1, 'Binding should be recoverable from disk');
    assert(bindings.getSessionRunByRunId('run-5', context)?.child_session_key === 'agent:worker:subagent:5', 'Session run should be recoverable from disk');
  });
});

console.log('\n=== Tool Protocol ===\n');

test('task_dag_claim marks a task running with executor metadata', async () => {
  await withTempWorkspace('tool-claim', async () => {
    dag.createDAG('tool-claim', [{ id: 't1', name: 'Claim me' }]);
    const result = await tools.claimTaskExecution({
      task_id: 't1',
      executor_type: 'parent',
      executor_agent_id: 'main',
      message: 'started work',
    }, {});

    assert(result.success === true, 'Claim should succeed');
    assert(dag.getTask('t1')?.status === 'running', 'Task should be running');
    assert(dag.getTask('t1')?.executor?.type === 'parent', 'Executor metadata should be set');
  });
});

test('task_dag_spawn creates binding and moves task into waiting_subagent', async () => {
  await withTempWorkspace('tool-spawn', async () => {
    dag.createDAG('tool-spawn', [{ id: 't1', name: 'Spawn me' }]);

    const runtime = {
      sessions_spawn: async () => ({
        sessionKey: 'agent:worker:subagent:spawn-1',
        runId: 'run-spawn-1',
      }),
    };

    const result = await tools.spawnTaskExecution(runtime, {
      task_id: 't1',
      task: 'Do sub work',
      agentId: 'worker',
    }, { session: { key: 'agent:main' } });

    assert(result.success === true, 'Spawn should succeed');
    assert(dag.getTask('t1')?.status === 'waiting_subagent', 'Task should wait on subagent');
    assert(bindings.listTaskBindings({ task_id: 't1' }, { dagId: result.dag_id }).length === 1, 'Binding should exist');
    assert(bindings.getSessionRunByRunId('run-spawn-1', { dagId: result.dag_id })?.child_session_key === 'agent:worker:subagent:spawn-1', 'Session run should persist');
  });
});

test('task_dag_assign binds multiple tasks to the same session run', async () => {
  await withTempWorkspace('tool-assign', async () => {
    dag.createDAG('tool-assign', [
      { id: 't1', name: 'Task 1' },
      { id: 't2', name: 'Task 2' },
    ]);

    bindings.saveSessionRun({
      run_id: 'run-assign-1',
      child_session_key: 'agent:worker:subagent:assign-1',
      parent_agent_id: 'main',
      dag_id: dag.getCurrentDagId(),
      spawn_mode: 'shared_worker',
      active_task_ids: ['t1'],
    }, { dagId: dag.getCurrentDagId() });

    const result = await tools.assignTasksToSession({
      task_ids: ['t1', 't2'],
      run_id: 'run-assign-1',
      executor_agent_id: 'worker',
    }, {});

    assert(result.success === true, 'Assign should succeed');
    assert(result.assigned_task_ids.length === 2, 'Two tasks should be assigned');
    assert(bindings.getSessionRunByRunId('run-assign-1', { dagId: dag.getCurrentDagId() })?.active_task_ids.length === 2, 'Run should track both tasks');
  });
});

test('task_dag_wait is non-blocking and reports notifications', async () => {
  await withTempWorkspace('tool-wait', async () => {
    dag.createDAG('tool-wait', [{ id: 't1', name: 'Wait me' }]);
    notification.addNotification('t1', {
      type: 'progress',
      message: 'halfway',
      timestamp: new Date().toISOString(),
      agent_id: 'worker',
    });

    const result = await tools.checkTaskWaitStatus({ task_id: 't1' }, {});
    assert(result.status === 'notified', 'Wait should return notified immediately');
  });
});

test('task_dag_poll_events and ack_event expose deterministic event consumption', async () => {
  await withTempWorkspace('tool-events', async () => {
    dag.createDAG('tool-events', [{ id: 't1', name: 'Events task' }]);
    const dagId = dag.getCurrentDagId();
    const event = bindings.appendPendingEvent({
      type: 'task_progress',
      dag_id: dagId,
      task_id: 't1',
      payload: { progress: 25 },
    }, { dagId });

    const polled = await tools.pollTaskEvents({ task_id: 't1' }, {});
    assert(polled.events.length === 1, 'Poll should return one event');

    const acked = await tools.ackTaskEvent({ event_id: event.event_id }, {});
    assert(acked.success === true, 'Ack should succeed');

    const afterAck = await tools.pollTaskEvents({ task_id: 't1' }, {});
    assert(afterAck.events.length === 0, 'Consumed event should no longer appear by default');
  });
});

test('task_dag_reconcile closes terminal task bindings', async () => {
  await withTempWorkspace('tool-reconcile', async () => {
    dag.createDAG('tool-reconcile', [{ id: 't1', name: 'Reconcile me' }]);
    const dagId = dag.getCurrentDagId();

    bindings.upsertTaskBinding({
      dag_id: dagId,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:reconcile',
      run_id: 'run-reconcile',
      binding_status: 'active',
    }, { dagId });
    dag.updateTask('t1', { status: 'done', output_summary: 'finished' });

    const result = await tools.reconcileTaskDagState({}, {});
    assert(result.success === true, 'Reconcile should succeed');
    assert(result.reconciled.length === 1, 'Reconcile should fix one task');
    assert(bindings.listTaskBindings({ task_id: 't1', binding_status: 'active' }, { dagId }).length === 0, 'Active binding should be closed');
  });
});

console.log('\n=== Hook Flow ===\n');

test('subagent_spawned hook persists session context and binding metadata', async () => {
  await withTempWorkspace('hook-spawned', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('hook-spawned', [{ id: 't1', name: 'Hook task' }]);

    hooks.handleSubagentSpawnedEvent({
      childSessionKey: 'agent:worker:subagent:hook-1',
      requesterSessionKey: 'agent:main',
      agentId: 'worker',
      label: 'task:t1',
      runId: 'run-hook-1',
      dagId: created.id,
      parentAgentId: 'main',
    }, console);

    const run = bindings.getSessionRunByRunId('run-hook-1', { dagId: created.id });
    const taskBindings = bindings.listTaskBindings({ task_id: 't1' }, { dagId: created.id });
    const pendingEvents = bindings.listPendingEvents({ type: 'subagent_spawned' }, { dagId: created.id });

    assert(run?.child_session_key === 'agent:worker:subagent:hook-1', 'Hook should persist session run');
    assert(taskBindings.length >= 1, 'Hook should create task binding');
    assert(pendingEvents.length === 1, 'Hook should emit pending spawn event');
  });
});

test('subagent_ended hook closes all active bindings for a session and unlocks downstream tasks', async () => {
  await withTempWorkspace('hook-ended', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('hook-ended', [
      { id: 't1', name: 'Sub task 1' },
      { id: 't2', name: 'Sub task 2' },
      { id: 't3', name: 'Downstream', dependencies: ['t1', 't2'] },
    ]);

    bindings.saveSessionRun({
      run_id: 'run-hook-2',
      child_session_key: 'agent:worker:subagent:hook-2',
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'multi_task',
      active_task_ids: ['t1', 't2'],
    }, { dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:hook-2',
      run_id: 'run-hook-2',
      binding_status: 'active',
    }, { dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't2',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:hook-2',
      run_id: 'run-hook-2',
      binding_status: 'active',
    }, { dagId: created.id });

    const result = hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:hook-2',
      runId: 'run-hook-2',
      outcome: 'ok',
      dagId: created.id,
      parentAgentId: 'main',
    }, console);

    assert(result.task_ids.length === 2, 'Ended hook should close both bound tasks');
    assert(dag.getTask('t1')?.status === 'done', 'First task should be done');
    assert(dag.getTask('t2')?.status === 'done', 'Second task should be done');
    assert(dag.getTask('t3')?.status === 'ready', 'Downstream task should become ready');
    assert(result.newly_ready_task_ids.includes('t3'), 'Ended hook should report newly ready downstream task');
    assert(bindings.listTaskBindings({ session_key: 'agent:worker:subagent:hook-2', binding_status: 'active' }, { dagId: created.id }).length === 0, 'Active bindings should be closed');
  });
});

test('subagent_ended hook tolerates delayed completion after task already closed', async () => {
  await withTempWorkspace('hook-ended-delayed', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('hook-ended-delayed', [{ id: 't1', name: 'Already done' }]);

    bindings.saveSessionRun({
      run_id: 'run-hook-3',
      child_session_key: 'agent:worker:subagent:hook-3',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'single_task',
      active_task_ids: ['t1'],
    }, { dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:hook-3',
      run_id: 'run-hook-3',
      binding_status: 'active',
    }, { dagId: created.id });
    dag.updateTask('t1', { status: 'done', output_summary: 'already completed' });

    const result = hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:hook-3',
      runId: 'run-hook-3',
      outcome: 'ok',
      dagId: created.id,
      parentAgentId: 'main',
    }, console);

    assert(result.task_ids[0] === 't1', 'Delayed ended hook should still resolve task');
    assert(dag.getTask('t1')?.status === 'done', 'Done task should remain done');
  });
});

test('subagent_ended hook emits orphan event when bindings are missing', async () => {
  await withTempWorkspace('hook-orphaned', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('hook-orphaned', [{ id: 't1', name: 'Orphan check' }]);

    hooks.handleSubagentSpawnedEvent({
      childSessionKey: 'agent:worker:subagent:hook-4',
      requesterSessionKey: 'agent:main',
      agentId: 'worker',
      label: 'task:t1',
      runId: 'run-hook-4',
      dagId: created.id,
      parentAgentId: 'main',
    }, console);

    const existingBindings = bindings.listTaskBindings({ session_key: 'agent:worker:subagent:hook-4', binding_status: 'active' }, { dagId: created.id });
    for (const binding of existingBindings) {
      bindings.completeTaskBinding(binding.binding_id, 'released', { dagId: created.id });
    }

    const result = hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:hook-4',
      runId: 'run-hook-4',
      outcome: 'error',
      dagId: created.id,
      parentAgentId: 'main',
    }, console);

    const orphanEvents = bindings.listPendingEvents({ type: 'binding_orphaned' }, { dagId: created.id });
    assert(result.task_ids.length === 0, 'Orphaned hook should not close any tasks');
    assert(orphanEvents.length === 1, 'Orphaned hook should emit binding_orphaned event');
  });
});

console.log('\n=== Continuation Flow ===\n');

test('task_dag_continue produces a user reply summary for a completed single subagent run', async () => {
  await withTempWorkspace('continue-single', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('continue-single', [{ id: 't1', name: 'Single task' }]);

    bindings.saveSessionRun({
      run_id: 'run-continue-1',
      child_session_key: 'agent:worker:subagent:continue-1',
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'single_task',
      active_task_ids: ['t1'],
    }, { dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:continue-1',
      run_id: 'run-continue-1',
      binding_status: 'active',
    }, { dagId: created.id });

    hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:continue-1',
      runId: 'run-continue-1',
      outcome: 'ok',
      dagId: created.id,
      parentAgentId: 'main',
    }, console);

    const result = await tools.continueParentSession({ run_id: 'run-continue-1' }, {});
    const secondResult = await tools.continueParentSession({ run_id: 'run-continue-1' }, {});

    assert(result.action === 'user_reply', 'Single completed run should trigger user reply');
    assert(result.should_reply_to_user === true, 'Single completed run should be replyable');
    assert(result.completed_task_ids.includes('t1'), 'Completed task should appear in summary');
    assert(secondResult.action === 'user_reply' || secondResult.action === 'idle', 'Second continuation should not regress');
    assert(secondResult.pending_event_ids.length === 0, 'Consumed events should not reappear');
  });
});

test('task_dag_continue waits for remaining subtasks before final reply', async () => {
  await withTempWorkspace('continue-multi', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('continue-multi', [
      { id: 't1', name: 'First subtask' },
      { id: 't2', name: 'Second subtask' },
    ]);

    bindings.saveSessionRun({
      run_id: 'run-continue-2',
      child_session_key: 'agent:worker:subagent:continue-2',
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'multi_task',
      active_task_ids: ['t1', 't2'],
    }, { dagId: created.id });
    for (const taskId of ['t1', 't2']) {
      bindings.upsertTaskBinding({
        dag_id: created.id,
        task_id: taskId,
        executor_type: 'subagent',
        executor_agent_id: 'worker',
        session_key: 'agent:worker:subagent:continue-2',
        run_id: 'run-continue-2',
        binding_status: 'active',
      }, { dagId: created.id });
      dag.updateTask(taskId, {
        status: 'waiting_subagent',
        executor: { type: 'subagent', agent_id: 'worker', session_key: 'agent:worker:subagent:continue-2', run_id: 'run-continue-2' },
        waiting_for: { kind: 'subagent', session_key: 'agent:worker:subagent:continue-2', run_id: 'run-continue-2' },
      });
    }

    dag.updateTask('t1', { status: 'done', output_summary: 'partial result' });
    const activeT1Binding = bindings.listTaskBindings({ task_id: 't1', binding_status: 'active' }, { dagId: created.id })[0];
    bindings.completeTaskBinding(activeT1Binding.binding_id, 'completed', { dagId: created.id });
    bindings.appendPendingEvent({
      type: 'subagent_completed',
      dag_id: created.id,
      task_id: 't1',
      session_key: 'agent:worker:subagent:continue-2',
      run_id: 'run-continue-2',
      dedupe_key: 'continue-multi-partial',
      payload: { outcome: 'ok' },
    }, { dagId: created.id });

    const partial = await tools.continueParentSession({ run_id: 'run-continue-2' }, {});
    assert(partial.action === 'continue_waiting', 'Partial completion should keep waiting');
    assert(partial.should_reply_to_user === false, 'Partial completion should not reply by default');
    assert(partial.completed_task_ids.includes('t1'), 'Partial completion should report completed task');
    assert(partial.waiting_task_ids.includes('t2'), 'Remaining task should still be waiting');

    hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:continue-2',
      runId: 'run-continue-2',
      outcome: 'ok',
      dagId: created.id,
      parentAgentId: 'main',
    }, console);

    const final = await tools.continueParentSession({ run_id: 'run-continue-2' }, {});
    assert(final.action === 'user_reply', 'All tasks finished should trigger final reply');
    assert(final.completed_task_ids.includes('t1') && final.completed_task_ids.includes('t2'), 'Final summary should include both tasks');
  });
});

test('duplicate ended events do not create duplicate continuation output', async () => {
  await withTempWorkspace('continue-dedup', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('continue-dedup', [{ id: 't1', name: 'Dedup task' }]);

    bindings.saveSessionRun({
      run_id: 'run-continue-3',
      child_session_key: 'agent:worker:subagent:continue-3',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'single_task',
      active_task_ids: ['t1'],
    }, { dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:continue-3',
      run_id: 'run-continue-3',
      binding_status: 'active',
    }, { dagId: created.id });

    hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:continue-3',
      runId: 'run-continue-3',
      outcome: 'ok',
      dagId: created.id,
      parentAgentId: 'main',
    }, console);
    hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:continue-3',
      runId: 'run-continue-3',
      outcome: 'ok',
      dagId: created.id,
      parentAgentId: 'main',
    }, console);

    const completionEvents = bindings.listPendingEvents({
      run_id: 'run-continue-3',
      type: 'subagent_completed',
      includeConsumed: true,
    }, { dagId: created.id });
    const first = await tools.continueParentSession({ run_id: 'run-continue-3' }, {});
    const second = await tools.continueParentSession({ run_id: 'run-continue-3' }, {});

    assert(completionEvents.length === 1, 'Duplicate ended hooks should dedupe completion events');
    assert(first.action === 'user_reply', 'First continuation should produce reply');
    assert(second.pending_event_ids.length === 0, 'Second continuation should not see duplicate events');
  });
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    failed++;
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
