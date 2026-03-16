/**
 * Task DAG 工具注册
 * 
 * 将所有 DAG 功能封装为 OpenClaw Agent Tools
 */

import type { OpenClawPluginApi } from "./plugin-sdk.js";
import * as dag from './dag.js';
import {
  appendPendingEvent,
  attachTaskToSessionRun,
  consumePendingEvent,
  completeSessionRun,
  completeTaskBinding,
  listSessionRunsBySessionKey,
  getSessionRunByRunId,
  getSessionRunBySessionKey,
  listPendingEvents,
  listTaskBindings,
  removeTaskRuntimeState,
  saveSessionRun,
  upsertTaskBinding,
} from './bindings.js';
import type { PendingEvent } from './bindings.js';
import { removeTasksFromRequesterScopes, upsertRequesterSessionScope } from './requester-sessions.js';

type RuntimeFacade = {
  sessions_spawn?: (params: any) => Promise<any>;
};

/**
 * 从工具参数获取 agent ID。
 * 工具层不再假设存在 runtime session/context，只认显式参数。
 */
function getAgentIdFromToolParams(params?: any): string | null {
  const parentAgentId = params?.parent_agent_id;
  if (parentAgentId) {
    return parentAgentId;
  }

  const agentIdParam = params?.agent_id;
  if (agentIdParam) {
    return agentIdParam;
  }
  return null;
}

function setToolExecutionContext(
  params?: any,
  options: { requireAgent?: boolean; requireDag?: boolean; allowDefaultMain?: boolean } = {}
): { agentId: string; dagId?: string } {
  const agentId = getAgentIdFromToolParams(params) || (options.allowDefaultMain ? 'main' : null);
  const dagId = params?.dag_id || dag.getCurrentDagId() || undefined;
  if (options.requireAgent !== false && !agentId) {
    throw new Error('Explicit agent context is required. Provide agent_id or parent_agent_id.');
  }
  if (options.requireDag && !dagId) {
    throw new Error('Explicit dag context is required. Provide dag_id or create/select a DAG before calling this tool.');
  }
  if (!agentId) {
    throw new Error('Unable to resolve agent context.');
  }
  dag.setCurrentAgentId(agentId);
  if (dagId) {
    dag.setCurrentDagId(dagId);
  }
  return { agentId, dagId };
}

function invalidTransition(taskId: string, currentStatus: string, action: string, allowed: string[]) {
  return {
    error: `Task ${taskId} cannot ${action} from status ${currentStatus}`,
    task_id: taskId,
    current_status: currentStatus,
    allowed_statuses: allowed,
  };
}

