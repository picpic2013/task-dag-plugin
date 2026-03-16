/**
 * Task DAG Plugin - OpenClaw 动态任务图编排系统
 * 
 * 方案 A：运行时对齐的 DAG / binding / hook / continuation 编排插件
 */
import { registerTaskDagTools } from "./src/tools.js";
import { registerTaskDagHooks } from "./src/hooks.js";

export default function register(api: any) {
  api.logger.info("Task DAG plugin loaded!");
  
  // 注册所有 DAG 工具
  registerTaskDagTools(api);
  
  // 注册 Hooks
  registerTaskDagHooks(api);
  
  api.logger.info("Task DAG tools registered: DAG tools + execution tools + continuation tools + hooks");
}
