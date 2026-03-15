/**
 * OpenClaw Plugin SDK 类型声明
 * 
 * 用于开发时的类型检查
 */

export interface OpenClawPluginApi {
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  registerTool: (tool: ToolDefinition, options?: ToolOptions) => void;
  registerHook: (event: string, handler: HookHandler, options?: HookOptions) => void;
  runtime: {
    sessions_spawn: (params: SpawnParams) => Promise<any>;
    sessions_send: (params: SendParams) => Promise<any>;
    sessions_list: (params?: ListParams) => Promise<any>;
    subagents: (action: string, params?: any) => Promise<any>;
  };
  config: Record<string, any>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (params: any, context?: any) => Promise<any>;
}

export interface ToolOptions {
  optional?: boolean;
}

export interface HookHandler {
  (event: any): Promise<any>;
}

export interface HookOptions {
  name?: string;
  description?: string;
}

export interface SpawnParams {
  task: string;
  agentId?: string;
  model?: string;
  label?: string;
  thread?: boolean;
  mode?: 'run' | 'session';
  runtime?: 'subagent' | 'acp';
}

export interface SendParams {
  sessionKey?: string;
  label?: string;
  message: string;
}

export interface ListParams {
  activeMinutes?: number;
  kinds?: string[];
  limit?: number;
}

export default function register(api: OpenClawPluginApi): void;
