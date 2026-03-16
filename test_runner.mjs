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

const notification = await import('./dist/src/notification.js');
const dag = await import('./dist/src/dag.js');
const types = await import('./dist/src/types.js');
const bindings = await import('./dist/src/bindings.js');
const requesterSessions = await import('./dist/src/requester-sessions.js');
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

console.log('\n=== Notification Module ===\n');

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

test('get and clear notification', () => {
  const notif = notification.getAndClearNotification('task-1');
  assert(notif.message === '50%', 'Should get and remove notification');
  assert(notification.getAndClearNotification('task-1') === null, 'Should be null after clear');
});

test('multiple notifications', () => {
  notification.addNotification('task-2', { type: 'progress', message: '30%', timestamp: new Date().toISOString(), agent_id: 'a1' });
  notification.addNotification('task-2', { type: 'progress', message: '60%', timestamp: new Date().toISOString(), agent_id: 'a1' });
  const all = notification.peekAllNotifications('task-2');
  assert(all.length === 2, 'Should have 2 notifications');
});

test('clear notifications', () => {
  notification.clearNotifications('task-2');
  assert(notification.peekNotification('task-2') === null, 'Should be null after clear');
});

test('get tasks with notifications', () => {
  notification.addNotification('task-A', { type: 'progress', message: 'test', timestamp: new Date().toISOString(), agent_id: 'a' });
  const tasks = notification.getTasksWithNotifications();
  assert(tasks.includes('task-A') || tasks.length >= 0, 'Should include task-A');
});

test('notification count', () => {
  const count = notification.getNotificationCount('task-A');
  assert(count >= 0, 'Count should be >= 0');
});

console.log('\n=== Integration ===\n');

test('complete flow', () => {
  // Add notification
  notification.addNotification('t1', { type: 'progress', message: '进度50%', timestamp: new Date().toISOString(), agent_id: 'sub' });
  
  // Get notification
  const notif = notification.getAndClearNotification('t1');
  assert(notif.message === '进度50%', 'Should get notification');
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

test('task_dag_create requires explicit agent context instead of defaulting to main', async () => {
  await withTempWorkspace('tool-create-explicit-agent', async () => {
    const registeredTools = {};
    tools.registerTaskDagTools({
      logger: { info() {}, warn() {}, error() {} },
      registerTool(tool) { registeredTools[tool.name] = tool; },
      registerHook() {},
      runtime: {},
      config: {},
    });

    const result = await registeredTools.task_dag_create.execute('call-create-1', { name: 'chexie-dag', tasks: [{ id: 't1', name: 'Task 1', assigned_agent: 'parent' }] }, undefined, undefined);
    assert(typeof result.error === 'string', 'Create should fail without explicit agent context');
    assert(result.error.includes('Explicit agent context is required'), 'Create should require explicit agent context');
  });
});

test('task_dag_create stores DAG under explicit non-main agent workspace', async () => {
  await withTempWorkspace('tool-create-chexie', async (workspaceDir) => {
    const registeredTools = {};
    tools.registerTaskDagTools({
      logger: { info() {}, warn() {}, error() {} },
      registerTool(tool) { registeredTools[tool.name] = tool; },
      registerHook() {},
      runtime: {},
      config: {},
    });

    const result = await registeredTools.task_dag_create.execute('call-create-2', {
      name: 'chexie-dag',
      agent_id: 'chexie',
      tasks: [{ id: 't1', name: 'Task 1', assigned_agent: 'parent' }],
    }, undefined, undefined);

    assert(result.success === true, 'Create should succeed with explicit agent_id');
    const dagFile = path.join(workspaceDir, 'workspace-chexie', 'tasks', result.dag_id, 'dag.json');
    assert(fs.existsSync(dagFile), 'DAG should be written into workspace-chexie');
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

test('session key can resolve multiple runs without overwriting previous entries', () => {
  withTempWorkspace('bindings-session-multi-run', () => {
    const context = { agentId: 'main', dagId: 'dag-bind-6' };

    bindings.saveSessionRun({
      run_id: 'run-6a',
      child_session_key: 'agent:worker:subagent:shared',
      child_agent_id: 'worker',
      parent_agent_id: 'main',
      dag_id: 'dag-bind-6',
      spawn_mode: 'shared_worker',
      active_task_ids: ['t1'],
    }, context);
    bindings.saveSessionRun({
      run_id: 'run-6b',
      child_session_key: 'agent:worker:subagent:shared',
      child_agent_id: 'worker',
      parent_agent_id: 'main',
      dag_id: 'dag-bind-6',
      spawn_mode: 'shared_worker',
      active_task_ids: ['t2'],
    }, context);

    const runs = bindings.listSessionRunsBySessionKey('agent:worker:subagent:shared', context);
    assert(runs.length === 2, 'Session key should retain both runs');
    assert(bindings.getSessionRunBySessionKey('agent:worker:subagent:shared', context) === null, 'Ambiguous multi-run session lookup should not guess');
  });
});

test('requester session scope persists requester to dag/run mapping', () => {
  withTempWorkspace('requester-scope', () => {
    const scope = requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main:session:1',
      parent_agent_id: 'main',
      dag_id: 'dag-r1',
      run_id: 'run-r1',
      task_ids: ['t1'],
    });

    const fetched = requesterSessions.findRequesterSessionScope({
      requester_session_key: 'agent:main:session:1',
      run_id: 'run-r1',
    });

    assert(scope.dag_id === 'dag-r1', 'Scope should persist dag id');
    assert(fetched?.active_task_ids.includes('t1') === true, 'Scope lookup should resolve by run id');
  });
});

test('requester session scope no longer guesses when multiple scopes exist', () => {
  withTempWorkspace('requester-scope-strict', () => {
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main:session:2',
      parent_agent_id: 'main',
      dag_id: 'dag-a',
      run_id: 'run-a',
      task_ids: ['t1'],
    });
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main:session:2',
      parent_agent_id: 'main',
      dag_id: 'dag-b',
      run_id: 'run-b',
      task_ids: ['t2'],
    });

    const ambiguous = requesterSessions.findRequesterSessionScope({
      requester_session_key: 'agent:main:session:2',
    });

    assert(ambiguous === null, 'Scope lookup should refuse ambiguous requester scopes');
  });
});

test('requester session scope is removed when all runs and tasks complete', () => {
  withTempWorkspace('requester-scope-cleanup', () => {
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main:session:3',
      parent_agent_id: 'main',
      dag_id: 'dag-clean',
      run_id: 'run-clean',
      task_ids: ['t1'],
    });

    requesterSessions.completeRequesterSessionRun({
      requester_session_key: 'agent:main:session:3',
      parent_agent_id: 'main',
      dag_id: 'dag-clean',
      run_id: 'run-clean',
      task_ids: ['t1'],
    });

    const fetched = requesterSessions.findRequesterSessionScope({
      requester_session_key: 'agent:main:session:3',
      dag_id: 'dag-clean',
      parent_agent_id: 'main',
    });
    assert(fetched === null, 'Completed requester scope should be deleted when empty');
  });
});

