/**
 * Task DAG 工具注册
 * 
 * 将所有 DAG 功能封装为 OpenClaw Agent Tools
 */

import type { OpenClawPluginApi } from "./plugin-sdk.js";
import * as dag from './dag.js';
import { getParentAgentId, getParentSessionKey } from './agent.js';
import {
  appendPendingEvent,
  attachTaskToSessionRun,
  consumePendingEvent,
  completeSessionRun,
  completeTaskBinding,
  getSessionRunByRunId,
  getSessionRunBySessionKey,
  listPendingEvents,
  listTaskBindings,
  saveSessionRun,
  upsertTaskBinding,
} from './bindings.js';
import * as waiter from './waiter.js';
import * as notificationModule from './notification.js';
import type { PendingEvent } from './bindings.js';

type RuntimeFacade = {
  sessions_spawn?: (params: any) => Promise<any>;
};

/**
 * 从上下文和参数获取 agent ID
 * 优先级：
 * 1. 显式的 parent_agent_id 参数 (子 agent 继承父 agent)
 * 2. 显式的 agent_id 参数 (工具调用时传递)
 * 3. 显式的 agent.id / agentId (context)
 * 4. session key (基于 session key 生成唯一 ID)
 * 5. runtime.model (区分不同模型)
 * 6. 默认值 'main'
 */
function getAgentIdFromContext(context: any, params?: any): string {
  // 调试日志
  console.log('[task-dag] getAgentIdFromContext:');
  console.log('  context keys:', context ? Object.keys(context) : 'null');
  console.log('  params keys:', params ? Object.keys(params) : 'null');
  console.log('  context.agent:', context?.agent);
  console.log('  params.agent_id:', params?.agent_id);
  
  // 合并 context 和 params，params 优先
  const args = { ...context, ...params };
  
  // 1. 优先使用 parent_agent_id (子 agent 继承父 agent 目录)
  const parentAgentId = args?.parent_agent_id;
  if (parentAgentId && parentAgentId !== 'main') {
    return parentAgentId;
  }
  
  // 2. 尝试从 agent_id 参数获取
  const agentIdParam = args?.agent_id;
  console.log('  agentIdParam:', agentIdParam);
  if (agentIdParam) {
    return agentIdParam;
  }
  
  // 3. 尝试从显式字段获取
  const explicitAgentId = args?.agent?.id 
    || args?.agentId 
    || args?.session?.agentId 
    || args?.runtime?.agentId;
  
  console.log('  explicitAgentId:', explicitAgentId);
  if (explicitAgentId) {
    return explicitAgentId;
  }
  
  // 4. 尝试从 session key 获取唯一标识
  const sessionKey = args?.session?.key 
    || args?.sessionKey 
    || args?.session?.sessionKey;
  
  console.log('  sessionKey:', sessionKey);
  if (sessionKey) {
    // 检查 session key 是否包含父 agent 信息
    // 格式: parentSessionKey:currentSessionKey 或类似
    const parts = sessionKey.split(':');
    if (parts.length >= 2) {
      // 尝试用第一部分作为父 agent
      const parentPart = parts[0];
      // 如果父 part 看起来像一个有效的 agent 标识
      if (parentPart && parentPart.length > 5) {
        return `session-${hashString(parentPart)}`;
      }
    }
    // 使用整个 sessionKey 的 hash
    const hash = hashString(sessionKey);
    return `session-${hash}`;
  }
  
  // 5. 尝试从 runtime.model 获取 (区分不同模型)
  const model = args?.runtime?.model;
  if (model) {
    const modelHash = hashString(model);
    return `model-${modelHash}`;
  }
  
  // 6. 默认值
  return 'main';
}

/**
 * 简单字符串 hash 函数
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * 执行工具并自动设置 Agent 上下文
 */
function executeWithAgent(executeFn: (params: any) => Promise<any>) {
  return async (params: any, context?: any) => {
    const agentId = getAgentIdFromContext(context, params);
    dag.setCurrentAgentId(agentId);
    return executeFn(params);
  };
}

function setExecutionContext(context: any, params?: any): { agentId: string; dagId?: string } {
  const dagId = params?.dag_id || context?.dag_id || context?.dagId;
  const hasExplicitAgent =
    params?.parent_agent_id ||
    params?.agent_id ||
    context?.agent?.id ||
    context?.agentId ||
    context?.session?.agentId ||
    context?.runtime?.agentId;
  const agentId =
    !hasExplicitAgent && (dagId || dag.getCurrentDagId())
      ? dag.getCurrentAgentId()
      : getAgentIdFromContext(context, params);
  dag.setCurrentAgentId(agentId);
  if (dagId) {
    dag.setCurrentDagId(dagId);
  }
  return { agentId, dagId };
}

function getTaskOrError(taskId: string) {
  const task = dag.getTask(taskId);
  if (!task) {
    return { error: `Task ${taskId} not found` };
  }
  return { task };
}

function extractSpawnResult(spawnResult: any): { sessionKey?: string; runId?: string } {
  return {
    sessionKey:
      spawnResult?.sessionKey ||
      spawnResult?.session_key ||
      spawnResult?.targetSessionKey ||
      spawnResult?.childSessionKey,
    runId:
      spawnResult?.runId ||
      spawnResult?.run_id ||
      spawnResult?.id,
  };
}

