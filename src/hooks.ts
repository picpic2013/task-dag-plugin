/**
 * Hook 注册模块
 * 
 * 注册 OpenClaw Hooks 用于消息监听和恢复通知
 */

import type { OpenClawPluginApi } from "./plugin-sdk.js";
import { addEvent } from './events.js';
import {
  appendPendingEvent,
  completeSessionRun,
  completeTaskBinding,
  listAssignmentIntents,
  listSpawnIntents,
  getSessionRunByRunId,
  getSessionRunBySessionKey,
  listSessionRunsBySessionKey,
  listPendingEvents,
  listTaskBindings,
  saveSessionRun,
  updateSpawnIntent,
  updateAssignmentIntent,
  upsertTaskBinding,
} from './bindings.js';
import * as dag from './dag.js';
import {
  findRequesterSessionScope,
  findRequesterSessionScopeByRunId,
  listRequesterSessionScopes,
  upsertRequesterSessionScope,
} from './requester-sessions.js';

type HookContext = {
  requesterSessionKey?: string;
  runId?: string;
  childSessionKey?: string;
};

export function parseTaskDagLabel(label: string): { version: string; dag_id?: string; task_id?: string } | null {
  if (!label?.startsWith('taskdag:')) {
    return null;
  }

  const parts = label.split(':');
  if (parts.length < 2) {
    return null;
  }

  const version = parts[1] || 'unknown';
  const parsed: { version: string; dag_id?: string; task_id?: string } = { version };

  for (const segment of parts.slice(2)) {
    const [key, value] = segment.split('=');
    if (!key || !value) {
      continue;
    }
    if (key === 'dag') {
      parsed.dag_id = value;
    } else if (key === 'task') {
      parsed.task_id = value;
    }
  }

  return parsed.task_id ? parsed : null;
}

function findPreparedSpawnIntent(event: any, ctx?: HookContext): { agentId: string; dagId: string; intentId: string; taskId: string; requesterSessionKey?: string } | null {
  const parsedLabel = parseTaskDagLabel(event.label || '');
  if (!parsedLabel?.task_id) {
    return null;
  }

  const requesterSessionKey = ctx?.requesterSessionKey || event.requesterSessionKey || event.requester_session_key;
  if (!requesterSessionKey) {
    return null;
  }

  const candidateScopes = listRequesterSessionScopes(requesterSessionKey)
    .filter(scope => !parsedLabel.dag_id || scope.dag_id === parsedLabel.dag_id);

  for (const scope of candidateScopes) {
    const matchingIntent = listSpawnIntents({
      task_id: parsedLabel.task_id,
      label: event.label,
      status: 'prepared',
    }, { agentId: scope.parent_agent_id, dagId: scope.dag_id })[0];
    if (matchingIntent) {
      return {
        agentId: scope.parent_agent_id,
        dagId: scope.dag_id,
        intentId: matchingIntent.intent_id,
        taskId: matchingIntent.task_id,
        requesterSessionKey,
      };
    }
  }

  return null;
}

function setHookDagContext(agentId: string, dagId: string): void {
  dag.setCurrentAgentId(agentId);
  dag.setCurrentDagId(dagId);
}

function withHookDagContext<T>(agentId: string, dagId: string, fn: () => T): T {
  const previousAgentId = dag.getCurrentAgentId();
  const previousDagId = dag.getCurrentDagId();
  setHookDagContext(agentId, dagId);
  try {
    return fn();
  } finally {
    dag.setCurrentAgentId(previousAgentId);
    if (previousDagId) {
      dag.setCurrentDagId(previousDagId);
    }
  }
}

function getHookContextFromSpawnEvent(event: any, ctx?: HookContext): { agentId: string; dagId: string; requesterSessionKey?: string } | null {
  const preparedIntent = findPreparedSpawnIntent(event, ctx);
  if (preparedIntent) {
    return {
      agentId: preparedIntent.agentId,
      dagId: preparedIntent.dagId,
      requesterSessionKey: preparedIntent.requesterSessionKey,
    };
  }

  const requesterSessionKey = ctx?.requesterSessionKey || event.requesterSessionKey || event.requester_session_key;
  const scope = requesterSessionKey ? findRequesterSessionScope({
    requester_session_key: requesterSessionKey,
    run_id: event.runId || event.run_id || ctx?.runId,
  }) : null;
  const dagId = scope?.dag_id || event.dagId || event.dag_id;
  const parentAgentId = scope?.parent_agent_id || event.parentAgentId || event.parent_agent_id;

  if (!dagId || !parentAgentId) {
    return null;
  }

  return { agentId: parentAgentId, dagId, requesterSessionKey };
}