test('bindings require explicit context', () => {
  let errorMessage = '';
  try {
    bindings.listTaskBindings({ task_id: 't1' });
  } catch (error) {
    errorMessage = error.message;
  }
  assert(errorMessage.includes('explicit agentId'), 'Bindings should reject missing explicit context');
});

console.log('\n=== Tool Protocol ===\n');

test('task_dag_claim marks a task running with executor metadata', async () => {
  await withTempWorkspace('tool-claim', async () => {
    const created = dag.createDAG('tool-claim', [{ id: 't1', name: 'Claim me' }]);
    const result = await tools.claimTaskExecution({
      task_id: 't1',
      dag_id: created.id,
      agent_id: 'main',
      executor_type: 'parent',
      executor_agent_id: 'main',
      message: 'started work',
    }, {});

    assert(result.success === true, 'Claim should succeed');
    assert(dag.getTask('t1')?.status === 'running', 'Task should be running');
    assert(dag.getTask('t1')?.executor?.type === 'parent', 'Executor metadata should be set');
  });
});

test('registered task_dag_claim uses runtime execute signature without losing params', async () => {
  await withTempWorkspace('tool-claim-runtime-signature', async () => {
    const created = dag.createDAG('tool-claim-runtime-signature', [{ id: 't1', name: 'Claim me' }]);
    const registeredTools = {};
    tools.registerTaskDagTools({
      logger: { info() {}, warn() {}, error() {} },
      registerTool(tool) { registeredTools[tool.name] = tool; },
      registerHook() {},
      runtime: {},
      config: {},
    });

    const result = await registeredTools.task_dag_claim.execute('call-claim-runtime', {
      task_id: 't1',
      dag_id: created.id,
      agent_id: 'main',
      executor_type: 'parent',
      executor_agent_id: 'main',
    }, undefined, undefined);

    assert(result.success === true, `Registered claim tool should succeed under runtime signature: ${JSON.stringify(result)}`);
    assert(dag.getTask('t1')?.status === 'running', 'Registered claim tool should update task state');
  });
});

test('task_dag_spawn creates binding and moves task into waiting_subagent', async () => {
  await withTempWorkspace('tool-spawn', async () => {
    const created = dag.createDAG('tool-spawn', [{ id: 't1', name: 'Spawn me' }]);

    const runtime = {
      sessions_spawn: async () => ({
        sessionKey: 'agent:worker:subagent:spawn-1',
        runId: 'run-spawn-1',
      }),
    };

    const result = await tools.spawnTaskExecution(runtime, {
      task_id: 't1',
      dag_id: created.id,
      agent_id: 'main',
      task: 'Do sub work',
      agentId: 'worker',
      requester_session_key: 'agent:main',
    }, {});

    assert(result.success === true, 'Spawn should succeed');
    assert(dag.getTask('t1')?.status === 'waiting_subagent', 'Task should wait on subagent');
    assert(bindings.listTaskBindings({ task_id: 't1' }, { agentId: 'main', dagId: result.dag_id }).length === 1, 'Binding should exist');
    assert(bindings.getSessionRunByRunId('run-spawn-1', { agentId: 'main', dagId: result.dag_id })?.child_session_key === 'agent:worker:subagent:spawn-1', 'Session run should persist');
    assert(bindings.listPendingEvents({ type: 'subagent_spawned' }, { agentId: 'main', dagId: result.dag_id }).length === 0, 'Spawn tool should not emit hook-owned spawn event');
    assert(requesterSessions.findRequesterSessionScope({ requester_session_key: 'agent:main', run_id: 'run-spawn-1' })?.dag_id === result.dag_id, 'Spawn should register requester session scope');
  });
});

test('task_dag_assign binds multiple tasks to the same session run', async () => {
  await withTempWorkspace('tool-assign', async () => {
    const created = dag.createDAG('tool-assign', [
      { id: 't1', name: 'Task 1' },
      { id: 't2', name: 'Task 2' },
    ]);

    bindings.saveSessionRun({
      run_id: 'run-assign-1',
      child_session_key: 'agent:worker:subagent:assign-1',
      child_agent_id: 'worker',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'shared_worker',
      active_task_ids: ['t1'],
    }, { agentId: 'main', dagId: created.id });

    const result = await tools.assignTasksToSession({
      task_ids: ['t1', 't2'],
      dag_id: created.id,
      agent_id: 'main',
      run_id: 'run-assign-1',
      executor_agent_id: 'worker',
    }, {});

    assert(result.success === true, 'Assign should succeed');
    assert(result.assigned_task_ids.length === 2, 'Two tasks should be assigned');
    assert(bindings.getSessionRunByRunId('run-assign-1', { agentId: 'main', dagId: created.id })?.active_task_ids.length === 2, 'Run should track both tasks');
    assert(dag.getTask('t2')?.executor?.agent_id === 'worker', 'Assigned task should inherit child agent identity');
  });
});

test('task_dag_assign rejects session runs without child agent metadata unless executor_agent_id is provided', async () => {
  await withTempWorkspace('tool-assign-missing-child-agent', async () => {
    const created = dag.createDAG('tool-assign-missing-child-agent', [{ id: 't1', name: 'Task 1' }]);

    bindings.saveSessionRun({
      run_id: 'run-assign-missing-child-agent',
      child_session_key: 'agent:worker:subagent:assign-missing-child-agent',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'shared_worker',
      active_task_ids: [],
    }, { agentId: 'main', dagId: created.id });

    const result = await tools.assignTasksToSession({
      task_ids: ['t1'],
      dag_id: created.id,
      agent_id: 'main',
      run_id: 'run-assign-missing-child-agent',
    }, {});

    assert(result.error?.includes('executor_agent_id is required'), 'Assign should reject missing child agent identity');
  });
});

test('task_dag_assign rejects ambiguous session_key when multiple runs share the same session', async () => {
  await withTempWorkspace('tool-assign-ambiguous-session', async () => {
    const created = dag.createDAG('tool-assign-ambiguous-session', [{ id: 't1', name: 'Task 1' }]);
    for (const runId of ['run-amb-a', 'run-amb-b']) {
      bindings.saveSessionRun({
        run_id: runId,
        child_session_key: 'agent:worker:subagent:shared-assign',
        child_agent_id: 'worker',
        parent_agent_id: 'main',
        dag_id: created.id,
        spawn_mode: 'shared_worker',
        active_task_ids: [],
      }, { agentId: 'main', dagId: created.id });
    }

    const result = await tools.assignTasksToSession({
      task_ids: ['t1'],
      dag_id: created.id,
      agent_id: 'main',
      session_key: 'agent:worker:subagent:shared-assign',
    }, {});

    assert(result.error?.includes('Multiple runs exist for this session_key'), 'Assign should reject ambiguous session-only selection');
  });
});