export async function claimTaskExecution(params: any, context?: any) {
  const { agentId, dagId } = setExecutionContext(context, params);
  const { task_id, executor_type = 'parent', session_key, run_id } = params;
  const taskResult = getTaskOrError(task_id);
  if ('error' in taskResult) {
    return taskResult;
  }

  const task = dag.updateTask(task_id, {
    status: 'running',
    executor: {
      type: executor_type,
      agent_id: params.executor_agent_id || agentId,
      session_key,
      run_id,
      claimed_at: new Date().toISOString(),
    },
    waiting_for: undefined,
    log: params.message ? { level: 'info', message: params.message } : undefined,
  } as any);

  upsertTaskBinding({
    dag_id: dagId || dag.getCurrentDagId() || 'default',
    task_id,
    executor_type,
    executor_agent_id: params.executor_agent_id || agentId,
    session_key,
    run_id,
    binding_status: 'active',
  }, { agentId, dagId });

  return { success: true, task, agent_id: agentId, dag_id: dagId || dag.getCurrentDagId() };
}

export async function reportTaskProgress(params: any, context?: any) {
  const { agentId, dagId } = setExecutionContext(context, params);
  const { task_id, progress, message } = params;
  const taskResult = getTaskOrError(task_id);
  if ('error' in taskResult) {
    return taskResult;
  }

  const current = taskResult.task;
  const task = dag.updateTask(task_id, {
    status: current.status === 'ready' || current.status === 'pending' ? 'running' : current.status,
    progress,
    log: message ? { level: 'info', message, progress } : undefined,
  } as any);

  appendPendingEvent({
    type: 'task_progress',
    dag_id: dagId || dag.getCurrentDagId() || 'default',
    task_id,
    session_key: params.session_key,
    run_id: params.run_id,
    payload: { progress, message },
  }, { agentId, dagId });

  return { success: true, task, agent_id: agentId };
}

function completeBindingsForTask(
  taskId: string,
  finalStatus: 'completed' | 'failed',
  context: { agentId: string; dagId?: string }
): void {
  const bindings = listTaskBindings({ task_id: taskId, binding_status: 'active' }, context);
  for (const binding of bindings) {
    completeTaskBinding(binding.binding_id, finalStatus, context);
    if (binding.run_id) {
      const remaining = listTaskBindings({ run_id: binding.run_id, binding_status: 'active' }, context);
      if (remaining.length === 0) {
        completeSessionRun(binding.run_id, context);
      }
    }
  }
}

export async function completeTaskExecution(params: any, context?: any) {
  const { agentId, dagId } = setExecutionContext(context, params);
  const { task_id, output_summary, session_key, run_id } = params;
  const taskResult = getTaskOrError(task_id);
  if ('error' in taskResult) {
    return taskResult;
  }

  const task = dag.updateTask(task_id, {
    status: 'done',
    output_summary,
    waiting_for: undefined,
    log: params.message ? { level: 'info', message: params.message } : undefined,
  });

  completeBindingsForTask(task_id, 'completed', { agentId, dagId });
  appendPendingEvent({
    type: 'task_completed',
    dag_id: dagId || dag.getCurrentDagId() || 'default',
    task_id,
    session_key,
    run_id,
    payload: { output_summary },
  }, { agentId, dagId });

  waiter.unregisterWaiting(agentId);
  return { success: true, task, agent_id: agentId };
}

export async function failTaskExecution(params: any, context?: any) {
  const { agentId, dagId } = setExecutionContext(context, params);
  const { task_id, message, session_key, run_id } = params;
  const taskResult = getTaskOrError(task_id);
  if ('error' in taskResult) {
    return taskResult;
  }

  const task = dag.updateTask(task_id, {
    status: 'failed',
    output_summary: message,
    waiting_for: undefined,
    log: message ? { level: 'error', message } : undefined,
  });

  completeBindingsForTask(task_id, 'failed', { agentId, dagId });
  appendPendingEvent({
    type: 'task_failed',
    dag_id: dagId || dag.getCurrentDagId() || 'default',
    task_id,
    session_key,
    run_id,
    payload: { message },
  }, { agentId, dagId });

  waiter.unregisterWaiting(agentId);
  return { success: true, task, agent_id: agentId };
}

export async function spawnTaskExecution(runtime: RuntimeFacade, params: any, context?: any) {
  const targetAgentId = params.target_agent_id || params.agentId;
  const contextParams = { ...params };
  delete contextParams.agentId;
  delete contextParams.target_agent_id;
  const { agentId, dagId } = setExecutionContext(context, contextParams);
  const { task_id, task, prompt, model, label, thread, mode, runtime: runtimeMode } = params;
  const taskResult = getTaskOrError(task_id);
  if ('error' in taskResult) {
    return taskResult;
  }
  if (!runtime.sessions_spawn) {
    return { error: 'sessions_spawn is not available' };
  }

  const dagIdToUse = dagId || dag.getCurrentDagId() || 'default';
  const spawnLabel = label || `task:${task_id}`;
  const spawnTaskText = task || prompt;
  if (!spawnTaskText) {
    return { error: 'task or prompt is required' };
  }

  const spawnResult = await runtime.sessions_spawn({
    task: spawnTaskText,
    agentId: targetAgentId,
    model,
    label: spawnLabel,
    thread,
    mode,
    runtime: runtimeMode,
  });

  const { sessionKey, runId } = extractSpawnResult(spawnResult);
  if (!sessionKey && !runId) {
    return { error: 'sessions_spawn did not return session or run identifiers', raw: spawnResult };
  }

  const effectiveRunId = runId || `run-${task_id}-${Date.now()}`;
  if (sessionKey) {
    saveSessionRun({
      run_id: effectiveRunId,
      child_session_key: sessionKey,
      requester_session_key: params.requester_session_key || context?.session?.key || context?.sessionKey,
      parent_agent_id: agentId,
      dag_id: dagIdToUse,
      spawn_mode: 'single_task',
      label: spawnLabel,
      active_task_ids: [task_id],
    }, { agentId, dagId: dagIdToUse });
  }

  upsertTaskBinding({
    dag_id: dagIdToUse,
    task_id,
    executor_type: 'subagent',
    executor_agent_id: targetAgentId,
    session_key: sessionKey,
    run_id: effectiveRunId,
    binding_status: 'active',
  }, { agentId, dagId: dagIdToUse });

  const updatedTask = dag.updateTask(task_id, {
    status: 'waiting_subagent',
    executor: {
      type: 'subagent',
      agent_id: targetAgentId,
      session_key: sessionKey,
      run_id: effectiveRunId,
      claimed_at: new Date().toISOString(),
    },
    waiting_for: {
      kind: 'subagent',
      session_key: sessionKey,
      run_id: effectiveRunId,
    },
    log: { level: 'info', message: `Spawned subagent for ${task_id}` },
  } as any);

  appendPendingEvent({
    type: 'subagent_spawned',
    dag_id: dagIdToUse,
    task_id,
    session_key: sessionKey,
    run_id: effectiveRunId,
    payload: { label: spawnLabel, agent_id: targetAgentId },
  }, { agentId, dagId: dagIdToUse });

  waiter.registerWaiting(agentId, task_id, params.timeout || 3600);

  return {
    success: true,
    status: 'waiting',
    task: updatedTask,
    dag_id: dagIdToUse,
    agent_id: agentId,
    session_key: sessionKey,
    run_id: effectiveRunId,
    spawn: spawnResult,
  };
}

