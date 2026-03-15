/**
 * Task DAG Plugin - OpenClaw 动态任务图编排系统
 * 
 * 阶段三：子 Agent 调度与等待机制
 */
import { registerTaskDagTools } from "./src/tools.js";
import { registerTaskDagHooks } from "./src/hooks.js";

export default function register(api: any) {
  api.logger.info("Task DAG plugin loaded!");
  
  // 注册所有 DAG 工具
  registerTaskDagTools(api);
  
  // 注册 Hooks
  registerTaskDagHooks(api);
  
  api.logger.info("Task DAG tools registered: 12 tools + hooks");
}