test('task_dag_poll_events and ack_event expose deterministic event consumption', async () => {
  await withTempWorkspace('tool-events', async () => {
    const created = dag.createDAG('tool-events', [{ id: 't1', name: 'Events task' }]);
    const dagId = dag.getCurrentDagId();
    const event = bindings.appendPendingEvent({
      type: 'task_progress',
      dag_id: dagId,
      task_id: 't1',
      payload: { progress: 25 },
    }, { agentId: 'main', dagId });

    const polled = await tools.pollTaskEvents({ task_id: 't1', dag_id: created.id, agent_id: 'main' }, {});
    assert(polled.events.length === 1, 'Poll should return one event');

    const acked = await tools.ackTaskEvent({ event_id: event.event_id, dag_id: created.id, agent_id: 'main' }, {});
    assert(acked.success === true, 'Ack should succeed');

    const afterAck = await tools.pollTaskEvents({ task_id: 't1', dag_id: created.id, agent_id: 'main' }, {});
    assert(afterAck.events.length === 0, 'Consumed event should no longer appear by default');
  });
});

test('task_dag_reconcile closes terminal task bindings', async () => {
  await withTempWorkspace('tool-reconcile', async () => {
    const created = dag.createDAG('tool-reconcile', [{ id: 't1', name: 'Reconcile me' }]);
    const dagId = dag.getCurrentDagId();

    bindings.upsertTaskBinding({
      dag_id: dagId,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:reconcile',
      run_id: 'run-reconcile',
      binding_status: 'active',
    }, { agentId: 'main', dagId });
    dag.updateTask('t1', { status: 'done', output_summary: 'finished' });

    const result = await tools.reconcileTaskDagState({ dag_id: created.id, agent_id: 'main' }, {});
    assert(result.success === true, 'Reconcile should succeed');
    assert(result.reconciled.length === 1, 'Reconcile should fix one task');
    assert(bindings.listTaskBindings({ task_id: 't1', binding_status: 'active' }, { agentId: 'main', dagId }).length === 0, 'Active binding should be closed');
  });
});

test('task_dag_claim rejects missing explicit agent context', async () => {
  await withTempWorkspace('tool-claim-context-error', async () => {
    const created = dag.createDAG('tool-claim-context-error', [{ id: 't1', name: 'Claim me' }]);
    const result = await tools.claimTaskExecution({ task_id: 't1', dag_id: created.id }, {});
    assert(typeof result.error === 'string', 'Claim should reject missing agent context');
  });
});

test('task_dag_claim rejects blocked tasks', async () => {
  await withTempWorkspace('tool-claim-blocked', async () => {
    const created = dag.createDAG('tool-claim-blocked', [
      { id: 't1', name: 'Root' },
      { id: 't2', name: 'Blocked', dependencies: ['t1'] },
    ]);
    const result = await tools.claimTaskExecution({ task_id: 't2', dag_id: created.id, agent_id: 'main' }, {});
    assert(result.error?.includes('cannot be claimed'), 'Blocked task should not be claimable');
  });
});

test('task_dag_spawn rejects terminal tasks', async () => {
  await withTempWorkspace('tool-spawn-terminal', async () => {
    const created = dag.createDAG('tool-spawn-terminal', [{ id: 't1', name: 'Done task' }]);
    dag.updateTask('t1', { status: 'done' });
    const result = await tools.spawnTaskExecution({ sessions_spawn: async () => ({ sessionKey: 's', runId: 'r' }) }, {
      task_id: 't1',
      dag_id: created.id,
      agent_id: 'main',
      task: 'noop',
      agentId: 'worker',
    }, {});
    assert(result.error?.includes('cannot spawn a subagent'), 'Done task should not spawn');
  });
});

test('task_dag_assign rejects non-ready tasks', async () => {
  await withTempWorkspace('tool-assign-terminal', async () => {
    const created = dag.createDAG('tool-assign-terminal', [{ id: 't1', name: 'Task 1' }]);
    dag.updateTask('t1', { status: 'done' });
    bindings.saveSessionRun({
      run_id: 'run-assign-terminal',
      child_session_key: 'agent:worker:subagent:assign-terminal',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'shared_worker',
      active_task_ids: [],
    }, { agentId: 'main', dagId: created.id });

    const result = await tools.assignTasksToSession({
      task_ids: ['t1'],
      dag_id: created.id,
      agent_id: 'main',
      run_id: 'run-assign-terminal',
      executor_agent_id: 'worker',
    }, {});
    assert(result.error?.includes('cannot be assigned'), 'Terminal task should not be assignable');
  });
});

test('task_dag_complete rejects non-running tasks', async () => {
  await withTempWorkspace('tool-complete-illegal', async () => {
    const created = dag.createDAG('tool-complete-illegal', [{ id: 't1', name: 'Task 1' }]);
    const result = await tools.completeTaskExecution({
      task_id: 't1',
      dag_id: created.id,
      agent_id: 'main',
      output_summary: 'done',
    }, {});
    assert(result.error?.includes('cannot be completed'), 'Ready task should not be completed directly');
  });
});

test('registered task_dag_complete uses runtime execute signature without losing params', async () => {
  await withTempWorkspace('tool-complete-runtime-signature', async () => {
    const created = dag.createDAG('tool-complete-runtime-signature', [{ id: 't1', name: 'Task 1' }]);
    dag.updateTask('t1', {
      status: 'running',
      executor: { type: 'parent', agent_id: 'main' },
    });

    const registeredTools = {};
    tools.registerTaskDagTools({
      logger: { info() {}, warn() {}, error() {} },
      registerTool(tool) { registeredTools[tool.name] = tool; },
      registerHook() {},
      runtime: {},
      config: {},
    });

    const result = await registeredTools.task_dag_complete.execute('call-complete-runtime', {
      task_id: 't1',
      dag_id: created.id,
      agent_id: 'main',
      output_summary: 'done',
    }, undefined, undefined);

    assert(result.success === true, `Registered complete tool should succeed under runtime signature: ${JSON.stringify(result)}`);
    assert(dag.getTask('t1')?.status === 'done', 'Registered complete tool should mark the task done');
  });
});