export async function assignTasksToSession(params: any, context?: any) {
  const { agentId, dagId } = setExecutionContext(context, params);
  const dagIdToUse = dagId || dag.getCurrentDagId() || 'default';
  const { task_ids, session_key, run_id, executor_agent_id } = params;
  if (!Array.isArray(task_ids) || task_ids.length === 0) {
    return { error: 'task_ids must be a non-empty array' };
  }

  const sessionRun =
    (run_id ? getSessionRunByRunId(run_id, { agentId, dagId: dagIdToUse }) : null) ||
    (session_key ? getSessionRunBySessionKey(session_key, { agentId, dagId: dagIdToUse }) : null);
  if (!sessionRun) {
    return { error: 'session run not found for the provided session_key or run_id' };
  }

  const assigned: string[] = [];
  for (const taskId of task_ids) {
    const taskResult = getTaskOrError(taskId);
    if ('error' in taskResult) {
      return taskResult;
    }

    attachTaskToSessionRun(sessionRun.run_id, taskId, { agentId, dagId: dagIdToUse });
    upsertTaskBinding({
      dag_id: dagIdToUse,
      task_id: taskId,
      executor_type: 'subagent',
      executor_agent_id: executor_agent_id || sessionRun.parent_agent_id,
      session_key: sessionRun.child_session_key,
      run_id: sessionRun.run_id,
      binding_status: 'active',
    }, { agentId, dagId: dagIdToUse });
    dag.updateTask(taskId, {
      status: 'waiting_subagent',
      executor: {
        type: 'subagent',
        agent_id: executor_agent_id || sessionRun.parent_agent_id,
        session_key: sessionRun.child_session_key,
        run_id: sessionRun.run_id,
        claimed_at: new Date().toISOString(),
      },
      waiting_for: {
        kind: 'subagent',
        session_key: sessionRun.child_session_key,
        run_id: sessionRun.run_id,
      },
      log: { level: 'info', message: `Assigned to session ${sessionRun.child_session_key}` },
    } as any);
    assigned.push(taskId);
  }

  return {
    success: true,
    session_key: sessionRun.child_session_key,
    run_id: sessionRun.run_id,
    assigned_task_ids: assigned,
  };
}

export async function checkTaskWaitStatus(params: any, context?: any) {
  const { agentId, dagId } = setExecutionContext(context, params);
  const { task_id, timeout = 3600, register_waiter = true } = params;
  const taskResult = getTaskOrError(task_id);
  if ('error' in taskResult) {
    return taskResult;
  }

  if (register_waiter) {
    waiter.registerWaiting(agentId, task_id, timeout);
  }

  const notification = notificationModule.getAndClearNotification(task_id);
  if (notification) {
    waiter.unregisterWaiting(agentId);
    return { status: 'notified', notification, agent_id: agentId };
  }

  const task = taskResult.task;
  if (task.status === 'done') {
    waiter.unregisterWaiting(agentId);
    return { status: 'completed', output: task.output_summary, task, agent_id: agentId };
  }
  if (task.status === 'failed' || task.status === 'cancelled') {
    waiter.unregisterWaiting(agentId);
    return { status: 'failed', output: task.output_summary, task, agent_id: agentId };
  }

  const events = listPendingEvents({ task_id }, { agentId, dagId });
  if (events.length > 0) {
    return { status: 'notified', pending_events: events, task, agent_id: agentId };
  }

  return {
    status: 'waiting',
    block_reason: task.waiting_for?.kind || 'task_in_progress',
    pending_children: task.waiting_for?.child_task_ids || [],
    task,
    agent_id: agentId,
  };
}

export async function pollTaskEvents(params: any, context?: any) {
  const { agentId, dagId } = setExecutionContext(context, params);
  const events = listPendingEvents({
    type: params.type,
    task_id: params.task_id,
    session_key: params.session_key,
    run_id: params.run_id,
    includeConsumed: !!params.include_consumed,
  }, { agentId, dagId });

  return {
    events: params.limit ? events.slice(0, params.limit) : events,
    agent_id: agentId,
    dag_id: dagId || dag.getCurrentDagId(),
  };
}

export async function ackTaskEvent(params: any, context?: any) {
  const { agentId, dagId } = setExecutionContext(context, params);
  const event = consumePendingEvent(params.event_id, { agentId, dagId });
  if (!event) {
    return { error: `Event ${params.event_id} not found` };
  }
  return { success: true, event };
}

