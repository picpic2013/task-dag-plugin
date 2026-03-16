/**
 * Agent ID 管理模块
 * 
 * 生成和管理跨 session/模型的唯一 Agent ID
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  attachTaskToSessionRun,
  completeTaskBinding,
  getSessionRunBySessionKey,
  listTaskBindings,
  saveSessionRun,
  upsertTaskBinding,
} from './bindings.js';
import { getCurrentDagId } from './events.js';

const WORKSPACE = process.env.WORKSPACE_DIR || path.join(os.homedir(), '.openclaw', 'workspace');
const MAPPINGS_FILE = path.join(WORKSPACE, 'tasks', 'agent-mappings.json');

interface AgentMapping {
  task_id: string;
  parent_task_id: string | null;
  created_at: string;
  updated_at?: string;
  status: 'active' | 'completed' | 'failed';
}

interface AgentMappings {
  mappings: Record<string, string>;
  [agentId: string]: AgentMapping | Record<string, string>;
}

// ============= 辅助函数 =============

function ensureDir(): void {
  const dir = path.dirname(MAPPINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadMappings(): AgentMappings {
  try {
    if (!fs.existsSync(MAPPINGS_FILE)) {
      return { mappings: {} };
    }
    const data = fs.readFileSync(MAPPINGS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { mappings: {} };
  }
}

function saveMappings(mappings: AgentMappings): void {
  ensureDir();
  fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 2));
}

// ============= 核心函数 =============

/**
 * 生成唯一的 Agent ID
 * 格式: agent-{timestamp}-{random}
 * 示例: agent-1773576000000-a1b2c3
 */
export function generateAgentId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `agent-${timestamp}-${random}`;
}

/**
 * 保存 Agent ↔ Task 映射
 */
export function saveAgentMapping(
  agentId: string, 
  taskId: string, 
  parentTaskId?: string
): void {
  const mappings = loadMappings();
  
  mappings[agentId] = {
    task_id: taskId,
    parent_task_id: parentTaskId || null,
    created_at: new Date().toISOString(),
    status: 'active'
  };
  
  // 反向映射：taskId -> agentId
  mappings.mappings[taskId] = agentId;
  
  saveMappings(mappings);
}

/**
 * 通过 Task ID 获取 Agent ID
 */
export function getAgentByTask(taskId: string): string | null {
  const mappings = loadMappings();
  return mappings.mappings[taskId] || null;
}

/**
 * 通过 Agent ID 获取 Task ID
 */
export function getTaskByAgent(agentId: string): string | null {
  const mappings = loadMappings();
  return mappings[agentId]?.task_id || null;
}

/**
 * 获取 Agent 映射信息
 */
export function getAgentInfo(agentId: string): AgentMapping | null {
  const mappings = loadMappings();
  const info = mappings[agentId];
  if (!info || 'mappings' in info) {
    return null;
  }
  return info as AgentMapping;
}

/**
 * 更新 Agent 状态
 */
export function updateAgentStatus(
  agentId: string, 
  status: 'active' | 'completed' | 'failed'
): void {
  const mappings = loadMappings();
  
  if (mappings[agentId]) {
    mappings[agentId].status = status;
    mappings[agentId].updated_at = new Date().toISOString();
    saveMappings(mappings);
  }
}

/**
 * 删除 Agent 映射
 */
export function removeAgentMapping(agentId: string): boolean {
  const mappings = loadMappings();
  
  if (!mappings[agentId]) {
    return false;
  }
  
  const taskId = mappings[agentId].task_id;
  
  // 删除 agent -> task 映射
  delete mappings[agentId];
  
  // 删除 task -> agent 映射
  delete mappings.mappings[taskId];
  
  saveMappings(mappings);
  return true;
}

/**
 * 获取所有活跃的 Agent
 */
export function getActiveAgents(): string[] {
  const mappings = loadMappings();
  return Object.entries(mappings)
    .filter(([key, value]) => 
      key !== 'mappings' && value.status === 'active'
    )
    .map(([key]) => key);
}

/**
 * 清理已完成/失败的 Agent 映射
 */
export function cleanupAgents(): number {
  const mappings = loadMappings();
  let count = 0;
  
  for (const agentId of Object.keys(mappings)) {
    if (agentId === 'mappings') continue;
    
    const agent = mappings[agentId];
    if (agent.status === 'completed' || agent.status === 'failed') {
      delete mappings.mappings[agent.task_id];
      delete mappings[agentId];
      count++;
    }
  }
  
  if (count > 0) {
    saveMappings(mappings);
  }
  
  return count;
}

// ============= Session 映射管理 =============
// 用于 subagent_spawned → subagent_ended 时自动关联 task

const SESSION_MAPPINGS_FILE = path.join(WORKSPACE, 'tasks', 'session-mappings.json');

interface SessionMapping {
  taskId: string;
  agentId: string;
  createdAt: string;
  dagId?: string;
  runId?: string;
}

interface SessionMappingsData {
  sessions: Record<string, SessionMapping>;
  reverse: Record<string, string>;  // taskId → sessionKey
}