function ensureTaskStatus(task: any, action: string, allowed: string[]) {
  if (!allowed.includes(task.status)) {
    return invalidTransition(task.id, task.status, action, allowed);
  }
  return null;
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

function getRequesterSessionKey(params?: any): string | undefined {
  return params?.requester_session_key;
}

export async function claimTaskExecution(params: any, context?: any) {
  try {
    const { agentId, dagId } = setToolExecutionContext(params, { requireDag: true });
    const { task_id, executor_type = 'parent', session_key, run_id } = params;
    const taskResult = getTaskOrError(task_id);
    if ('error' in taskResult) {
      return taskResult;
    }
    const transitionError = ensureTaskStatus(taskResult.task, 'be claimed', ['ready']);
    if (transitionError) {
      return transitionError;
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
  } catch (error: any) {
    return { error: error.message };
  }
}

export async function reportTaskProgress(params: any, context?: any) {
  try {
    const { agentId, dagId } = setToolExecutionContext(params, { requireDag: true });
    const { task_id, progress, message } = params;
    const taskResult = getTaskOrError(task_id);
    if ('error' in taskResult) {
      return taskResult;
    }

    const current = taskResult.task;
    const transitionError = ensureTaskStatus(current, 'report progress', ['running', 'waiting_subagent']);
    if (transitionError) {
      return transitionError;
    }

    const task = dag.updateTask(task_id, {
      status: current.status,
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
  } catch (error: any) {
    return { error: error.message };
  }
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
  try {
    const { agentId, dagId } = setToolExecutionContext(params, { requireDag: true });
    const { task_id, output_summary, session_key, run_id } = params;
    const taskResult = getTaskOrError(task_id);
    if ('error' in taskResult) {
      return taskResult;
    }
    const transitionError = ensureTaskStatus(taskResult.task, 'be completed', ['running', 'waiting_subagent']);
    if (transitionError) {
      return transitionError;
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

    return { success: true, task, agent_id: agentId };
  } catch (error: any) {
    return { error: error.message };
  }
}

export async function failTaskExecution(params: any, context?: any) {
  try {
    const { agentId, dagId } = setToolExecutionContext(params, { requireDag: true });
    const { task_id, message, session_key, run_id } = params;
    const taskResult = getTaskOrError(task_id);
    if ('error' in taskResult) {
      return taskResult;
    }
    const transitionError = ensureTaskStatus(taskResult.task, 'fail', ['running', 'waiting_subagent']);
    if (transitionError) {
      return transitionError;
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

    return { success: true, task, agent_id: agentId };
  } catch (error: any) {
    return { error: error.message };
  }
}

export async function spawnTaskExecution(runtime: RuntimeFacade, params: any, context?: any) {
  const targetAgentId = params.target_agent_id || params.agentId;
  const contextParams = { ...params };
  delete contextParams.agentId;
  delete contextParams.target_agent_id;
  try {
    const { agentId, dagId } = setToolExecutionContext(contextParams, { requireDag: true });
    const { task_id, task, prompt, model, label, thread, mode, runtime: runtimeMode } = params;
    const taskResult = getTaskOrError(task_id);
    if ('error' in taskResult) {
      return taskResult;
    }
    const transitionError = ensureTaskStatus(taskResult.task, 'spawn a subagent', ['ready']);
    if (transitionError) {
      return transitionError;
    }
    if (!runtime.sessions_spawn) {
      return { error: 'sessions_spawn is not available' };
    }

    const dagIdToUse = dagId || dag.getCurrentDagId() || 'default';
    const spawnLabel = label || `task:${task_id}`;
    const spawnTaskText = task || prompt;
    const requesterSessionKey = getRequesterSessionKey(params);
    if (!spawnTaskText) {
      return { error: 'task or prompt is required' };
    }
    if (requesterSessionKey) {
      upsertRequesterSessionScope({
        requester_session_key: requesterSessionKey,
        parent_agent_id: agentId,
        dag_id: dagIdToUse,
        task_ids: [task_id],
      });
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
        child_agent_id: targetAgentId,
        requester_session_key: requesterSessionKey,
        parent_agent_id: agentId,
        dag_id: dagIdToUse,
        spawn_mode: 'single_task',
        label: spawnLabel,
        active_task_ids: [task_id],
      }, { agentId, dagId: dagIdToUse });
    }

    if (requesterSessionKey) {
      upsertRequesterSessionScope({
        requester_session_key: requesterSessionKey,
        parent_agent_id: agentId,
        dag_id: dagIdToUse,
        run_id: effectiveRunId,
        task_ids: [task_id],
      });
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
  } catch (error: any) {
    return { error: error.message };
  }
}

export async function assignTasksToSession(params: any, context?: any) {
  try {
    const { agentId, dagId } = setToolExecutionContext(params, { requireDag: true });
    const dagIdToUse = dagId || dag.getCurrentDagId() || 'default';
    const { task_ids, session_key, run_id, executor_agent_id } = params;
    if (!Array.isArray(task_ids) || task_ids.length === 0) {
      return { error: 'task_ids must be a non-empty array' };
    }

    const sessionRunsByKey = session_key ? listSessionRunsBySessionKey(session_key, { agentId, dagId: dagIdToUse }) : [];
    if (!run_id && session_key && sessionRunsByKey.length > 1) {
      return { error: 'Multiple runs exist for this session_key. Provide run_id explicitly.' };
    }
    const sessionRun =
      (run_id ? getSessionRunByRunId(run_id, { agentId, dagId: dagIdToUse }) : null) ||
      (session_key ? getSessionRunBySessionKey(session_key, { agentId, dagId: dagIdToUse }) : null);
    if (!sessionRun) {
      return { error: 'session run not found for the provided session_key or run_id' };
    }

    const assigned: string[] = [];
    const resolvedExecutorAgentId = executor_agent_id || sessionRun.child_agent_id;
    if (!resolvedExecutorAgentId) {
      return { error: 'executor_agent_id is required when the session run has no child_agent_id' };
    }
    for (const taskId of task_ids) {
      const taskResult = getTaskOrError(taskId);
      if ('error' in taskResult) {
        return taskResult;
      }
      const transitionError = ensureTaskStatus(taskResult.task, 'be assigned to a subagent session', ['ready']);
      if (transitionError) {
        return transitionError;
      }

      attachTaskToSessionRun(sessionRun.run_id, taskId, { agentId, dagId: dagIdToUse });
      upsertTaskBinding({
        dag_id: dagIdToUse,
        task_id: taskId,
        executor_type: 'subagent',
        executor_agent_id: resolvedExecutorAgentId,
        session_key: sessionRun.child_session_key,
        run_id: sessionRun.run_id,
        binding_status: 'active',
      }, { agentId, dagId: dagIdToUse });
      dag.updateTask(taskId, {
        status: 'waiting_subagent',
        executor: {
          type: 'subagent',
          agent_id: resolvedExecutorAgentId,
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

    if (sessionRun.requester_session_key) {
      upsertRequesterSessionScope({
        requester_session_key: sessionRun.requester_session_key,
        parent_agent_id: agentId,
        dag_id: dagIdToUse,
        run_id: sessionRun.run_id,
        task_ids: assigned,
      });
    }

    return {
      success: true,
      session_key: sessionRun.child_session_key,
      run_id: sessionRun.run_id,
      assigned_task_ids: assigned,
    };
  } catch (error: any) {
    return { error: error.message };
  }
}

export async function pollTaskEvents(params: any, context?: any) {
  try {
    const { agentId, dagId } = setToolExecutionContext(params, { requireDag: true });
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
  } catch (error: any) {
    return { error: error.message };
  }
}

export async function ackTaskEvent(params: any, context?: any) {
  try {
    const { agentId, dagId } = setToolExecutionContext(params, { requireDag: true });
    const event = consumePendingEvent(params.event_id, { agentId, dagId });
    if (!event) {
      return { error: `Event ${params.event_id} not found` };
    }
    return { success: true, event };
  } catch (error: any) {
    return { error: error.message };
  }
}

export async function reconcileTaskDagState(params: any, context?: any) {
  try {
    const { agentId, dagId } = setToolExecutionContext(params, { requireDag: true });
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
  } catch (error: any) {
    return { error: error.message };
  }
}

function getScopeSessionRun(params: any, context: { agentId: string; dagId?: string }) {
  if (params.run_id) {
    return getSessionRunByRunId(params.run_id, context);
  }
  if (params.session_key) {
    const sessionRuns = listSessionRunsBySessionKey(params.session_key, context);
    if (sessionRuns.length > 1) {
      throw new Error('Multiple runs exist for this session_key. Provide run_id explicitly.');
    }
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
  return [];
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

function selectContinuationEventsToConsume(
  action: 'continue_waiting' | 'trigger_downstream' | 'user_reply' | 'idle',
  completionEvents: PendingEvent[],
  readyEvents: PendingEvent[],
): PendingEvent[] {
  switch (action) {
    case 'continue_waiting':
      return completionEvents;
    case 'trigger_downstream':
      return readyEvents;
    case 'user_reply':
      return [...completionEvents, ...readyEvents];
    case 'idle':
    default:
      return [];
  }
}

export async function continueParentSession(params: any, context?: any) {
  let executionContext: { agentId: string; dagId?: string };
  try {
    executionContext = setToolExecutionContext(params, { requireDag: true });
  } catch (error: any) {
    return { error: error.message };
  }
  const { agentId, dagId } = executionContext;
  if (!params.run_id && !params.session_key && !params.task_id && (!Array.isArray(params.task_ids) || params.task_ids.length === 0)) {
    return { error: 'Explicit continuation scope is required. Provide run_id, session_key, task_id, or task_ids.' };
  }
  let sessionRun;
  let taskIds: string[];
  try {
    sessionRun = getScopeSessionRun(params, executionContext);
    taskIds = getScopeTaskIds(params, executionContext);
  } catch (error: any) {
    return { error: error.message };
  }
  const requesterSessionKey = getRequesterSessionKey(params);
  if (requesterSessionKey && dagId) {
    upsertRequesterSessionScope({
      requester_session_key: requesterSessionKey,
      parent_agent_id: agentId,
      dag_id: dagId,
      run_id: params.run_id || sessionRun?.run_id,
      task_ids: taskIds,
    });
  }
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

  const eventsToConsume = selectContinuationEventsToConsume(action, completionEvents, readyEvents);
  const eventIdsToConsume = eventsToConsume.map(event => event.event_id);
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
    execute: async (_toolCallId, params: any) => {
      try {
        // 创建 DAG 时必须显式指定 agent 归属，不能静默回退到 main
        const { agentId } = setToolExecutionContext(params, { requireAgent: true });
        
        // 解析 name 参数
        const dagName = params.name || params.project_name || params.title || 'Untitled';
        
        // 解析 tasks 参数（可能是字符串、数组或其他）
        let tasks = params.tasks || params.task_list || params.items || [];
        
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
        agent_id: { type: "string", description: "指定 agent ID 查看其任务（可选）" },
        dag_id: { type: "string", description: "DAG ID (optional)" }
      }
    },
    execute: async (_toolCallId, params: any) => {
      const { agentId } = setToolExecutionContext(params);
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
        agent_id: { type: "string", description: "指定 agent ID（可选）" },
        dag_id: { type: "string", description: "DAG ID (optional)" }
      }
    },
    execute: async (_toolCallId, params: any) => {
      const { agentId } = setToolExecutionContext(params);
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
        agent_id: { type: "string", description: "指定 agent ID（可选）" },
        dag_id: { type: "string", description: "DAG ID (optional)" }
      },
      required: ["task_id"]
    },
    execute: async (_toolCallId, params: any) => {
      const { agentId } = setToolExecutionContext(params);
      const task = dag.getTask(params.task_id);
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
    execute: async (_toolCallId, params: any) => {
      const parentAgentId = params.parent_agent_id;
      
      if (!parentAgentId) {
        return { error: "parent_agent_id is required" };
      }
      
      // 加载父 Agent 的 DAG
      const parentDag = (dag as any).loadDAGForAgent(parentAgentId, params.dag_id);
      
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
        dag_id: { type: "string", description: "DAG ID (optional)" },
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
    execute: async (_toolCallId, params: any) => {
      setToolExecutionContext(params);
      const { action, task_id, task } = params;
      
      try {
        switch (action) {
          case 'add':
            if (!task) return { error: "Task data required for add action" };
            const added = dag.addTask(task);
            return { success: true, task_id: added.id, mermaid: dag.showProgress() };
          
          case 'remove':
            if (!task_id) return { error: "Task ID required for remove action" };
            const taskToRemove = dag.getTask(task_id);
            if (!taskToRemove) {
              return { error: `Task ${task_id} not found` };
            }
            const collectTaskIds = (id: string, collected: string[]) => {
              const current = dag.getTask(id);
              if (!current || collected.includes(id)) {
                return;
              }
              collected.push(id);
              for (const subId of current.subtasks) {
                collectTaskIds(subId, collected);
              }
            };
            const removedTaskIds: string[] = [];
            collectTaskIds(task_id, removedTaskIds);
            const cleanup = removeTaskRuntimeState(removedTaskIds, {
              agentId: dag.getCurrentAgentId(),
              dagId: dag.getCurrentDagId() || undefined,
            });
            removeTasksFromRequesterScopes({
              parent_agent_id: dag.getCurrentAgentId(),
              dag_id: dag.getCurrentDagId() || 'default',
              task_ids: removedTaskIds,
              run_ids: cleanup.affected_run_ids,
            });
            dag.removeTask(task_id);
            return { success: true, removed_task_ids: removedTaskIds, cleanup, mermaid: dag.showProgress() };
          
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
        dag_id: { type: "string", description: "DAG ID (optional)" },
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
    execute: async (_toolCallId, params: any) => {
      setToolExecutionContext(params);
      const subtask = dag.addSubtask(params.parent_id, params.task);
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
        task_id: { type: "string", description: "Parent task ID" },
        dag_id: { type: "string", description: "DAG ID (optional)" }
      },
      required: ["task_id"]
    },
    execute: async (_toolCallId, params: any) => {
      setToolExecutionContext(params);
      const subtasks = dag.getSubtasks(params.task_id);
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
        task_id: { type: "string", description: "Task ID" },
        dag_id: { type: "string", description: "DAG ID (optional)" }
      },
      required: ["task_id"]
    },
    execute: async (_toolCallId, params: any) => {
      setToolExecutionContext(params);
      const taskCtx = dag.getContext(params.task_id);
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
        task_id: { type: "string", description: "Task ID to resume from" },
        dag_id: { type: "string", description: "DAG ID (optional)" }
      },
      required: ["task_id"]
    },
    execute: async (_toolCallId, params: any) => {
      setToolExecutionContext(params);
      const reset = dag.resumeFrom(params.task_id);
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
        dag_id: { type: "string", description: "DAG ID (optional)" },
        since: { type: "string", description: "ISO timestamp to filter logs (optional)" }
      },
      required: ["task_id"]
    },
    execute: async (_toolCallId, params: any) => {
      setToolExecutionContext(params);
      const logs = dag.getLogs(params.task_id, params.since);
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
        dag_id: { type: "string", description: "DAG ID (optional)" },
        content: { type: "string", description: "Markdown content" }
      },
      required: ["task_id", "content"]
    },
    execute: async (_toolCallId, params: any) => {
      setToolExecutionContext(params);
      const docPath = dag.setTaskDoc(params.task_id, params.content);
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
        task_id: { type: "string", description: "Task ID" },
        dag_id: { type: "string", description: "DAG ID (optional)" }
      },
      required: ["task_id"]
    },
    execute: async (_toolCallId, params: any) => {
      setToolExecutionContext(params);
      const content = dag.getTaskDoc(params.task_id);
      const task = dag.getTask(params.task_id);
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
    execute: async (_toolCallId, params: any) => claimTaskExecution(params)
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
    execute: async (_toolCallId, params: any) => reportTaskProgress(params)
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
    execute: async (_toolCallId, params: any) => completeTaskExecution(params)
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
    execute: async (_toolCallId, params: any) => failTaskExecution(params)
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
        requester_session_key: { type: "string", description: "Requester session key override" }
      },
      required: ["task_id"]
    },
    execute: async (_toolCallId, params: any) => spawnTaskExecution(api.runtime, params)
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
    execute: async (_toolCallId, params: any) => assignTasksToSession(params)
  }, { optional: false });

  api.logger.info('[task-dag] All tools registered');

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
    execute: async (_toolCallId, params: any) => pollTaskEvents(params)
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
    execute: async (_toolCallId, params: any) => continueParentSession(params)
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
    execute: async (_toolCallId, params: any) => ackTaskEvent(params)
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
    execute: async (_toolCallId, params: any) => reconcileTaskDagState(params)
  }, { optional: false });

}
