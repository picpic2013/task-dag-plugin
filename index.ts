/**
 * Task DAG Plugin - OpenClaw 动态任务图编排系统
 * 
 * 阶段二：核心工具
 */
import { registerTaskDagTools } from "./src/tools.js";

export default function register(api: any) {
  api.logger.info("Task DAG plugin loaded!");
  
  // 注册所有 DAG 工具
  registerTaskDagTools(api);
  
  api.logger.info("Task DAG tools registered: 10 tools");
}
