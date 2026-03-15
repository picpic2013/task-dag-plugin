/**
 * Task DAG 工具注册
 * 
 * 将所有 DAG 功能封装为 OpenClaw Agent Tools
 */

import type { OpenClawPluginApi } from "./plugin-sdk.js";
import * as dag from './dag.js';
import { getParentAgentId, getParentSessionKey } from './agent.js';

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

  api.logger.info('[task-dag] All tools registered');

  // ========== task_dag_wait ==========
  api.registerTool({
    name: "task_dag_wait",
    description: "Wait for a task to complete. Returns when task is done, failed, or notified.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to wait for" },
        timeout: { type: "number", description: "Max wait time in seconds (default 3600)", default: 3600 },
        check_interval: { type: "number", description: "Check interval in seconds (default 5)", default: 5 }
      },
      required: ["task_id"]
    },
    execute: async (params: any, context: any) => {
      const args = context || params;
      const agentId = args?.agent?.id || args?.agentId || "main";
      dag.setCurrentAgentId(agentId);
      
      const { task_id, timeout = 3600, check_interval = 5 } = params;
      
      const waiter = await import("./waiter.js");
      const notificationModule = await import("./notification.js");
      
      waiter.registerWaiting(agentId, task_id, timeout);
      
      const startTime = Date.now();
      
      while (Date.now() - startTime < timeout * 1000) {
        const notification = notificationModule.getAndClearNotification(task_id);
        if (notification) {
          waiter.unregisterWaiting(agentId);
          return { status: "notified", notification, mermaid: dag.showProgress() };
        }
        
        const task = dag.getTask(task_id);
        if (task) {
          if (task.status === "done") {
            waiter.unregisterWaiting(agentId);
            return { status: "completed", output: task.output_summary, mermaid: dag.showProgress() };
          }
          if (task.status === "failed") {
            waiter.unregisterWaiting(agentId);
            return { status: "failed", output: task.output_summary, mermaid: dag.showProgress() };
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, check_interval * 1000));
      }
      
      waiter.unregisterWaiting(agentId);
      return { status: "timeout", continue: true };
    }
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
