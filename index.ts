/**
 * Task DAG Plugin - OpenClaw 动态任务图编排系统
 * 
 * 阶段一：最小可加载版本
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export default function register(api: OpenClawPluginApi) {
  api.logger.info("Task DAG plugin loaded!");
  
  // 注册测试工具 - 验证插件加载成功
  api.registerTool(
    {
      name: "task_dag_ping",
      description: "Test tool to verify Task DAG plugin is loaded. Returns pong if plugin is working.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" }
        }
      },
      execute: async (params: { message?: string }) => {
        // 添加自定义日志，方便追踪
        api.logger.info("[task-dag] task_dag_ping called!");
        
        return {
          pong: true,
          message: params.message || "Task DAG plugin is working!",
          version: "0.1.0"
        };
      }
    },
    { optional: false }
  );
  
  api.logger.info("Task DAG tools registered: task_dag_ping");
}
