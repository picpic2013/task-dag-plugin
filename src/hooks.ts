/**
 * Hook 注册模块
 * 
 * 注册 OpenClaw Hooks 用于消息监听和恢复通知
 */

import type { OpenClawPluginApi } from "./plugin-sdk.js";
import { getAgentByTask, updateAgentStatus, saveSessionMapping, saveSessionHierarchy, getParentAgentId, getSessionInfo } from './agent.js';
import { addEvent } from './events.js';
import { addNotification } from './notification.js';
import {
  appendPendingEvent,
  completeSessionRun,
  completeTaskBinding,
  getSessionRunByRunId,
  getSessionRunBySessionKey,
  listPendingEvents,
  listTaskBindings,
} from './bindings.js';
import * as dag from './dag.js';

/**
 * 解析 sessions_spawn 的 label 获取 taskId
 * 
 * 支持格式：
 * - task:t1      → t1
 * - task_id=t1   → t1
 * - t1           → t1
 * - my-agent     → null (普通 label)
 */
export function parseTaskLabel(label: string): string | null {
  if (!label) return null;
  
  // 匹配 task:t1 格式 (处理逗号分隔的额外内容)
  const match1 = label.match(/^task:([^,]+)/i);
  if (match1) return match1[1].trim();
  
  // 匹配 task_id=t1 或 task-id=t1 格式
  const match2 = label.match(/^task[_-]?id[=:]([^,]+)/i);
  if (match2) return match2[1].trim();
  
  // 匹配纯 task ID 格式 (t1, task-1 等)
  const match3 = label.match(/^(t\d+|[a-z]+-\d+)$/i);
  if (match3) return match3[1];
  
  return null;
}

/**
 * 解析 TASK_COMPLETE 格式的消息
 */
export function parseTaskMessage(content: string): {
  task_id: string;
  output?: string;
  status?: string;
  message?: string;
  type?: string;
} | null {
  // 匹配格式: TASK_COMPLETE:task_id=t1|output=xxx|status=done
  const patterns = [
    /^TASK_COMPLETE:task_id=(\w+)(?:\|output=([^|]*))?(?:\|status=(\w+))?/,
    /^TASK_PROGRESS:task_id=(\w+)(?:\|message=([^|]*))?(?:\|progress=(\d+))?/,
    /^TASK_ISSUE:task_id=(\w+)\|message=(.*)/,
    /^TASK_FAILED:task_id=(\w+)\|message=(.*)/,
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      const result: any = { task_id: match[1] };
      
      if (content.startsWith('TASK_COMPLETE')) {
        result.output = match[2];
        result.status = match[3];
        result.type = 'complete';
      } else if (content.startsWith('TASK_PROGRESS')) {
        result.message = match[2];
        result.progress = match[3];
        result.type = 'progress';
      } else if (content.startsWith('TASK_ISSUE')) {
        result.message = match[2];
        result.type = 'issue';
      } else if (content.startsWith('TASK_FAILED')) {
        result.message = match[2];
        result.type = 'failed';
      }
      
      return result;
    }
  }
  
  return null;
}

/**
 * 处理任务消息
 */
export function handleTaskMessage(
  taskId: string,
  message: {
    type?: string;
    output?: string;
    status?: string;
    message?: string;
    progress?: string;
  }
): void {
  // 更新任务状态
  if (message.type === 'complete' || message.status === 'done') {
    dag.updateTask(taskId, { 
      status: 'done', 
      output_summary: message.output 
    });
    // 更新 agent 状态
    const agentId = getAgentByTask(taskId);
    if (agentId) {
      updateAgentStatus(agentId, 'completed');
    }
  } else if (message.type === 'failed') {
    dag.updateTask(taskId, { 
      status: 'failed',
      output_summary: message.message
    });
    const agentId = getAgentByTask(taskId);
    if (agentId) {
      updateAgentStatus(agentId, 'failed');
    }
  } else if (message.type === 'progress' || message.type === 'issue') {
    // 添加通知
    addNotification(taskId, {
      type: message.type as any,
      message: message.message || message.progress || '',
      timestamp: new Date().toISOString(),
      agent_id: 'system'
    });
  }
}

/**
 * 通知恢复
 */