function getHookContextFromEndedEvent(event: any, ctx?: HookContext): { agentId: string; dagId: string; requesterSessionKey?: string } | null {
  const runId = event.runId || event.run_id || ctx?.runId;
  const requesterSessionKey = ctx?.requesterSessionKey || event.requesterSessionKey || event.requester_session_key;
  const targetSessionKey = event.targetSessionKey || event.childSessionKey || event.sessionKey || ctx?.childSessionKey;
  const scope =
    (requesterSessionKey ? findRequesterSessionScope({ requester_session_key: requesterSessionKey, run_id: runId }) : null) ||
    (runId ? findRequesterSessionScopeByRunId(runId) : null);
  if (!scope && requesterSessionKey && targetSessionKey) {
    const candidateScopes = listRequesterSessionScopes(requesterSessionKey);
    for (const candidateScope of candidateScopes) {
      const activeAssignments = listAssignmentIntents({
        session_key: targetSessionKey,
        status: 'assigned',
      }, {
        agentId: candidateScope.parent_agent_id,
        dagId: candidateScope.dag_id,
      });
      if (activeAssignments.length > 0) {
        return {
          agentId: candidateScope.parent_agent_id,
          dagId: candidateScope.dag_id,
          requesterSessionKey,
        };
      }
    }
  }
  const dagId = scope?.dag_id || event.dagId || event.dag_id;
  const parentAgentId = scope?.parent_agent_id || event.parentAgentId || event.parent_agent_id;

  if (!dagId || !parentAgentId) {
    return null;
  }

  if (runId) {
    const sessionRun = getSessionRunByRunId(runId, { agentId: parentAgentId, dagId });
    if (sessionRun?.dag_id) {
      return { agentId: parentAgentId, dagId: sessionRun.dag_id, requesterSessionKey };
    }
  }

  return { agentId: parentAgentId, dagId, requesterSessionKey };
}

function markNewlyReadyTasks(sourceTaskIds: string[], context: { agentId: string; dagId: string }): string[] {
  const dagData = dag.loadDAG();
  if (!dagData) {
    return [];
  }

  const newlyReady = Object.values(dagData.tasks)
    .filter(task => task.status === 'ready' && task.dependencies.some(depId => sourceTaskIds.includes(depId)))
    .map(task => task.id);

  for (const readyTaskId of newlyReady) {
    appendPendingEvent({
      type: 'task_ready',
      dag_id: context.dagId,
      task_id: readyTaskId,
      dedupe_key: `task_ready:${context.dagId}:${readyTaskId}:${sourceTaskIds.slice().sort().join(',')}`,
      payload: { source_task_ids: sourceTaskIds },
    }, context);
    addEvent({
      event: 'task_ready',
      task_id: readyTaskId,
      source_task_ids: sourceTaskIds,
      details: `Task ${readyTaskId} is ready after upstream completion`,
    });
  }

  return newlyReady;
}

