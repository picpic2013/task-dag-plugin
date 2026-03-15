/**
 * Task DAG 工具注册
 * 
 * 将所有 DAG 功能封装为 OpenClaw Agent Tools
 */

import type { OpenClawPluginApi } from "./plugin-sdk.js";
import * as dag from './dag.js';
import { getParentAgentId, getParentSessionKey } from './agent.js';

/**
 * 从上下文获取 agent ID
 */
function getAgentIdFromContext(context: any): string {
  // 1. 尝试获取当前 session key
  const sessionKey = context?.session?.key 
    || context?.sessionKey 
    || context?.session?.sessionKey;
  
  // 2. 如果是子 agent，查找父级的 agent ID
  if (sessionKey) {
    const parentAgentId = getParentAgentId(sessionKey);
    if (parentAgentId) {
      return parentAgentId;
    }
  }
  
  // 3. 尝试从多个可能的字段获取 agent ID
  return context?.agent?.id 
    || context?.agentId 
    || context?.session?.agentId 
    || context?.runtime?.agentId
    || 'main';
}

/**
 * 执行工具并自动设置 Agent 上下文
 */
function executeWithAgent(executeFn: (params: any) => Promise<any>) {
  return async (params: any, context?: any) => {
    const agentId = getAgentIdFromContext(context);
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
        const args = context || params;
        
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
      properties: {}
    },
    execute: async (params, context: any) => {
      const args = context || params;
      dag.setCurrentAgentId(args?.agent?.id || args?.agentId || 'main');
      const mermaid = dag.showProgress();
      const stats = dag.getStats();
      return { mermaid, stats };
    }
  }, { optional: false });

  // ========== task_dag_ready ==========
  api.registerTool({
    name: "task_dag_ready",
    description: "Get tasks that are ready to run (dependencies completed)",
    parameters: {
      type: "object",
      properties: {}
    },
    execute: async (params, context: any) => {
      const args = context || params;
      dag.setCurrentAgentId(args?.agent?.id || args?.agentId || 'main');
      const tasks = dag.getReadyTasks();
      return {
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
        task_id: { type: "string", description: "Task ID" }
      },
      required: ["task_id"]
    },
    execute: async (params, context: any) => {
      const args = context || params;
      dag.setCurrentAgentId(args?.agent?.id || args?.agentId || 'main');
      const task = dag.getTask(args.task_id);
      if (!task) {
        return { error: `Task ${params.task_id} not found` };
      }
      return { task };
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
    execute: async (params, context: { 
      task_id: string; 
      status?: string; 
      progress?: number; 
      output_summary?: string;
      log?: { level?: string; message: string; progress?: number };
    }) => {
      const { task_id, ...updates } = params;
      const task = dag.updateTask(task_id, updates as any);
      if (!task) {
        return { error: `Task ${task_id} not found` };
      }
      return {
        success: true,
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
