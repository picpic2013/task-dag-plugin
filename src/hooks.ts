/**
 * Hook 注册模块
 * 
 * 注册 OpenClaw Hooks 用于消息监听和恢复通知
 */

import type { OpenClawPluginApi } from "./plugin-sdk.js";
import { getAgentByTask, saveAgentMapping, updateAgentStatus } from './agent.js';
import { getWaitingAgent, registerWaiting } from './waiter.js';
import { addNotification, Notification } from './notification.js';
import * as dag from './dag.js';

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
  
  api.logger.info('[task-dag] Hooks registered');
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