export function handleSubagentSpawnedEvent(event: any, ctx?: HookContext, logger?: OpenClawPluginApi['logger']): void {
  const { childSessionKey, agentId, label, requesterSessionKey } = event;
  if (!childSessionKey) {
    return;
  }

  const preparedIntent = findPreparedSpawnIntent(event, ctx);
  if (!preparedIntent) {
    logger?.info?.(`[task-dag] Ignoring non task-dag subagent_spawned label: ${label || '(none)'}`);
    return;
  }

  const context = getHookContextFromSpawnEvent(event, ctx);
  if (!context) {
    logger?.warn?.('[task-dag] Unable to resolve DAG context for subagent_spawned');
    return;
  }

  const taskId = preparedIntent.taskId;

  const runId = event.runId || event.run_id || ctx?.runId || `run-${taskId}-${Date.now()}`;
  const requesterKey = context.requesterSessionKey || requesterSessionKey || ctx?.requesterSessionKey;
  withHookDagContext(context.agentId, context.dagId, () => {
    const existingRun =
      getSessionRunByRunId(runId, context) ||
      getSessionRunBySessionKey(childSessionKey, context);
    if (!existingRun) {
      saveSessionRun({
        run_id: runId,
        child_session_key: childSessionKey,
        child_agent_id: agentId,
        requester_session_key: requesterKey,
        parent_agent_id: context.agentId,
        dag_id: context.dagId,
        spawn_mode: 'single_task',
        label,
        active_task_ids: [taskId],
      }, context);
    }

    const existingBinding = listTaskBindings({ task_id: taskId, binding_status: 'active' }, context)
      .find(binding => binding.session_key === childSessionKey && binding.run_id === runId);
    if (!existingBinding) {
      upsertTaskBinding({
        dag_id: context.dagId,
        task_id: taskId,
        executor_type: 'subagent',
        executor_agent_id: agentId,
        session_key: childSessionKey,
        run_id: runId,
        binding_status: 'active',
      }, context);
    }

    const task = dag.getTask(taskId);
    if (task?.status === 'ready' || task?.waiting_for?.kind === 'spawn_intent') {
      dag.updateTask(taskId, {
        status: 'waiting_subagent',
        executor: {
          type: 'subagent',
          agent_id: agentId,
          session_key: childSessionKey,
          run_id: runId,
          claimed_at: new Date().toISOString(),
        },
        waiting_for: {
          kind: 'subagent',
          session_key: childSessionKey,
          run_id: runId,
        },
      } as any);
    }

    updateSpawnIntent(preparedIntent.intentId, {
      status: 'spawned',
      spawned_at: new Date().toISOString(),
    }, context);

    if (requesterKey) {
      upsertRequesterSessionScope({
        requester_session_key: requesterKey,
        parent_agent_id: context.agentId,
        dag_id: context.dagId,
        run_id: runId,
        task_ids: [taskId],
      });
    }

    appendPendingEvent({
      type: 'subagent_spawned',
      dag_id: context.dagId,
      task_id: taskId,
      session_key: childSessionKey,
      run_id: runId,
      dedupe_key: `subagent_spawned:${context.dagId}:${taskId}:${runId}`,
      payload: { requester_session_key: requesterKey, label, agent_id: agentId, intent_id: preparedIntent.intentId },
    }, context);

    addEvent({
      event: 'subtask_spawned',
      task_id: taskId,
      session_key: childSessionKey,
      run_id: event.runId || event.run_id,
      agent_id: agentId,
      requester_session_key: requesterKey,
      details: `Sub-agent started for task ${taskId}`,
    });
  });
}