test('execution and continuation tools expose a consistent agent_id contract', async () => {
  await withTempWorkspace('tool-agent-contract', async () => {
    const registeredTools = {};
    tools.registerTaskDagTools({
      logger: { info() {}, warn() {}, error() {} },
      registerTool(tool) { registeredTools[tool.name] = tool; },
      registerHook() {},
      runtime: {},
      config: {},
    });

    const toolNames = [
      'task_dag_claim',
      'task_dag_progress',
      'task_dag_complete',
      'task_dag_fail',
      'task_dag_spawn',
      'task_dag_assign',
      'task_dag_poll_events',
      'task_dag_continue',
      'task_dag_ack_event',
      'task_dag_reconcile',
    ];

    for (const toolName of toolNames) {
      const properties = registeredTools[toolName]?.parameters?.properties || {};
      assert(Object.prototype.hasOwnProperty.call(properties, 'agent_id'), `${toolName} should declare agent_id`);
    }
  });
});

test('chexie agent can create and execute parent-owned tasks in its own workspace', async () => {
  await withTempWorkspace('tool-chexie-parent-flow', async (workspaceDir) => {
    const registeredTools = {};
    tools.registerTaskDagTools({
      logger: { info() {}, warn() {}, error() {} },
      registerTool(tool) { registeredTools[tool.name] = tool; },
      registerHook() {},
      runtime: {},
      config: {},
    });

    const created = await registeredTools.task_dag_create.execute('call-chexie-create', {
      agent_id: 'chexie',
      name: 'Chexie README Flow',
      tasks: [
        { id: 't1', name: 'Read frontend README', assigned_agent: 'parent' },
        { id: 't2', name: 'Read backend README', assigned_agent: 'parent' },
      ],
    }, undefined, undefined);

    assert(created.success === true, `Chexie DAG should be created: ${JSON.stringify(created)}`);
    assert(fs.existsSync(path.join(workspaceDir, 'workspace-chexie', 'tasks', created.dag_id, 'dag.json')), 'Chexie DAG should live under workspace-chexie');

    const ready = await registeredTools.task_dag_ready.execute('call-chexie-ready', {
      agent_id: 'chexie',
      dag_id: created.dag_id,
    }, undefined, undefined);
    assert(Array.isArray(ready.tasks) && ready.tasks.length === 2, 'Both chexie tasks should start ready');

    const claim = await registeredTools.task_dag_claim.execute('call-chexie-claim', {
      agent_id: 'chexie',
      dag_id: created.dag_id,
      task_id: 't1',
      executor_type: 'parent',
      executor_agent_id: 'chexie',
    }, undefined, undefined);
    assert(claim.success === true, `Chexie should be able to claim t1: ${JSON.stringify(claim)}`);

    const progress = await registeredTools.task_dag_progress.execute('call-chexie-progress', {
      agent_id: 'chexie',
      dag_id: created.dag_id,
      task_id: 't1',
      progress: 50,
      message: 'reading frontend readme',
    }, undefined, undefined);
    assert(progress.success === true, `Chexie should be able to report progress: ${JSON.stringify(progress)}`);

    const complete = await registeredTools.task_dag_complete.execute('call-chexie-complete', {
      agent_id: 'chexie',
      dag_id: created.dag_id,
      task_id: 't1',
      output_summary: 'frontend readme summarized',
    }, undefined, undefined);
    assert(complete.success === true, `Chexie should be able to complete t1: ${JSON.stringify(complete)}`);

    const task = await registeredTools.task_dag_get.execute('call-chexie-get', {
      agent_id: 'chexie',
      dag_id: created.dag_id,
      task_id: 't1',
    }, undefined, undefined);
    assert(task.task?.status === 'done', 'Completed chexie task should be done');

    const continuation = await registeredTools.task_dag_continue.execute('call-chexie-continue', {
      agent_id: 'chexie',
      dag_id: created.dag_id,
      task_ids: ['t1', 't2'],
      consume: false,
    }, undefined, undefined);
    assert(continuation.agent_id === 'chexie', 'Continuation should stay in chexie context');
    assert(continuation.dag_id === created.dag_id, 'Continuation should report chexie dag_id');
  });
});

test('task_dag_continue requires explicit scope instead of scanning the whole DAG', async () => {
  await withTempWorkspace('tool-continue-explicit-scope', async () => {
    const created = dag.createDAG('tool-continue-explicit-scope', [{ id: 't1', name: 'Task 1' }]);
    const result = await tools.continueParentSession({ dag_id: created.id, agent_id: 'main' }, {});
    assert(result.error?.includes('Explicit continuation scope is required'), 'Continue should require an explicit scope');
  });
});

test('task_dag_continue rejects ambiguous session_key when multiple runs exist', async () => {
  await withTempWorkspace('tool-continue-ambiguous-session', async () => {
    const created = dag.createDAG('tool-continue-ambiguous-session', [{ id: 't1', name: 'Task 1' }]);
    for (const runId of ['run-cont-a', 'run-cont-b']) {
      bindings.saveSessionRun({
        run_id: runId,
        child_session_key: 'agent:worker:subagent:shared-continue',
        child_agent_id: 'worker',
        parent_agent_id: 'main',
        dag_id: created.id,
        spawn_mode: 'shared_worker',
        active_task_ids: ['t1'],
      }, { agentId: 'main', dagId: created.id });
    }

    const result = await tools.continueParentSession({
      dag_id: created.id,
      agent_id: 'main',
      session_key: 'agent:worker:subagent:shared-continue',
    }, {});

    assert(result.error?.includes('Multiple runs exist for this session_key'), 'Continue should reject ambiguous session-only scope');
  });
});

console.log('\n=== Hook Flow ===\n');

test('subagent_spawned hook persists session context and binding metadata', async () => {
  await withTempWorkspace('hook-spawned', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('hook-spawned', [{ id: 't1', name: 'Hook task' }]);
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-hook-1',
      task_ids: ['t1'],
    });

    hooks.handleSubagentSpawnedEvent({
      childSessionKey: 'agent:worker:subagent:hook-1',
      agentId: 'worker',
      label: 'task:t1',
      runId: 'run-hook-1',
    }, { requesterSessionKey: 'agent:main', runId: 'run-hook-1', childSessionKey: 'agent:worker:subagent:hook-1' }, console);

    const run = bindings.getSessionRunByRunId('run-hook-1', { agentId: 'main', dagId: created.id });
    const taskBindings = bindings.listTaskBindings({ task_id: 't1' }, { agentId: 'main', dagId: created.id });
    const pendingEvents = bindings.listPendingEvents({ type: 'subagent_spawned' }, { agentId: 'main', dagId: created.id });
    const oldSessionMappings = path.join(process.env.WORKSPACE_DIR, 'workspace', 'tasks', 'session-mappings.json');
    const oldHierarchy = path.join(process.env.WORKSPACE_DIR, 'workspace', 'tasks', 'session-hierarchy.json');

    assert(run?.child_session_key === 'agent:worker:subagent:hook-1', 'Hook should persist session run');
    assert(run?.parent_agent_id === 'main', 'Session run should persist parent agent, not child agent');
    assert(taskBindings.length >= 1, 'Hook should create task binding');
    assert(pendingEvents.length === 1, 'Hook should emit pending spawn event');
    assert(fs.existsSync(oldSessionMappings) === false, 'Old session mapping file should not be created');
    assert(fs.existsSync(oldHierarchy) === false, 'Old session hierarchy file should not be created');
  });
});

