/**
 * Task DAG 工具注册
 * 
 * 将所有 DAG 功能封装为 OpenClaw Agent Tools
 */

import type { OpenClawPluginApi } from "./plugin-sdk.js";
import * as dag from './dag.js';

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
    execute: async (params: { name: string; tasks: any[] }) => {
      try {
        const result = dag.createDAG(params.name, params.tasks);
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
    execute: async () => {
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
    execute: async () => {
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
    execute: async (params: { task_id: string }) => {
      const task = dag.getTask(params.task_id);
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
    execute: async (params: { 
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
    execute: async (params: { 
      action: "add" | "remove" | "update"; 
      task_id?: string; 
      task?: any;
    }) => {
      const { action, task_id, task } = params;
      
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
    execute: async (params: { parent_id: string; task: any }) => {
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
        task_id: { type: "string", description: "Parent task ID" }
      },
      required: ["task_id"]
    },
    execute: async (params: { task_id: string }) => {
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
    description: "Get task context including dependency outputs. Useful for subtasks to understand what upstream tasks have completed.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" }
      },
      required: ["task_id"]
    },
    execute: async (params: { task_id: string }) => {
      const context = dag.getContext(params.task_id);
      if (!context) {
        return { error: `Task ${params.task_id} not found` };
      }
      return {
        task_name: context.task.name,
        parent_task: context.parent,
        dependency_outputs: context.dependency_outputs,
        dag_name: context.dag_name
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
    execute: async (params: { task_id: string }) => {
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
        since: { type: "string", description: "ISO timestamp to filter logs (optional)" }
      },
      required: ["task_id"]
    },
    execute: async (params: { task_id: string; since?: string }) => {
      const logs = dag.getLogs(params.task_id, params.since);
      return { logs };
    }
  }, { optional: false });

  api.logger.info('[task-dag] All tools registered');
}