export function handleSubagentEndedEvent(event: any, ctx?: HookContext, logger?: OpenClawPluginApi['logger']): {
  managed_run: boolean;
  agent_id?: string;
  task_ids: string[];
  newly_ready_task_ids: string[];
  outcome: string;
  requester_session_key?: string;
  run_id?: string;
  dag_id?: string;
} {
  const targetSessionKey = event.targetSessionKey || event.childSessionKey || event.sessionKey;
  const outcome = event.outcome || 'unknown';
  if (!targetSessionKey) {
    return { managed_run: false, task_ids: [], newly_ready_task_ids: [], outcome };
  }

  const context = getHookContextFromEndedEvent(event, ctx);
  if (!context) {
    logger?.warn?.('[task-dag] Unable to resolve DAG context for subagent_ended');
    return { managed_run: false, task_ids: [], newly_ready_task_ids: [], outcome };
  }

  return withHookDagContext(context.agentId, context.dagId, () => {
    const sessionRunsByKey = listSessionRunsBySessionKey(targetSessionKey, context);
    const fallbackRunId = sessionRunsByKey.length === 1 ? sessionRunsByKey[0].run_id : undefined;
    const runId =
      event.runId ||
      event.run_id ||
      fallbackRunId;
    const matchingSessionRun =
      (runId ? getSessionRunByRunId(runId, context) : null) ||
      (sessionRunsByKey.length === 1 ? sessionRunsByKey[0] : null);
    const resolvedRequesterSessionKey =
      context.requesterSessionKey ||
      matchingSessionRun?.requester_session_key;
    let activeBindings = listTaskBindings({ session_key: targetSessionKey, binding_status: 'active' }, context)
      .filter(binding => !runId || !binding.run_id || binding.run_id === runId);
    const activeAssignments = listAssignmentIntents({ session_key: targetSessionKey, status: 'assigned' }, context);

    if (activeBindings.length === 0 && activeAssignments.length === 1) {
      const assignment = activeAssignments[0];
      const sessionTemplate = sessionRunsByKey[0];
      if (runId && !getSessionRunByRunId(runId, context) && sessionTemplate) {
        saveSessionRun({
          run_id: runId,
          child_session_key: targetSessionKey,
          child_agent_id: sessionTemplate.child_agent_id,
          requester_session_key: sessionTemplate.requester_session_key,
          parent_agent_id: context.agentId,
          dag_id: context.dagId,
          spawn_mode: 'shared_worker',
          label: sessionTemplate.label,
          active_task_ids: [assignment.task_id],
        }, context);
      }
      const synthesizedBinding = upsertTaskBinding({
        dag_id: context.dagId,
        task_id: assignment.task_id,
        executor_type: 'subagent',
        executor_agent_id: assignment.executor_agent_id,
        session_key: targetSessionKey,
        run_id: runId,
        binding_status: 'active',
      }, context);
      updateAssignmentIntent(assignment.intent_id, {
        status: 'consumed',
        consumed_at: new Date().toISOString(),
        run_id: runId,
      }, context);
      activeBindings = [synthesizedBinding];
    }

    if (activeBindings.length === 0) {
      const existingCompletionEvents = listPendingEvents({
        session_key: targetSessionKey,
        run_id: runId,
        includeConsumed: true,
      }, context).filter(existingEvent => existingEvent.type === 'subagent_completed' || existingEvent.type === 'subagent_failed');
      if (existingCompletionEvents.length > 0) {
        return {
          managed_run: true,
          agent_id: context.agentId,
          task_ids: existingCompletionEvents.map(existingEvent => existingEvent.task_id).filter((taskId): taskId is string => !!taskId),
          newly_ready_task_ids: [],
          outcome,
          requester_session_key: resolvedRequesterSessionKey,
          run_id: runId,
          dag_id: context.dagId,
        };
      }

      return {
        managed_run: false,
        agent_id: context.agentId,
        task_ids: [],
        newly_ready_task_ids: [],
        outcome,
        requester_session_key: resolvedRequesterSessionKey,
        run_id: runId,
        dag_id: context.dagId,
      };
    }

    const taskIds = activeBindings.map(binding => binding.task_id);
    const isSuccess = outcome === 'ok' || outcome === 'success' || outcome === 'completed';

    for (const binding of activeBindings) {
      const task = dag.getTask(binding.task_id);
      if (!task) {
        continue;
      }

      if (task.status !== 'done' && task.status !== 'failed' && task.status !== 'cancelled') {
        dag.updateTask(binding.task_id, {
          status: isSuccess ? 'done' : 'failed',
          waiting_for: undefined,
          log: {
            level: isSuccess ? 'info' : 'error',
            message: `Subagent ${targetSessionKey} ended with outcome ${outcome}`,
          },
        } as any);
      }

      completeTaskBinding(binding.binding_id, isSuccess ? 'completed' : 'failed', context);

      appendPendingEvent({
        type: isSuccess ? 'subagent_completed' : 'subagent_failed',
        dag_id: context.dagId,
        task_id: binding.task_id,
        session_key: targetSessionKey,
        run_id: binding.run_id || runId,
        dedupe_key: `${isSuccess ? 'subagent_completed' : 'subagent_failed'}:${context.dagId}:${binding.task_id}:${binding.run_id || runId || targetSessionKey}`,
        payload: { outcome },
      }, context);
      addEvent({
        event: 'subtask_ended',
        task_id: binding.task_id,
        session_key: targetSessionKey,
        run_id: binding.run_id || runId,
        outcome,
        details: `Sub-agent ended with outcome: ${outcome}`,
      });
    }

    if (runId) {
      completeSessionRun(runId, context);
    }

    const newlyReady = isSuccess ? markNewlyReadyTasks(taskIds, context) : [];
    return {
      managed_run: true,
      agent_id: context.agentId,
      task_ids: taskIds,
      newly_ready_task_ids: newlyReady,
      outcome,
      requester_session_key: resolvedRequesterSessionKey,
      run_id: runId,
      dag_id: context.dagId,
    };
  });
}

function buildResumeMessage(result: {
  dag_id?: string;
  run_id?: string;
  task_ids: string[];
  newly_ready_task_ids: string[];
  outcome: string;
}): string {
  const lines = [
    '[task-dag-resume]',
    `dag_id=${result.dag_id || ''}`,
    `run_id=${result.run_id || ''}`,
    `outcome=${result.outcome}`,
    `task_ids=${result.task_ids.join(',')}`,
    `newly_ready_task_ids=${result.newly_ready_task_ids.join(',')}`,
    'Call task_dag_continue with the dag_id and run_id before replying to the user.',
  ];
  return lines.join('\n');
}