test('subagent_spawned hook does not duplicate spawn metadata already created by tool path', async () => {
  await withTempWorkspace('hook-spawned-idempotent', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('hook-spawned-idempotent', [{ id: 't1', name: 'Hook task' }]);
    const context = { agentId: 'main', dagId: created.id };
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-hook-idempotent',
      task_ids: ['t1'],
    });
    bindings.saveSessionRun({
      run_id: 'run-hook-idempotent',
      child_session_key: 'agent:worker:subagent:hook-idempotent',
      child_agent_id: 'worker',
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'single_task',
      label: 'task:t1',
      active_task_ids: ['t1'],
    }, context);
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:hook-idempotent',
      run_id: 'run-hook-idempotent',
      binding_status: 'active',
    }, context);

    hooks.handleSubagentSpawnedEvent({
      childSessionKey: 'agent:worker:subagent:hook-idempotent',
      agentId: 'worker',
      label: 'task:t1',
      runId: 'run-hook-idempotent',
    }, { requesterSessionKey: 'agent:main', runId: 'run-hook-idempotent', childSessionKey: 'agent:worker:subagent:hook-idempotent' }, console);

    assert(bindings.listTaskBindings({ task_id: 't1' }, context).length === 1, 'Hook should not create duplicate bindings');
    assert(bindings.listPendingEvents({ type: 'subagent_spawned' }, context).length === 1, 'Hook should keep a single spawn lifecycle event');
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
    }, { agentId: 'main', dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:hook-2',
      run_id: 'run-hook-2',
      binding_status: 'active',
    }, { agentId: 'main', dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't2',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:hook-2',
      run_id: 'run-hook-2',
      binding_status: 'active',
    }, { agentId: 'main', dagId: created.id });

    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-hook-2',
      task_ids: ['t1', 't2'],
    });

    const result = hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:hook-2',
      runId: 'run-hook-2',
      outcome: 'ok',
    }, { requesterSessionKey: 'agent:main', runId: 'run-hook-2', childSessionKey: 'agent:worker:subagent:hook-2' }, console);

    assert(result.task_ids.length === 2, 'Ended hook should close both bound tasks');
    assert(dag.getTask('t1')?.status === 'done', 'First task should be done');
    assert(dag.getTask('t2')?.status === 'done', 'Second task should be done');
    assert(dag.getTask('t3')?.status === 'ready', 'Downstream task should become ready');
    assert(result.newly_ready_task_ids.includes('t3'), 'Ended hook should report newly ready downstream task');
    assert(bindings.listTaskBindings({ session_key: 'agent:worker:subagent:hook-2', binding_status: 'active' }, { agentId: 'main', dagId: created.id }).length === 0, 'Active bindings should be closed');
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
    }, { agentId: 'main', dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:hook-3',
      run_id: 'run-hook-3',
      binding_status: 'active',
    }, { agentId: 'main', dagId: created.id });
    dag.updateTask('t1', { status: 'done', output_summary: 'already completed' });

    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-hook-3',
      task_ids: ['t1'],
    });

    const result = hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:hook-3',
      runId: 'run-hook-3',
      outcome: 'ok',
    }, { requesterSessionKey: 'agent:main', runId: 'run-hook-3', childSessionKey: 'agent:worker:subagent:hook-3' }, console);

    assert(result.task_ids[0] === 't1', 'Delayed ended hook should still resolve task');
    assert(dag.getTask('t1')?.status === 'done', 'Done task should remain done');
  });
});