export function notifyOnResume(taskId: string): void {
  // 1. 通知该任务的 agent
  const agentId = getAgentByTask(taskId);
  if (agentId) {
    addNotification(taskId, {
      type: 'issue',
      message: `任务 ${taskId} 已重置，需要重新执行`,
      timestamp: new Date().toISOString(),
      agent_id: 'system'
    });
  }
  
  // 2. 通知下游任务的 agent
  const dagData = dag.loadDAG?.();
  if (dagData?.tasks) {
    for (const [tid, task] of Object.entries(dagData.tasks)) {
      if (task.dependencies?.includes(taskId)) {
        const downstreamAgent = getAgentByTask(tid);
        if (downstreamAgent) {
          addNotification(tid, {
            type: 'issue',
            message: `上游任务 ${taskId} 已重置`,
            timestamp: new Date().toISOString(),
            agent_id: 'system'
          });
        }
      }
    }
  }
}

function setHookDagContext(agentId: string, dagId: string): void {
  dag.setCurrentAgentId(agentId);
  dag.setCurrentDagId(dagId);
}

function getHookContextFromSpawnEvent(event: any): { agentId: string; dagId: string } | null {
  const dagId = event.dagId || event.dag_id || dag.getCurrentDagId();
  const requesterSessionKey = event.requesterSessionKey;
  const parentAgentId =
    event.parentAgentId ||
    event.parent_agent_id ||
    (requesterSessionKey ? getParentAgentId(requesterSessionKey) : null) ||
    dag.getCurrentAgentId();

  if (!dagId || !parentAgentId) {
    return null;
  }

  return { agentId: parentAgentId, dagId };
}