function collectResumeInstructionsForSession(sessionKey?: string): string | null {
  if (!sessionKey) {
    return null;
  }
  const scopes = listRequesterSessionScopes(sessionKey);
  const lines: string[] = [];
  for (const scope of scopes) {
    const pendingResumeEvents = listPendingEvents({ type: 'resume_requested', includeConsumed: false }, {
      agentId: scope.parent_agent_id,
      dagId: scope.dag_id,
    });
    for (const event of pendingResumeEvents) {
      const payload = event.payload || {};
      if (payload.requester_session_key && payload.requester_session_key !== sessionKey) {
        continue;
      }
      const runId = typeof event.run_id === 'string' ? event.run_id : '';
      const taskIds = Array.isArray(payload.task_ids) ? payload.task_ids.join(',') : '';
      const readyTaskIds = Array.isArray(payload.newly_ready_task_ids) ? payload.newly_ready_task_ids.join(',') : '';
      lines.push(`Resume task DAG before replying: dag_id=${scope.dag_id}, run_id=${runId}, task_ids=${taskIds}, newly_ready_task_ids=${readyTaskIds}`);
    }
  }
  if (lines.length === 0) {
    return null;
  }
  return `${lines.join('\n')}\nPriority order: first call task_dag_continue for each pending dag_id/run_id, then continue task scheduling, and only then consider replying to the user.`;
}

/**
 * 注册 Task DAG Hooks
 */
export function registerTaskDagHooks(api: OpenClawPluginApi): void {
  // 注册 gateway:startup 钩子（可选）
  api.registerHook(
    'gateway:startup',
    async () => {
      api.logger.info('[task-dag] Gateway started, hooks ready');
    },
    {
      name: 'task-dag.startup',
      description: 'Gateway 启动通知'
    }
  );
  
  // 注册 subagent_spawned 钩子
  api.registerHook('subagent_spawned', async (event: any, ctx?: HookContext) => {
    try {
      handleSubagentSpawnedEvent(event, ctx, api.logger);
      api.logger.info(`[task-dag] Processed subagent_spawned for ${event.childSessionKey}`);
    } catch (error) {
      api.logger.error(`[task-dag] Error in subagent_spawned: ${error}`);
    }
  }, {
    name: 'task-dag.subagent-spawned',
    description: '子 agent 启动时自动关联任务'
  });
  
  // 注册 subagent_ended 钩子
  api.registerHook('subagent_ended', async (event: any, ctx?: HookContext) => {
    try {
      const result = handleSubagentEndedEvent(event, ctx, api.logger);
      if (!result.managed_run) {
        api.logger.info(`[task-dag] Ignoring unmanaged subagent_ended for ${event.targetSessionKey || event.childSessionKey}`);
        return;
      }
      const requesterSessionKey = result.requester_session_key || ctx?.requesterSessionKey;
      const dedupeKey = `resume_requested:${result.dag_id || 'unknown'}:${result.run_id || event.runId || event.targetSessionKey || 'no-run'}`;
      const existingResumeEvents = result.dag_id && result.agent_id
        ? listPendingEvents({ dedupe_key: dedupeKey, includeConsumed: true }, { agentId: result.agent_id, dagId: result.dag_id })
        : [];
      if (requesterSessionKey && result.dag_id && result.agent_id && existingResumeEvents.length === 0) {
        appendPendingEvent({
          type: 'resume_requested',
          dag_id: result.dag_id,
          run_id: result.run_id,
          dedupe_key: dedupeKey,
          payload: {
            requester_session_key: requesterSessionKey,
            task_ids: result.task_ids,
            newly_ready_task_ids: result.newly_ready_task_ids,
            outcome: result.outcome,
          },
        }, { agentId: result.agent_id, dagId: result.dag_id });
        if (api.runtime.sessions_send) {
          await api.runtime.sessions_send({
            sessionKey: requesterSessionKey,
            message: buildResumeMessage(result),
          });
        }
      }
      api.logger.info(`[task-dag] Processed subagent_ended for ${event.targetSessionKey || event.childSessionKey}, tasks=${result.task_ids.join(',')}`);
    } catch (error) {
      api.logger.error(`[task-dag] Error in subagent_ended: ${error}`);
    }
  }, {
    name: 'task-dag.subagent-ended',
    description: '子 agent 结束时自动更新任务状态'
  });

  api.registerHook('before_prompt_build', async (_event: any, ctx?: { sessionKey?: string }) => {
    const prependContext = collectResumeInstructionsForSession(ctx?.sessionKey);
    if (!prependContext) {
      return;
    }
    return { prependContext };
  }, {
    name: 'task-dag.parent-resume-injector',
    description: '在父会话恢复轮次前注入 task_dag_continue 指令',
  });
  
  api.logger.info('[task-dag] Hooks + subagent hooks registered');
}

/**
 * 获取 Hook 状态
 */
export function getHookStatus(): {
  registered: boolean;
  startupHook: boolean;
} {
  return {
    registered: true,
    startupHook: true
  };
}