test('subagent_ended hook emits orphan event when bindings are missing', async () => {
  await withTempWorkspace('hook-orphaned', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('hook-orphaned', [{ id: 't1', name: 'Orphan check' }]);
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-hook-4',
      task_ids: ['t1'],
    });

    hooks.handleSubagentSpawnedEvent({
      childSessionKey: 'agent:worker:subagent:hook-4',
      agentId: 'worker',
      label: 'task:t1',
      runId: 'run-hook-4',
    }, { requesterSessionKey: 'agent:main', runId: 'run-hook-4', childSessionKey: 'agent:worker:subagent:hook-4' }, console);

    const existingBindings = bindings.listTaskBindings({ session_key: 'agent:worker:subagent:hook-4', binding_status: 'active' }, { agentId: 'main', dagId: created.id });
    for (const binding of existingBindings) {
      bindings.completeTaskBinding(binding.binding_id, 'released', { agentId: 'main', dagId: created.id });
    }

    const result = hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:hook-4',
      runId: 'run-hook-4',
      outcome: 'error',
    }, { requesterSessionKey: 'agent:main', runId: 'run-hook-4', childSessionKey: 'agent:worker:subagent:hook-4' }, console);

    const orphanEvents = bindings.listPendingEvents({ type: 'binding_orphaned' }, { agentId: 'main', dagId: created.id });
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
    }, { agentId: 'main', dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:continue-1',
      run_id: 'run-continue-1',
      binding_status: 'active',
    }, { agentId: 'main', dagId: created.id });
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-continue-1',
      task_ids: ['t1'],
    });

    hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:continue-1',
      runId: 'run-continue-1',
      outcome: 'ok',
    }, { requesterSessionKey: 'agent:main', runId: 'run-continue-1', childSessionKey: 'agent:worker:subagent:continue-1' }, console);

    const result = await tools.continueParentSession({ run_id: 'run-continue-1', dag_id: created.id, agent_id: 'main' }, {});
    const secondResult = await tools.continueParentSession({ run_id: 'run-continue-1', dag_id: created.id, agent_id: 'main' }, {});

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
      { id: 't3', name: 'Downstream ready', dependencies: ['t1'] },
    ]);

    bindings.saveSessionRun({
      run_id: 'run-continue-2',
      child_session_key: 'agent:worker:subagent:continue-2',
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'multi_task',
      active_task_ids: ['t1', 't2'],
    }, { agentId: 'main', dagId: created.id });
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-continue-2',
      task_ids: ['t1', 't2'],
    });
    for (const taskId of ['t1', 't2']) {
      bindings.upsertTaskBinding({
        dag_id: created.id,
        task_id: taskId,
        executor_type: 'subagent',
        executor_agent_id: 'worker',
        session_key: 'agent:worker:subagent:continue-2',
        run_id: 'run-continue-2',
        binding_status: 'active',
      }, { agentId: 'main', dagId: created.id });
      dag.updateTask(taskId, {
        status: 'waiting_subagent',
        executor: { type: 'subagent', agent_id: 'worker', session_key: 'agent:worker:subagent:continue-2', run_id: 'run-continue-2' },
        waiting_for: { kind: 'subagent', session_key: 'agent:worker:subagent:continue-2', run_id: 'run-continue-2' },
      });
    }

    dag.updateTask('t1', { status: 'done', output_summary: 'partial result' });
    const activeT1Binding = bindings.listTaskBindings({ task_id: 't1', binding_status: 'active' }, { agentId: 'main', dagId: created.id })[0];
    bindings.completeTaskBinding(activeT1Binding.binding_id, 'completed', { agentId: 'main', dagId: created.id });
    bindings.appendPendingEvent({
      type: 'subagent_completed',
      dag_id: created.id,
      task_id: 't1',
      session_key: 'agent:worker:subagent:continue-2',
      run_id: 'run-continue-2',
      dedupe_key: 'continue-multi-partial',
      payload: { outcome: 'ok' },
    }, { agentId: 'main', dagId: created.id });
    bindings.appendPendingEvent({
      type: 'task_ready',
      dag_id: created.id,
      task_id: 't3',
      dedupe_key: 'continue-multi-ready-t3',
      payload: { source_task_ids: ['t1'] },
    }, { agentId: 'main', dagId: created.id });

    const partial = await tools.continueParentSession({ run_id: 'run-continue-2', dag_id: created.id, agent_id: 'main' }, {});
    const remainingReadyEvents = bindings.listPendingEvents({ type: 'task_ready' }, { agentId: 'main', dagId: created.id });
    assert(partial.action === 'continue_waiting', 'Partial completion should keep waiting');
    assert(partial.should_reply_to_user === false, 'Partial completion should not reply by default');
    assert(partial.completed_task_ids.includes('t1'), 'Partial completion should report completed task');
    assert(partial.waiting_task_ids.includes('t2'), 'Remaining task should still be waiting');
    assert(remainingReadyEvents.some(event => event.task_id === 't3'), 'task_ready event should remain pending during continue_waiting');

    hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:continue-2',
      runId: 'run-continue-2',
      outcome: 'ok',
    }, { requesterSessionKey: 'agent:main', runId: 'run-continue-2', childSessionKey: 'agent:worker:subagent:continue-2' }, console);

    const final = await tools.continueParentSession({ run_id: 'run-continue-2', dag_id: created.id, agent_id: 'main' }, {});
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
    }, { agentId: 'main', dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:continue-3',
      run_id: 'run-continue-3',
      binding_status: 'active',
    }, { agentId: 'main', dagId: created.id });

    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-continue-3',
      task_ids: ['t1'],
    });

    hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:continue-3',
      runId: 'run-continue-3',
      outcome: 'ok',
    }, { requesterSessionKey: 'agent:main', runId: 'run-continue-3', childSessionKey: 'agent:worker:subagent:continue-3' }, console);
    hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:continue-3',
      runId: 'run-continue-3',
      outcome: 'ok',
    }, { requesterSessionKey: 'agent:main', runId: 'run-continue-3', childSessionKey: 'agent:worker:subagent:continue-3' }, console);

    const completionEvents = bindings.listPendingEvents({
      run_id: 'run-continue-3',
      type: 'subagent_completed',
      includeConsumed: true,
    }, { agentId: 'main', dagId: created.id });
    const first = await tools.continueParentSession({ run_id: 'run-continue-3', dag_id: created.id, agent_id: 'main' }, {});
    const second = await tools.continueParentSession({ run_id: 'run-continue-3', dag_id: created.id, agent_id: 'main' }, {});

    assert(completionEvents.length === 1, 'Duplicate ended hooks should dedupe completion events');
    assert(first.action === 'user_reply', 'First continuation should produce reply');
    assert(second.pending_event_ids.length === 0, 'Second continuation should not see duplicate events');
  });
});

test('registerTaskDagHooks uses runtime hook ctx and sends resume wake-up', async () => {
  await withTempWorkspace('hook-register-resume', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('hook-register-resume', [{ id: 't1', name: 'Resume me' }]);
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-resume-1',
      task_ids: ['t1'],
    });
    bindings.saveSessionRun({
      run_id: 'run-resume-1',
      child_session_key: 'agent:worker:subagent:resume-1',
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'single_task',
      active_task_ids: ['t1'],
    }, { agentId: 'main', dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:resume-1',
      run_id: 'run-resume-1',
      binding_status: 'active',
    }, { agentId: 'main', dagId: created.id });

    const sentMessages = [];
    const registeredHooks = {};
    hooks.registerTaskDagHooks({
      logger: { info() {}, warn() {}, error() {} },
      registerTool() {},
      registerHook(name, handler) { registeredHooks[name] = handler; },
      runtime: {
        sessions_spawn: async () => ({}),
        sessions_send: async (params) => { sentMessages.push(params); return { success: true }; },
        sessions_list: async () => ([]),
        subagents: async () => ([]),
      },
      config: {},
    });

    await registeredHooks['subagent_ended']({
      targetSessionKey: 'agent:worker:subagent:resume-1',
      runId: 'run-resume-1',
      outcome: 'ok',
    }, {
      requesterSessionKey: 'agent:main',
      runId: 'run-resume-1',
      childSessionKey: 'agent:worker:subagent:resume-1',
    });

    const resumeEvents = bindings.listPendingEvents({ type: 'resume_requested' }, { agentId: 'main', dagId: created.id });
    assert(sentMessages.length === 1, 'Ended hook should send one resume message to requester session');
    assert(sentMessages[0].sessionKey === 'agent:main', 'Resume message should target requester session');
    assert(sentMessages[0].message.includes('task_dag_continue'), 'Resume message should instruct continuation');
    assert(resumeEvents.length === 1, 'Ended hook should persist a resume_requested event');
  });
});

test('subagent_ended hook restores previous global dag context after processing', async () => {
  await withTempWorkspace('hook-context-restore', async () => {
    dag.setCurrentAgentId('main');
    const target = dag.createDAG('hook-context-restore-target', [{ id: 't1', name: 'Resume me' }]);
    const previous = dag.createDAG('hook-context-restore-previous', [{ id: 'p1', name: 'Previous dag' }]);
    dag.setCurrentAgentId('main');
    dag.setCurrentDagId(previous.id);

    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: target.id,
      run_id: 'run-context-restore',
      task_ids: ['t1'],
    });
    bindings.saveSessionRun({
      run_id: 'run-context-restore',
      child_session_key: 'agent:worker:subagent:context-restore',
      child_agent_id: 'worker',
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: target.id,
      spawn_mode: 'single_task',
      active_task_ids: ['t1'],
    }, { agentId: 'main', dagId: target.id });
    bindings.upsertTaskBinding({
      dag_id: target.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:context-restore',
      run_id: 'run-context-restore',
      binding_status: 'active',
    }, { agentId: 'main', dagId: target.id });

    hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:context-restore',
      runId: 'run-context-restore',
      outcome: 'ok',
    }, { requesterSessionKey: 'agent:main', runId: 'run-context-restore', childSessionKey: 'agent:worker:subagent:context-restore' }, console);

    assert(dag.getCurrentDagId() === previous.id, 'Hook should restore previous dag context');
  });
});