export async function reconcileTaskDagState(params: any, context?: any) {
  const { agentId, dagId } = setExecutionContext(context, params);
  const dagData = dag.loadDAG();
  if (!dagData) {
    return { error: 'No DAG exists. Use createDAG first.' };
  }

  const reconciled: Array<{ task_id: string; action: string }> = [];
  for (const task of Object.values(dagData.tasks)) {
    const activeBindings = listTaskBindings({ task_id: task.id, binding_status: 'active' }, { agentId, dagId });
    if ((task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') && activeBindings.length > 0) {
      completeBindingsForTask(task.id, task.status === 'done' ? 'completed' : 'failed', { agentId, dagId });
      reconciled.push({ task_id: task.id, action: 'completed_active_bindings' });
    }
    if (task.status === 'waiting_subagent' && activeBindings.length === 0) {
      dag.updateTask(task.id, { status: 'ready', waiting_for: undefined } as any);
      reconciled.push({ task_id: task.id, action: 'reset_waiting_without_binding' });
    }
  }

  return {
    success: true,
    reconciled,
    stats: dag.getStats(),
  };
}

function getScopeSessionRun(params: any, context: { agentId: string; dagId?: string }) {
  if (params.run_id) {
    return getSessionRunByRunId(params.run_id, context);
  }
  if (params.session_key) {
    return getSessionRunBySessionKey(params.session_key, context);
  }
  return null;
}

function getScopeTaskIds(params: any, context: { agentId: string; dagId?: string }): string[] {
  const explicitTaskIds = Array.isArray(params.task_ids) ? params.task_ids : [];
  if (explicitTaskIds.length > 0) {
    return explicitTaskIds;
  }
  if (params.task_id) {
    return [params.task_id];
  }

  const sessionRun = getScopeSessionRun(params, context);
  if (sessionRun) {
    return sessionRun.active_task_ids;
  }

  const dagData = dag.loadDAG();
  if (!dagData) {
    return [];
  }
  return Object.values(dagData.tasks)
    .filter(task => task.executor?.type === 'subagent')
    .map(task => task.id);
}

function matchesContinuationScope(event: PendingEvent, params: any, taskIds: string[]): boolean {
  if (params.run_id && event.run_id !== params.run_id) {
    return false;
  }
  if (params.session_key && event.session_key !== params.session_key) {
    return false;
  }
  if (taskIds.length > 0 && event.task_id && !taskIds.includes(event.task_id)) {
    return false;
  }
  return true;
}

function buildContinuationMessage(input: {
  completedTaskIds: string[];
  failedTaskIds: string[];
  readyTaskIds: string[];
  waitingTaskIds: string[];
}): string {
  const parts: string[] = [];
  if (input.completedTaskIds.length > 0) {
    parts.push(`completed: ${input.completedTaskIds.join(', ')}`);
  }
  if (input.failedTaskIds.length > 0) {
    parts.push(`failed: ${input.failedTaskIds.join(', ')}`);
  }
  if (input.readyTaskIds.length > 0) {
    parts.push(`ready: ${input.readyTaskIds.join(', ')}`);
  }
  if (input.waitingTaskIds.length > 0) {
    parts.push(`waiting: ${input.waitingTaskIds.join(', ')}`);
  }
  return parts.length > 0 ? parts.join(' | ') : 'no new task updates';
}

export async function continueParentSession(params: any, context?: any) {
  const executionContext = setExecutionContext(context, params);
  const { agentId, dagId } = executionContext;
  const taskIds = getScopeTaskIds(params, executionContext);
  const sessionRun = getScopeSessionRun(params, executionContext);
  const pendingEvents = listPendingEvents({ includeConsumed: false }, executionContext)
    .filter(event => matchesContinuationScope(event, params, taskIds));

  const completionEvents = pendingEvents.filter(
    event =>
      event.type === 'subagent_completed' ||
      event.type === 'subagent_failed' ||
      event.type === 'task_completed' ||
      event.type === 'task_failed'
  );
  const readyEvents = pendingEvents.filter(event => event.type === 'task_ready');

  const activeBindings = listTaskBindings({ binding_status: 'active' }, executionContext).filter(binding => {
    if (params.run_id && binding.run_id !== params.run_id) return false;
    if (params.session_key && binding.session_key !== params.session_key) return false;
    if (taskIds.length > 0 && !taskIds.includes(binding.task_id)) return false;
    return true;
  });

  const completedTaskIds = new Set<string>();
  const failedTaskIds = new Set<string>();
  const readyTaskIds = new Set<string>();
  const waitingTaskIds = new Set<string>(activeBindings.map(binding => binding.task_id));

  for (const taskId of taskIds) {
    const task = dag.getTask(taskId);
    if (!task) continue;
    if (task.status === 'done') completedTaskIds.add(taskId);
    if (task.status === 'failed' || task.status === 'cancelled') failedTaskIds.add(taskId);
    if (task.status === 'ready') readyTaskIds.add(taskId);
    if (task.status === 'waiting_subagent' || task.status === 'running') waitingTaskIds.add(taskId);
  }

  for (const event of completionEvents) {
    if (!event.task_id) continue;
    if (event.type === 'subagent_failed' || event.type === 'task_failed') {
      failedTaskIds.add(event.task_id);
      completedTaskIds.delete(event.task_id);
    } else {
      if (!failedTaskIds.has(event.task_id)) {
        completedTaskIds.add(event.task_id);
      }
    }
    waitingTaskIds.delete(event.task_id);
  }

  for (const event of readyEvents) {
    if (event.task_id) {
      readyTaskIds.add(event.task_id);
    }
  }

  const allScopedTasksTerminal =
    taskIds.length > 0 &&
    taskIds.every(taskId => {
      const task = dag.getTask(taskId);
      return task && (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled');
    });

  let action: 'continue_waiting' | 'trigger_downstream' | 'user_reply' | 'idle' = 'idle';
  let shouldReplyToUser = false;
  if (activeBindings.length > 0) {
    action = 'continue_waiting';
    shouldReplyToUser = !!params.reply_on_partial && completionEvents.length > 0;
  } else if (completionEvents.length > 0 || (params.force_summary === true && allScopedTasksTerminal)) {
    action = 'user_reply';
    shouldReplyToUser = true;
  } else if (readyTaskIds.size > 0) {
    action = 'trigger_downstream';
  }

  const eventIdsToConsume = pendingEvents
    .filter(event => action !== 'idle' && matchesContinuationScope(event, params, taskIds))
    .map(event => event.event_id);
  const consumedEventIds: string[] = [];
  if (params.consume !== false) {
    for (const eventId of eventIdsToConsume) {
      const consumed = consumePendingEvent(eventId, executionContext);
      if (consumed) {
        consumedEventIds.push(consumed.event_id);
      }
    }
  }

  return {
    action,
    should_reply_to_user: shouldReplyToUser,
    agent_id: agentId,
    dag_id: dagId || dag.getCurrentDagId(),
    run_id: params.run_id || sessionRun?.run_id,
    session_key: params.session_key || sessionRun?.child_session_key,
    completed_task_ids: Array.from(completedTaskIds),
    failed_task_ids: Array.from(failedTaskIds),
    ready_task_ids: Array.from(readyTaskIds),
    waiting_task_ids: Array.from(waitingTaskIds),
    active_binding_count: activeBindings.length,
    pending_event_ids: pendingEvents.map(event => event.event_id),
    consumed_event_ids: consumedEventIds,
    summary: buildContinuationMessage({
      completedTaskIds: Array.from(completedTaskIds),
      failedTaskIds: Array.from(failedTaskIds),
      readyTaskIds: Array.from(readyTaskIds),
      waitingTaskIds: Array.from(waitingTaskIds),
    }),
    continuation_reason:
      action === 'continue_waiting'
        ? 'subtasks_still_running'
        : action === 'trigger_downstream'
          ? 'downstream_tasks_ready'
          : action === 'user_reply'
            ? 'new_terminal_updates'
            : 'no_new_updates',
  };
}

export function registerTaskDagTools(api: OpenClawPluginApi) {
  api.logger.info('[task-dag] Registering tools...');

  // ========== task_dag_create ==========
  api.registerTool({
    name: "task_dag_create",
    description: "Create a new task DAG. Returns the DAG ID and Mermaid progress diagram.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        agent_id: { type: "string", description: "指定 agent ID（子 agent 可继承父 agent 的目录）" },
        tasks: {
          type: "array",
          description: "Array of tasks to create",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Task ID (optional, auto-generated if not provided)" },
              name: { type: "string", description: "Task name" },
              description: { type: "string", description: "Task description" },
              assigned_agent: { type: "string", description: "Agent ID to assign" },
              dependencies: { type: "array", items: { type: "string" }, description: "Task IDs this task depends on" }
            },
            required: ["name", "assigned_agent"]
          }
        }
      },
      required: ["name", "tasks"]
    },
    execute: async (params, context: any) => {
      try {
        // 同时检查 context 和 params，params 优先
        const args = { ...(context || {}), ...(params || {}) };
        
        // 获取 agent ID（支持继承父 agent）
        const agentId = getAgentIdFromContext(context, params);
        dag.setCurrentAgentId(agentId);
        
        // 解析 name 参数
        const dagName = args.name || args.project_name || args.title || 'Untitled';
        
        // 解析 tasks 参数（可能是字符串、数组或其他）
        let tasks = args.tasks || args.task_list || args.items || [];
        
        // 如果是字符串，尝试解析为 JSON
        if (typeof tasks === 'string') {
          try {
            tasks = JSON.parse(tasks);
          } catch {
            tasks = [];
          }
        }
        
        // 如果是对象（非数组），转换为数组
        if (tasks && typeof tasks === 'object' && !Array.isArray(tasks)) {
          tasks = [tasks];
        }
        
        // 确保是数组
        tasks = Array.isArray(tasks) ? tasks : [];
        
        const result = dag.createDAG(dagName, tasks);
        return {
          success: true,
          dag_id: result.id,
          agent_id: agentId,
          mermaid: dag.showProgress()
        };
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }, { optional: false });

  // ========== task_dag_show ==========
  api.registerTool({
    name: "task_dag_show",
    description: "Show current DAG progress with Mermaid diagram",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "指定 agent ID 查看其任务（可选）" }
      }
    },
    execute: async (params, context: any) => {
      const args = context || params;
      const agentId = getAgentIdFromContext(args);
      dag.setCurrentAgentId(agentId);
      const mermaid = dag.showProgress();
      const stats = dag.getStats();
      return { mermaid, stats, agent_id: agentId };
    }
  }, { optional: false });

  // ========== task_dag_ready ==========
  api.registerTool({
    name: "task_dag_ready",
    description: "Get tasks that are ready to run (dependencies completed)",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "指定 agent ID（可选）" }
      }
    },
    execute: async (params, context: any) => {
      const args = context || params;
      const agentId = getAgentIdFromContext(args);
      dag.setCurrentAgentId(agentId);
      const tasks = dag.getReadyTasks();
      return {
        agent_id: agentId,
        tasks: tasks.map(t => ({
          id: t.id,
          name: t.name,
          assigned_agent: t.assigned_agent
        }))
      };
    }
  }, { optional: false });

  // ========== task_dag_get ==========
  api.registerTool({
    name: "task_dag_get",
    description: "Get task details by ID",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
        agent_id: { type: "string", description: "指定 agent ID（可选）" }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => {
      const args = context || params;
      const agentId = getAgentIdFromContext(args);
      dag.setCurrentAgentId(agentId);
      const task = dag.getTask(args.task_id);
      if (!task) {
        return { error: `Task ${params.task_id} not found` };
      }
      return { task, agent_id: agentId };
    }
  }, { optional: false });

  // ========== task_dag_get_parent ==========
  // 跨 Agent 查看父 Agent 的任务状态
  api.registerTool({
    name: "task_dag_get_parent",
    description: "获取父 Agent 的任务状态（子 Agent 查看父任务）",
    parameters: {
      type: "object",
      properties: {
        parent_agent_id: { type: "string", description: "父 Agent ID" },
        dag_id: { type: "string", description: "父 Agent 的 DAG ID（可选，默认最新）" }
      }
    },
    execute: async (params, context: any) => {
      const args = context || params;
      const parentAgentId = args.parent_agent_id;
      
      if (!parentAgentId) {
        return { error: "parent_agent_id is required" };
      }
      
      // 加载父 Agent 的 DAG
      const parentDag = (dag as any).loadDAGForAgent(parentAgentId, args.dag_id);
      
      if (!parentDag) {
        return { error: `Parent DAG not found for agent ${parentAgentId}` };
      }
      
      // 返回所有任务的状态摘要
      const tasks = Object.values(parentDag.tasks).map((t: any) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        progress: t.progress,
        output_summary: t.output_summary
      }));
      
      return {
        parent_agent_id: parentAgentId,
        dag_id: parentDag.id,
        dag_name: parentDag.name,
        created_at: parentDag.created_at,
        tasks,
        stats: {
          total: tasks.length,
          done: tasks.filter((t: any) => t.status === 'done').length,
          running: tasks.filter((t: any) => t.status === 'running').length,
          pending: tasks.filter((t: any) => t.status === 'pending').length,
          failed: tasks.filter((t: any) => t.status === 'failed').length
        }
      };
    }
  }, { optional: false });

  // ========== task_dag_update ==========
  api.registerTool({
    name: "task_dag_update",
    description: "Update task status, progress, and/or output. Supports progress reporting during execution.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
        agent_id: { type: "string", description: "指定 agent ID（可选）" },
        status: { 
          type: "string", 
          enum: ["pending", "running", "done", "failed", "cancelled"],
          description: "Task status" 
        },
        progress: { 
          type: "number", 
          minimum: 0, 
          maximum: 100,
          description: "Progress percentage (0-100)" 
        },
        output_summary: { type: "string", description: "Task output summary" },
        log: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["info", "warn", "error"] },
            message: { type: "string" },
            progress: { type: "number" }
          }
        }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => {
      const args = context || params;
      const agentId = getAgentIdFromContext(args);
      dag.setCurrentAgentId(agentId);
      const { task_id, ...updates } = args;
      const task = dag.updateTask(task_id, updates as any);
      if (!task) {
        return { error: `Task ${task_id} not found` };
      }
      return {
        success: true,
        agent_id: agentId,
        mermaid: dag.showProgress()
      };
    }
  }, { optional: false });

  // ========== task_dag_modify ==========
  api.registerTool({
    name: "task_dag_modify",
    description: "Modify task DAG: add, remove, or update tasks dynamically",
    parameters: {
      type: "object",
      properties: {
        action: { 
          type: "string", 
          enum: ["add", "remove", "update"],
          description: "Action to perform" 
        },
        task_id: { type: "string", description: "Task ID (for remove/update)" },
        task: { 
          type: "object", 
          description: "Task data (for add/update)",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            assigned_agent: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } }
          }
        }
      },
      required: ["action"]
    },
    execute: async (params, context: any) => {
      const args = context || params;
      dag.setCurrentAgentId(args?.agent?.id || args?.agentId || 'main');
      const { action, task_id, task } = args;
      
      try {
        switch (action) {
          case 'add':
            if (!task) return { error: "Task data required for add action" };
            const added = dag.addTask(task);
            return { success: true, task_id: added.id, mermaid: dag.showProgress() };
          
          case 'remove':
            if (!task_id) return { error: "Task ID required for remove action" };
            dag.removeTask(task_id);
            return { success: true, mermaid: dag.showProgress() };
          
          case 'update':
            if (!task_id || !task) return { error: "Task ID and data required for update action" };
            dag.updateTask(task_id, task);
            return { success: true, mermaid: dag.showProgress() };
          
          default:
            return { error: `Unknown action: ${action}` };
        }
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }, { optional: false });

  // ========== task_dag_subtask_create ==========
  api.registerTool({
    name: "task_dag_subtask_create",
    description: "Create a subtask under a parent task",
    parameters: {
      type: "object",
      properties: {
        parent_id: { type: "string", description: "Parent task ID" },
        task: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            assigned_agent: { type: "string" }
          },
          required: ["name", "assigned_agent"]
        }
      },
      required: ["parent_id", "task"]
    },
    execute: async (params, context: any) => {
      const args = context || params;
      dag.setCurrentAgentId(args?.agent?.id || args?.agentId || 'main');
      const subtask = dag.addSubtask(args.parent_id, args.task);
      if (!subtask) {
        return { error: `Parent task ${params.parent_id} not found` };
      }
      return {
        success: true,
        task_id: subtask.id,
        mermaid: dag.showProgress()
      };
    }
  }, { optional: false });

  // ========== task_dag_subtask_list ==========
  api.registerTool({
    name: "task_dag_subtask_list",
    description: "Get list of subtasks for a task",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Parent task ID" }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => {
      const args = context || params;
      dag.setCurrentAgentId(args?.agent?.id || args?.agentId || 'main');
      const subtasks = dag.getSubtasks(args.task_id);
      return {
        subtasks: subtasks.map(t => ({
          id: t.id,
          name: t.name,
          status: t.status,
          progress: t.progress
        }))
      };
    }
  }, { optional: false });

  // ========== task_dag_context ==========
  api.registerTool({
    name: "task_dag_context",
    description: "Get task context including dependency outputs, description, and doc path. Useful for subtasks to understand what upstream tasks have completed.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => {
      const args = context || params;
      dag.setCurrentAgentId(args?.agent?.id || args?.agentId || 'main');
      const taskCtx = dag.getContext(args.task_id);
      if (!taskCtx) {
        return { error: `Task ${params.task_id} not found` };
      }
      return {
        task_id: taskCtx.task.id,
        task_name: taskCtx.task.name,
        task_description: taskCtx.task.description,
        task_doc_path: taskCtx.task.doc_path,
        task_status: taskCtx.task.status,
        task_progress: taskCtx.task.progress,
        parent_task: taskCtx.parent,
        dependency_outputs: taskCtx.dependency_outputs,
        dag_name: taskCtx.dag_name
      };
    }
  }, { optional: false });

  // ========== task_dag_resume ==========
  api.registerTool({
    name: "task_dag_resume",
    description: "Resume from a specific task (reset task and all downstream tasks)",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to resume from" }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => {
      const args = context || params;
      dag.setCurrentAgentId(args?.agent?.id || args?.agentId || 'main');
      const reset = dag.resumeFrom(args.task_id);
      return {
        success: true,
        reset_tasks: reset,
        mermaid: dag.showProgress()
      };
    }
  }, { optional: false });

  // ========== task_dag_logs ==========
  api.registerTool({
    name: "task_dag_logs",
    description: "Get execution logs for a task",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
        since: { type: "string", description: "ISO timestamp to filter logs (optional)" }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => {
      const args = context || params;
      dag.setCurrentAgentId(args?.agent?.id || args?.agentId || 'main');
      const logs = dag.getLogs(args.task_id, args.since);
      return { logs };
    }
  }, { optional: false });

  // ========== task_dag_set_doc ==========
  api.registerTool({
    name: "task_dag_set_doc",
    description: "Create or update a markdown document for a task. Returns the document path.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
        content: { type: "string", description: "Markdown content" }
      },
      required: ["task_id", "content"]
    },
    execute: async (params, context: any) => {
      const args = context || params;
      dag.setCurrentAgentId(args?.agent?.id || args?.agentId || 'main');
      const docPath = dag.setTaskDoc(args.task_id, args.content);
      if (!docPath) {
        return { error: `Task ${params.task_id} not found` };
      }
      return { success: true, doc_path: docPath };
    }
  }, { optional: false });

  // ========== task_dag_get_doc ==========
  api.registerTool({
    name: "task_dag_get_doc",
    description: "Get the markdown document content for a task",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => {
      const args = context || params;
      dag.setCurrentAgentId(args?.agent?.id || args?.agentId || 'main');
      const content = dag.getTaskDoc(args.task_id);
      const task = dag.getTask(args.task_id);
      if (!task) {
        return { error: `Task ${params.task_id} not found` };
      }
      return { 
        doc_path: task.doc_path,
        content 
      };
    }
  }, { optional: false });

  api.registerTool({
    name: "task_dag_claim",
    description: "Claim a task for execution by the current agent or a subagent session.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
        dag_id: { type: "string", description: "DAG ID (optional)" },
        executor_type: { type: "string", enum: ["parent", "subagent"], description: "Executor type", default: "parent" },
        executor_agent_id: { type: "string", description: "Executor agent ID" },
        session_key: { type: "string", description: "Bound subagent session key" },
        run_id: { type: "string", description: "Bound run ID" },
        message: { type: "string", description: "Optional log message" }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => claimTaskExecution(params, context)
  }, { optional: false });

  api.registerTool({
    name: "task_dag_progress",
    description: "Report deterministic task progress and emit a pending progress event.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
        dag_id: { type: "string", description: "DAG ID (optional)" },
        progress: { type: "number", minimum: 0, maximum: 100, description: "Progress percentage" },
        message: { type: "string", description: "Progress message" },
        session_key: { type: "string", description: "Session key (optional)" },
        run_id: { type: "string", description: "Run ID (optional)" }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => reportTaskProgress(params, context)
  }, { optional: false });

  api.registerTool({
    name: "task_dag_complete",
    description: "Mark a task complete and close its active bindings.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
        dag_id: { type: "string", description: "DAG ID (optional)" },
        output_summary: { type: "string", description: "Task output summary" },
        message: { type: "string", description: "Completion log message" },
        session_key: { type: "string", description: "Session key (optional)" },
        run_id: { type: "string", description: "Run ID (optional)" }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => completeTaskExecution(params, context)
  }, { optional: false });

  api.registerTool({
    name: "task_dag_fail",
    description: "Mark a task failed and close its active bindings.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
        dag_id: { type: "string", description: "DAG ID (optional)" },
        message: { type: "string", description: "Failure reason" },
        session_key: { type: "string", description: "Session key (optional)" },
        run_id: { type: "string", description: "Run ID (optional)" }
      },
      required: ["task_id", "message"]
    },
    execute: async (params, context: any) => failTaskExecution(params, context)
  }, { optional: false });

  api.registerTool({
    name: "task_dag_spawn",
    description: "Spawn a subagent for a task, create bindings, and move the task into waiting_subagent.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
        dag_id: { type: "string", description: "DAG ID (optional)" },
        task: { type: "string", description: "Subagent task prompt" },
        prompt: { type: "string", description: "Alias of task prompt" },
        agentId: { type: "string", description: "Target subagent agent ID (legacy alias)" },
        target_agent_id: { type: "string", description: "Target subagent agent ID" },
        model: { type: "string", description: "Target model" },
        label: { type: "string", description: "Spawn label" },
        thread: { type: "boolean", description: "Thread mode" },
        mode: { type: "string", enum: ["run", "session"], description: "Spawn mode" },
        runtime: { type: "string", enum: ["subagent", "acp"], description: "Runtime kind" },
        requester_session_key: { type: "string", description: "Requester session key override" },
        timeout: { type: "number", description: "Wait registration timeout", default: 3600 }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => spawnTaskExecution(api.runtime, params, context)
  }, { optional: false });

  api.registerTool({
    name: "task_dag_assign",
    description: "Assign one or more tasks to an existing subagent session or run.",
    parameters: {
      type: "object",
      properties: {
        task_ids: { type: "array", items: { type: "string" }, description: "Task IDs to assign" },
        dag_id: { type: "string", description: "DAG ID (optional)" },
        session_key: { type: "string", description: "Existing session key" },
        run_id: { type: "string", description: "Existing run ID" },
        executor_agent_id: { type: "string", description: "Executor agent ID override" }
      },
      required: ["task_ids"]
    },
    execute: async (params, context: any) => assignTasksToSession(params, context)
  }, { optional: false });

  api.logger.info('[task-dag] All tools registered');

  // ========== task_dag_wait ==========
  api.registerTool({
    name: "task_dag_wait",
    description: "Non-blocking task wait check. Returns waiting, completed, failed, or notified.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to wait for" },
        dag_id: { type: "string", description: "DAG ID (optional)" },
        timeout: { type: "number", description: "Wait registration timeout in seconds", default: 3600 },
        register_waiter: { type: "boolean", description: "Whether to refresh waiter registration", default: true }
      },
      required: ["task_id"]
    },
    execute: async (params: any, context: any) => checkTaskWaitStatus(params, context)
  }, { optional: false });

  api.registerTool({
    name: "task_dag_poll_events",
    description: "Read pending task-dag events without relying on model memory.",
    parameters: {
      type: "object",
      properties: {
        dag_id: { type: "string", description: "DAG ID (optional)" },
        type: { type: "string", description: "Filter by event type" },
        task_id: { type: "string", description: "Filter by task ID" },
        session_key: { type: "string", description: "Filter by session key" },
        run_id: { type: "string", description: "Filter by run ID" },
        include_consumed: { type: "boolean", description: "Include consumed events", default: false },
        limit: { type: "number", description: "Max events to return" }
      }
    },
    execute: async (params: any, context: any) => pollTaskEvents(params, context)
  }, { optional: false });

  api.registerTool({
    name: "task_dag_continue",
    description: "Build a parent-session continuation summary after auto-announce and decide whether to wait, trigger downstream work, or reply to the user.",
    parameters: {
      type: "object",
      properties: {
        dag_id: { type: "string", description: "DAG ID (optional)" },
        task_id: { type: "string", description: "Single task scope" },
        task_ids: { type: "array", items: { type: "string" }, description: "Explicit task scope" },
        session_key: { type: "string", description: "Session scope" },
        run_id: { type: "string", description: "Run scope" },
        consume: { type: "boolean", description: "Consume included events", default: true },
        reply_on_partial: { type: "boolean", description: "Allow replying before all active subtasks are done", default: false },
        force_summary: { type: "boolean", description: "Force a summary even when there are no new pending events", default: false }
      }
    },
    execute: async (params: any, context: any) => continueParentSession(params, context)
  }, { optional: false });

  api.registerTool({
    name: "task_dag_ack_event",
    description: "Acknowledge a pending task-dag event.",
    parameters: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Event ID" },
        dag_id: { type: "string", description: "DAG ID (optional)" }
      },
      required: ["event_id"]
    },
    execute: async (params: any, context: any) => ackTaskEvent(params, context)
  }, { optional: false });

  api.registerTool({
    name: "task_dag_reconcile",
    description: "Reconcile task state with persisted bindings and session runs.",
    parameters: {
      type: "object",
      properties: {
        dag_id: { type: "string", description: "DAG ID (optional)" }
      }
    },
    execute: async (params: any, context: any) => reconcileTaskDagState(params, context)
  }, { optional: false });

  // ========== task_dag_notify ==========
  api.registerTool({
    name: "task_dag_notify",
    description: "Notify the waiting agent about task progress, issues, or completion",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
        message: { type: "string", description: "Notification message" },
        type: { type: "string", enum: ["progress", "issue", "complete", "failed"], description: "Notification type" },
        progress: { type: "number", description: "Progress percentage (0-100)" }
      },
      required: ["task_id", "message", "type"]
    },
    execute: async (params: any, context: any) => {
      const args = context || params;
      const agentId = args?.agent?.id || args?.agentId || "main";
      dag.setCurrentAgentId(agentId);
      
      const { task_id, message, type, progress } = params;
      
      const waiter = await import("./waiter.js");
      const notificationModule = await import("./notification.js");
      
      notificationModule.addNotification(task_id, { type, message, timestamp: new Date().toISOString(), agent_id: agentId, progress });
      
      const waitingAgent = waiter.getWaitingAgent(task_id);
      
      return { success: true, delivered: !!waitingAgent, waiting_agent: waitingAgent };
    }
  }, { optional: false });

}