function getHookContextFromEndedEvent(event: any): { agentId: string; dagId: string } | null {
  const targetSessionKey = event.targetSessionKey || event.childSessionKey || event.sessionKey;
  const runId = event.runId || event.run_id;
  const sessionInfo = targetSessionKey ? getSessionInfo(targetSessionKey) : null;
  const dagId = event.dagId || event.dag_id || sessionInfo?.dagId || dag.getCurrentDagId();
  const parentAgentId =
    event.parentAgentId ||
    event.parent_agent_id ||
    (targetSessionKey ? getParentAgentId(targetSessionKey) : null) ||
    dag.getCurrentAgentId();

  if (!dagId || !parentAgentId) {
    return null;
  }

  if (runId) {
    const sessionRun = getSessionRunByRunId(runId, { agentId: parentAgentId, dagId });
    if (sessionRun?.dag_id) {
      return { agentId: parentAgentId, dagId: sessionRun.dag_id };
    }
  }

  return { agentId: parentAgentId, dagId };
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

export function handleSubagentSpawnedEvent(event: any, logger?: OpenClawPluginApi['logger']): void {
  const { childSessionKey, agentId, label, requesterSessionKey } = event;
  if (!childSessionKey) {
    return;
  }

  const context = getHookContextFromSpawnEvent(event);
  if (!context) {
    logger?.warn?.('[task-dag] Unable to resolve DAG context for subagent_spawned');
    return;
  }

  setHookDagContext(context.agentId, context.dagId);
  saveSessionHierarchy(childSessionKey, requesterSessionKey, context.agentId);

  const taskId = parseTaskLabel(label);
  if (!taskId) {
    logger?.info?.(`[task-dag] No taskId in label: ${label}`);
    return;
  }

  saveSessionMapping(childSessionKey, taskId, agentId, {
    dagId: context.dagId,
    runId: event.runId || event.run_id,
    requesterSessionKey,
    label,
  });

  appendPendingEvent({
    type: 'subagent_spawned',
    dag_id: context.dagId,
    task_id: taskId,
    session_key: childSessionKey,
    run_id: event.runId || event.run_id,
    dedupe_key: `subagent_spawned:${context.dagId}:${taskId}:${event.runId || event.run_id || childSessionKey}`,
    payload: { requester_session_key: requesterSessionKey, label, agent_id: agentId },
  }, context);

  addEvent({
    event: 'subtask_spawned',
    task_id: taskId,
    session_key: childSessionKey,
    run_id: event.runId || event.run_id,
    agent_id: agentId,
    requester_session_key: requesterSessionKey,
    details: `Sub-agent started for task ${taskId}`,
  });
}

export function handleSubagentEndedEvent(event: any, logger?: OpenClawPluginApi['logger']): {
  task_ids: string[];
  newly_ready_task_ids: string[];
  outcome: string;
} {
  const targetSessionKey = event.targetSessionKey || event.childSessionKey || event.sessionKey;
  const outcome = event.outcome || 'unknown';
  if (!targetSessionKey) {
    return { task_ids: [], newly_ready_task_ids: [], outcome };
  }

  const context = getHookContextFromEndedEvent(event);
  if (!context) {
    logger?.warn?.('[task-dag] Unable to resolve DAG context for subagent_ended');
    return { task_ids: [], newly_ready_task_ids: [], outcome };
  }

  setHookDagContext(context.agentId, context.dagId);

  const runId =
    event.runId ||
    event.run_id ||
    getSessionRunBySessionKey(targetSessionKey, context)?.run_id;
  const activeBindings = listTaskBindings({ session_key: targetSessionKey, binding_status: 'active' }, context);

  if (activeBindings.length === 0) {
    const existingCompletionEvents = listPendingEvents({
      session_key: targetSessionKey,
      run_id: runId,
      includeConsumed: true,
    }, context).filter(existingEvent => existingEvent.type === 'subagent_completed' || existingEvent.type === 'subagent_failed');
    if (existingCompletionEvents.length > 0) {
      return {
        task_ids: existingCompletionEvents.map(existingEvent => existingEvent.task_id).filter((taskId): taskId is string => !!taskId),
        newly_ready_task_ids: [],
        outcome,
      };
    }

    appendPendingEvent({
      type: 'binding_orphaned',
      dag_id: context.dagId,
      session_key: targetSessionKey,
      run_id: runId,
      dedupe_key: `binding_orphaned:${context.dagId}:${targetSessionKey}:${runId || 'no-run'}:${outcome}`,
      payload: { outcome },
    } as any, context);
    addEvent({
      event: 'binding_orphaned',
      session_key: targetSessionKey,
      run_id: runId,
      outcome,
      details: `No active bindings found for session ${targetSessionKey}`,
    });
    return { task_ids: [], newly_ready_task_ids: [], outcome };
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
    const mappedAgentId = getAgentByTask(binding.task_id);
    if (mappedAgentId) {
      updateAgentStatus(mappedAgentId, isSuccess ? 'completed' : 'failed');
    }

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
  return { task_ids: taskIds, newly_ready_task_ids: newlyReady, outcome };
}

/**
 * 注册 Task DAG Hooks
 */
export function registerTaskDagHooks(api: OpenClawPluginApi): void {
  // 注册 message:received 钩子
  api.registerHook(
    'message:received',
    async (event: any) => {
      try {
        const content = event.data?.content;
        
        if (!content || typeof content !== 'string') {
          return;
        }
        
        // 解析消息
        const parsed = parseTaskMessage(content);
        if (!parsed) {
          return;
        }
        
        // 处理消息
        handleTaskMessage(parsed.task_id, parsed);
        
        api.logger.info(`[task-dag] Processed task message: ${content.substring(0, 50)}`);
      } catch (error) {
        api.logger.error(`[task-dag] Error processing message: ${error}`);
      }
    },
    {
      name: 'task-dag.task-message',
      description: '监听任务完成/进度/问题消息'
    }
  );
  
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
  api.registerHook('subagent_spawned', async (event: any) => {
    try {
      handleSubagentSpawnedEvent(event, api.logger);
      api.logger.info(`[task-dag] Processed subagent_spawned for ${event.childSessionKey}`);
    } catch (error) {
      api.logger.error(`[task-dag] Error in subagent_spawned: ${error}`);
    }
  }, {
    name: 'task-dag.subagent-spawned',
    description: '子 agent 启动时自动关联任务'
  });
  
  // 注册 subagent_ended 钩子
  api.registerHook('subagent_ended', async (event: any) => {
    try {
      const result = handleSubagentEndedEvent(event, api.logger);
      api.logger.info(`[task-dag] Processed subagent_ended for ${event.targetSessionKey || event.childSessionKey}, tasks=${result.task_ids.join(',')}`);
    } catch (error) {
      api.logger.error(`[task-dag] Error in subagent_ended: ${error}`);
    }
  }, {
    name: 'task-dag.subagent-ended',
    description: '子 agent 结束时自动更新任务状态'
  });
  
  api.logger.info('[task-dag] Hooks + subagent hooks registered');
}

/**
 * 获取 Hook 状态
 */
export function getHookStatus(): {
  registered: boolean;
  messageHook: boolean;
  startupHook: boolean;
} {
  return {
    registered: true,
    messageHook: true,
    startupHook: true
  };
}