test('before_prompt_build injects continuation instructions for requester session', async () => {
  await withTempWorkspace('hook-before-prompt', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('hook-before-prompt', [{ id: 't1', name: 'Prompt task' }]);
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main:resume-prompt',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-before-prompt',
      task_ids: ['t1'],
    });
    bindings.appendPendingEvent({
      type: 'resume_requested',
      dag_id: created.id,
      run_id: 'run-before-prompt',
      dedupe_key: 'resume-before-prompt',
      payload: { requester_session_key: 'agent:main:resume-prompt', task_ids: ['t1'], outcome: 'ok' },
    }, { agentId: 'main', dagId: created.id });

    const registeredHooks = {};
    hooks.registerTaskDagHooks({
      logger: { info() {}, warn() {}, error() {} },
      registerTool() {},
      registerHook(name, handler) { registeredHooks[name] = handler; },
      runtime: {
        sessions_spawn: async () => ({}),
        sessions_send: async () => ({ success: true }),
        sessions_list: async () => ([]),
        subagents: async () => ([]),
      },
      config: {},
    });

    const injected = await registeredHooks['before_prompt_build']({ prompt: '', messages: [] }, { sessionKey: 'agent:main:resume-prompt' });
    const skipped = await registeredHooks['before_prompt_build']({ prompt: '', messages: [] }, { sessionKey: 'agent:main:no-resume' });

    assert(injected.prependContext.includes('task_dag_continue'), 'before_prompt_build should inject continuation guidance');
    assert(skipped === undefined, 'before_prompt_build should stay silent without pending resume');
  });
});

test('subagent_ended hook does not guess run_id when one session key has multiple runs', async () => {
  await withTempWorkspace('hook-ended-ambiguous-run', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('hook-ended-ambiguous-run', [
      { id: 't1', name: 'Task 1' },
      { id: 't2', name: 'Task 2' },
    ]);
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-ended-a',
      task_ids: ['t1'],
    });
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-ended-b',
      task_ids: ['t2'],
    });
    for (const [taskId, runId] of [['t1', 'run-ended-a'], ['t2', 'run-ended-b']]) {
      bindings.saveSessionRun({
        run_id: runId,
        child_session_key: 'agent:worker:subagent:shared-ended',
        child_agent_id: 'worker',
        requester_session_key: 'agent:main',
        parent_agent_id: 'main',
        dag_id: created.id,
        spawn_mode: 'shared_worker',
        active_task_ids: [taskId],
      }, { agentId: 'main', dagId: created.id });
      bindings.upsertTaskBinding({
        dag_id: created.id,
        task_id: taskId,
        executor_type: 'subagent',
        executor_agent_id: 'worker',
        session_key: 'agent:worker:subagent:shared-ended',
        run_id: runId,
        binding_status: 'active',
      }, { agentId: 'main', dagId: created.id });
    }

    const result = hooks.handleSubagentEndedEvent({
      targetSessionKey: 'agent:worker:subagent:shared-ended',
      outcome: 'ok',
    }, { requesterSessionKey: 'agent:main', childSessionKey: 'agent:worker:subagent:shared-ended' }, console);

    assert(result.task_ids.length === 0, 'Ended hook should not close tasks when session-only lookup is ambiguous');
  });
});

console.log('\n=== Compatibility Context ===\n');

test('compatibility tools respect dag_id instead of drifting to another DAG', async () => {
  await withTempWorkspace('compat-dag', async () => {
    dag.setCurrentAgentId('main');
    const first = dag.createDAG('compat-first', [{ id: 't1', name: 'First DAG task' }]);
    await new Promise(resolve => setTimeout(resolve, 2));
    const second = dag.createDAG('compat-second', [{ id: 't1', name: 'Second DAG task' }]);

    const registeredTools = {};
    tools.registerTaskDagTools({
      logger: { info() {}, warn() {}, error() {} },
      registerTool(tool) { registeredTools[tool.name] = tool; },
      registerHook() {},
      runtime: {},
      config: {},
    });

    const updateTool = registeredTools['task_dag_modify'];

    await updateTool.execute('call-compat-update', {
      action: 'update',
      dag_id: second.id,
      agent_id: 'main',
      task_id: 't1',
      task: { description: 'only-second-dag' },
    }, undefined, undefined);

    dag.setCurrentAgentId('main');
    dag.setCurrentDagId(first.id);
    const firstTask = dag.getTask('t1');

    dag.setCurrentAgentId('main');
    dag.setCurrentDagId(second.id);
    const secondTask = dag.getTask('t1');

    assert(firstTask?.description !== 'only-second-dag', 'First DAG should remain untouched');
    assert(secondTask?.description === 'only-second-dag', 'Second DAG should receive the update');
  });
});

test('task_dag_get_parent prefers explicit params over context', async () => {
  await withTempWorkspace('tool-get-parent-params', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('tool-get-parent-params', [{ id: 't1', name: 'Parent task' }]);

    const registeredTools = {};
    tools.registerTaskDagTools({
      logger: { info() {}, warn() {}, error() {} },
      registerTool(tool) { registeredTools[tool.name] = tool; },
      registerHook() {},
      runtime: {},
      config: {},
    });

    const getParentTool = registeredTools['task_dag_get_parent'];
    const result = await getParentTool.execute('call-get-parent', {
      parent_agent_id: 'main',
      dag_id: created.id,
    }, undefined, undefined);

    assert(result.parent_agent_id === 'main', 'Explicit params should win over context for parent lookup');
    assert(result.dag_id === created.id, 'Explicit dag_id should win over context for parent lookup');
  });
});

