/**
 * Hook 注册模块
 * 
 * 注册 OpenClaw Hooks 用于消息监听和恢复通知
 */

import type { OpenClawPluginApi } from "./plugin-sdk.js";
import { getAgentByTask, saveAgentMapping, updateAgentStatus, saveSessionMapping, getTaskBySession, removeSessionMapping, saveSessionHierarchy, getParentAgentId } from './agent.js';
import { addEvent } from './events.js';
import { getWaitingAgent, registerWaiting } from './waiter.js';
import { addNotification, Notification } from './notification.js';
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
      const { childSessionKey, agentId, label, requesterSessionKey } = event;
      
      if (!childSessionKey) return;
      
      // 保存父子关系（用于 DAG 路径查找）
      const parentAgentId = getParentAgentId(requesterSessionKey) || 'main';
      saveSessionHierarchy(childSessionKey, requesterSessionKey, parentAgentId);
      api.logger.info(`[task-dag] Session hierarchy: ${childSessionKey} → parent ${parentAgentId}`);
      
      // 解析 label 获取 taskId
      const taskId = parseTaskLabel(label);
      if (!taskId) {
        api.logger.info(`[task-dag] No taskId in label: ${label}`);
        return;
      }
      
      // 保存 session ↔ task 映射
      saveSessionMapping(childSessionKey, taskId, agentId);
      
      addEvent({
        event: 'subtask_spawned',
        task_id: taskId,
        session_key: childSessionKey,
        agent_id: agentId,
        details: `Sub-agent started for task ${taskId}`
      });
      
      api.logger.info(`[task-dag] Mapped session ${childSessionKey} → task ${taskId}`);
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
      const { targetSessionKey, outcome } = event;
      
      if (!targetSessionKey) return;
      
      // 获取 taskId
      const taskId = getTaskBySession(targetSessionKey);
      if (!taskId) {
        return;
      }
      
      // 根据结果更新任务状态
      if (outcome === 'ok') {
        dag.updateTask(taskId, { status: 'done' });
        api.logger.info(`[task-dag] Task ${taskId} marked as done`);
      } else if (outcome === 'error' || outcome === 'timeout') {
        dag.updateTask(taskId, { status: 'failed' });
        api.logger.info(`[task-dag] Task ${taskId} marked as failed (${outcome})`);
      }
      
      // 更新 agent 状态
      const agentId = getAgentByTask(taskId);
      if (agentId) {
        updateAgentStatus(agentId, outcome === 'ok' ? 'completed' : 'failed');
      }
      
      addEvent({
        event: 'subtask_ended',
        task_id: taskId,
        outcome: outcome,
        details: `Sub-agent ended with outcome: ${outcome}`
      });
      
      // 清理映射
      removeSessionMapping(targetSessionKey);
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