function ensureSessionDir(): void {
  const dir = path.dirname(SESSION_MAPPINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadSessionMappings(): SessionMappingsData {
  try {
    ensureSessionDir();
    if (!fs.existsSync(SESSION_MAPPINGS_FILE)) {
      return { sessions: {}, reverse: {} };
    }
    const data = fs.readFileSync(SESSION_MAPPINGS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { sessions: {}, reverse: {} };
  }
}

function saveSessionMappings(data: SessionMappingsData): void {
  ensureSessionDir();
  fs.writeFileSync(SESSION_MAPPINGS_FILE, JSON.stringify(data, null, 2));
}

/**
 * 保存 session ↔ task 映射
 */
export function saveSessionMapping(
  sessionKey: string,
  taskId: string,
  agentId: string,
  options?: {
    dagId?: string;
    runId?: string;
    requesterSessionKey?: string;
    label?: string;
    parentAgentId?: string;
  }
): void {
  const mappings = loadSessionMappings();
  const dagId = options?.dagId || getCurrentDagId() || 'default';
  
  mappings.sessions[sessionKey] = {
    taskId,
    agentId,
    createdAt: new Date().toISOString(),
    dagId,
    runId: options?.runId
  };
  mappings.reverse[taskId] = sessionKey;
  
  saveSessionMappings(mappings);

  upsertTaskBinding({
    dag_id: dagId,
    task_id: taskId,
    executor_type: 'subagent',
    executor_agent_id: agentId,
    session_key: sessionKey,
    run_id: options?.runId,
    binding_status: 'active',
  }, { dagId });

  if (options?.runId) {
    saveSessionRun({
      run_id: options.runId,
      child_session_key: sessionKey,
      requester_session_key: options.requesterSessionKey,
      parent_agent_id: options.parentAgentId || agentId,
      dag_id: dagId,
      spawn_mode: 'single_task',
      label: options.label,
      active_task_ids: [taskId],
    }, { dagId });
  } else {
    const existingRun = getSessionRunBySessionKey(sessionKey, { dagId });
    if (existingRun) {
      attachTaskToSessionRun(existingRun.run_id, taskId, { dagId });
    }
  }
}

export function getTasksBySession(sessionKey: string): string[] {
  const currentDagId = getCurrentDagId() || 'default';
  const bindings = listTaskBindings({ session_key: sessionKey }, { dagId: currentDagId });
  return bindings.map(binding => binding.task_id);
}

/**
 * 通过 taskId 获取 sessionKey
 */
export function getSessionByTask(taskId: string): string | null {
  const mappings = loadSessionMappings();
  return mappings.reverse[taskId] || null;
}

/**
 * 删除 session 映射
 */
export function removeSessionMapping(sessionKey: string): void {
  const mappings = loadSessionMappings();
  const sessionInfo = mappings.sessions[sessionKey];
  const taskId = sessionInfo?.taskId;
  const dagId = sessionInfo?.dagId || getCurrentDagId() || 'default';
  
  delete mappings.sessions[sessionKey];
  if (taskId) {
    delete mappings.reverse[taskId];
  }
  
  saveSessionMappings(mappings);

  const bindings = listTaskBindings({ session_key: sessionKey, binding_status: 'active' }, { dagId });
  for (const binding of bindings) {
    completeTaskBinding(binding.binding_id, 'released', { dagId });
  }
}

/**
 * 获取 session 映射信息
 */
export function getSessionInfo(sessionKey: string): SessionMapping | null {
  const mappings = loadSessionMappings();
  return mappings.sessions[sessionKey] || null;
}

// ============= Session 层级管理 =============
// 用于子 Agent 找到父级的 DAG 路径

interface SessionHierarchy {
  childSessionKey: string;
  parentSessionKey: string;
  parentAgentId: string;
  createdAt: string;
}

interface SessionHierarchyData {
  hierarchy: Record<string, SessionHierarchy>;
}

const HIERARCHY_FILE = path.join(WORKSPACE, 'tasks', 'session-hierarchy.json');

function loadHierarchy(): SessionHierarchyData {
  try {
    if (!fs.existsSync(HIERARCHY_FILE)) {
      return { hierarchy: {} };
    }
    const data = fs.readFileSync(HIERARCHY_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { hierarchy: {} };
  }
}

function saveHierarchy(data: SessionHierarchyData): void {
  const dir = path.dirname(HIERARCHY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(HIERARCHY_FILE, JSON.stringify(data, null, 2));
}

/**
 * 保存父子 session 关系
 */
export function saveSessionHierarchy(
  childSessionKey: string,
  parentSessionKey: string,
  parentAgentId: string
): void {
  const data = loadHierarchy();
  data.hierarchy[childSessionKey] = {
    childSessionKey,
    parentSessionKey,
    parentAgentId,
    createdAt: new Date().toISOString()
  };
  saveHierarchy(data);
}

/**
 * 获取父级 session key
 */
export function getParentSessionKey(childSessionKey: string): string | null {
  const data = loadHierarchy();
  return data.hierarchy[childSessionKey]?.parentSessionKey || null;
}

/**
 * 获取父级 agent ID
 */
export function getParentAgentId(childSessionKey: string): string | null {
  const data = loadHierarchy();
  return data.hierarchy[childSessionKey]?.parentAgentId || null;
}

/**
 * 删除 session 层级关系
 */
export function removeSessionHierarchy(childSessionKey: string): void {
  const data = loadHierarchy();
  delete data.hierarchy[childSessionKey];
  saveHierarchy(data);
}