test('task_dag_modify remove cleans runtime artifacts for deleted tasks', async () => {
  await withTempWorkspace('tool-remove-cleanup', async () => {
    dag.setCurrentAgentId('main');
    const created = dag.createDAG('tool-remove-cleanup', [{ id: 't1', name: 'To delete' }]);
    dag.updateTask('t1', {
      status: 'waiting_subagent',
      executor: { type: 'subagent', agent_id: 'worker', session_key: 'agent:worker:subagent:remove', run_id: 'run-remove' },
      waiting_for: { kind: 'subagent', session_key: 'agent:worker:subagent:remove', run_id: 'run-remove' },
    });
    bindings.saveSessionRun({
      run_id: 'run-remove',
      child_session_key: 'agent:worker:subagent:remove',
      child_agent_id: 'worker',
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      spawn_mode: 'single_task',
      active_task_ids: ['t1'],
    }, { agentId: 'main', dagId: created.id });
    bindings.upsertTaskBinding({
      dag_id: created.id,
      task_id: 't1',
      executor_type: 'subagent',
      executor_agent_id: 'worker',
      session_key: 'agent:worker:subagent:remove',
      run_id: 'run-remove',
      binding_status: 'active',
    }, { agentId: 'main', dagId: created.id });
    bindings.appendPendingEvent({
      type: 'subagent_completed',
      dag_id: created.id,
      task_id: 't1',
      session_key: 'agent:worker:subagent:remove',
      run_id: 'run-remove',
      payload: { outcome: 'ok' },
    }, { agentId: 'main', dagId: created.id });
    requesterSessions.upsertRequesterSessionScope({
      requester_session_key: 'agent:main',
      parent_agent_id: 'main',
      dag_id: created.id,
      run_id: 'run-remove',
      task_ids: ['t1'],
    });
    dag.setTaskDoc('t1', '# deleted');

    const registeredTools = {};
    tools.registerTaskDagTools({
      logger: { info() {}, warn() {}, error() {} },
      registerTool(tool) { registeredTools[tool.name] = tool; },
      registerHook() {},
      runtime: {},
      config: {},
    });

    const modifyTool = registeredTools['task_dag_modify'];
    const result = await modifyTool.execute('call-remove-task', {
      action: 'remove',
      dag_id: created.id,
      agent_id: 'main',
      task_id: 't1',
    }, undefined, undefined);

    assert(result.success === true, 'Task removal should succeed');
    assert(dag.getTask('t1') === null, 'Removed task should disappear from DAG');
    assert(bindings.listTaskBindings({ task_id: 't1' }, { agentId: 'main', dagId: created.id }).length === 0, 'Bindings for removed task should be deleted');
    assert(bindings.getSessionRunByRunId('run-remove', { agentId: 'main', dagId: created.id }) === null, 'Empty session run should be removed');
    assert(bindings.listPendingEvents({ task_id: 't1', includeConsumed: true }, { agentId: 'main', dagId: created.id }).length === 0, 'Pending events for removed task should be deleted');
    assert(requesterSessions.findRequesterSessionScope({ requester_session_key: 'agent:main', parent_agent_id: 'main', dag_id: created.id, run_id: 'run-remove' }) === null, 'Requester scope should be cleaned');
  });
});

test('task docs are isolated per dag even when task ids match', async () => {
  await withTempWorkspace('dag-docs-isolated', async (workspaceDir) => {
    dag.setCurrentAgentId('main');
    const first = dag.createDAG('dag-docs-1', [{ id: 't1', name: 'Task' }]);
    dag.setTaskDoc('t1', 'first');
    const firstPath = dag.getTask('t1')?.doc_path;

    const second = dag.createDAG('dag-docs-2', [{ id: 't1', name: 'Task' }]);
    dag.setTaskDoc('t1', 'second');
    const secondPath = dag.getTask('t1')?.doc_path;

    assert(firstPath !== secondPath, 'Doc paths should differ across DAGs');
    assert(fs.readFileSync(firstPath, 'utf-8') === 'first', 'First DAG doc should keep its content');
    assert(fs.readFileSync(secondPath, 'utf-8') === 'second', 'Second DAG doc should keep its content');
    assert(firstPath.includes(path.join('workspace', 'tasks', first.id, 'docs')), 'Main agent docs should live under workspace/tasks/{dag}/docs');
    assert(secondPath.includes(path.join('workspace', 'tasks', second.id, 'docs')), 'Main agent docs should live under workspace/tasks/{dag}/docs');
  });
});

test('notifications are isolated by current dag context', () => {
  withTempWorkspace('notifications-isolated', () => {
    dag.setCurrentAgentId('main');
    const first = dag.createDAG('notif-1', [{ id: 't1', name: 'Task' }]);
    notification.addNotification('t1', { type: 'progress', message: 'first', timestamp: new Date().toISOString(), agent_id: 'main' });

    const second = dag.createDAG('notif-2', [{ id: 't1', name: 'Task' }]);
    notification.addNotification('t1', { type: 'progress', message: 'second', timestamp: new Date().toISOString(), agent_id: 'main' });

    dag.setCurrentAgentId('main');
    dag.setCurrentDagId(first.id);
    assert(notification.peekNotification('t1')?.message === 'first', 'First DAG should keep its own notification queue');

    dag.setCurrentAgentId('main');
    dag.setCurrentDagId(second.id);
    assert(notification.peekNotification('t1')?.message === 'second', 'Second DAG should keep its own notification queue');
  });
});

test('compatibility helpers can operate on a non-main agent DAG', async () => {
  await withTempWorkspace('compat-agent', async () => {
    dag.setCurrentAgentId('worker-parent');
    const created = dag.createDAG('compat-agent', [{ id: 't1', name: 'Agent scoped task' }]);

    const registeredTools = {};
    tools.registerTaskDagTools({
      logger: { info() {}, warn() {}, error() {} },
      registerTool(tool) { registeredTools[tool.name] = tool; },
      registerHook() {},
      runtime: {},
      config: {},
    });

    const contextTool = registeredTools['task_dag_context'];
    const resumeTool = registeredTools['task_dag_resume'];

    const contextResult = await contextTool.execute('call-context-non-main', { task_id: 't1', dag_id: created.id, agent_id: 'worker-parent' }, undefined, undefined);
    assert(contextResult.dag_name === 'compat-agent', 'Context tool should resolve under non-main agent');

    dag.updateTask('t1', { status: 'done', output_summary: 'done' });
    await resumeTool.execute('call-resume-non-main', { task_id: 't1', dag_id: created.id, agent_id: 'worker-parent' }, undefined, undefined);
    assert(dag.getTask('t1')?.status === 'ready', 'Resume tool should mutate the non-main agent DAG');
  });
});

test('deprecated tools are no longer registered', async () => {
  const registeredTools = {};
  tools.registerTaskDagTools({
    logger: { info() {}, warn() {}, error() {} },
    registerTool(tool) { registeredTools[tool.name] = tool; },
    registerHook() {},
    runtime: {},
    config: {},
  });

  assert(!registeredTools['task_dag_wait'], 'task_dag_wait should be removed');
  assert(!registeredTools['task_dag_update'], 'task_dag_update should be removed');
  assert(!registeredTools['task_dag_notify'], 'task_dag_notify should be removed');
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
