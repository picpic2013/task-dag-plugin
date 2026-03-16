import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_WORKSPACE = path.join(os.homedir(), '.openclaw');
const REQUESTER_SESSIONS_FILE = 'requester-sessions.json';

export interface RequesterSessionScope {
  scope_id: string;
  requester_session_key: string;
  parent_agent_id: string;
  dag_id: string;
  active_run_ids: string[];
  active_task_ids: string[];
  updated_at: string;
}

interface RequesterSessionsData {
  scopes: Record<string, RequesterSessionScope>;
}

function getRequesterSessionsFile(): string {
  const baseDir = process.env.WORKSPACE_DIR || DEFAULT_WORKSPACE;
  return path.join(baseDir, REQUESTER_SESSIONS_FILE);
}

function ensureDir(file: string): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadData(): RequesterSessionsData {
  const file = getRequesterSessionsFile();
  try {
    if (!fs.existsSync(file)) {
      return { scopes: {} };
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as RequesterSessionsData;
  } catch {
    return { scopes: {} };
  }
}

function saveData(data: RequesterSessionsData): void {
  const file = getRequesterSessionsFile();
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function createScopeId(requesterSessionKey: string, parentAgentId: string, dagId: string): string {
  return `${requesterSessionKey}::${parentAgentId}::${dagId}`;
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

export function upsertRequesterSessionScope(input: {
  requester_session_key: string;
  parent_agent_id: string;
  dag_id: string;
  run_id?: string;
  task_ids?: string[];
}): RequesterSessionScope {
  const data = loadData();
  const scopeId = createScopeId(input.requester_session_key, input.parent_agent_id, input.dag_id);
  const existing = data.scopes[scopeId];
  const scope: RequesterSessionScope = {
    scope_id: scopeId,
    requester_session_key: input.requester_session_key,
    parent_agent_id: input.parent_agent_id,
    dag_id: input.dag_id,
    active_run_ids: unique([...(existing?.active_run_ids || []), ...(input.run_id ? [input.run_id] : [])]),
    active_task_ids: unique([...(existing?.active_task_ids || []), ...(input.task_ids || [])]),
    updated_at: new Date().toISOString(),
  };
  data.scopes[scopeId] = scope;
  saveData(data);
  return scope;
}

export function listRequesterSessionScopes(requesterSessionKey?: string): RequesterSessionScope[] {
  const scopes = Object.values(loadData().scopes);
  if (!requesterSessionKey) {
    return scopes;
  }
  return scopes.filter(scope => scope.requester_session_key === requesterSessionKey);
}

export function findRequesterSessionScope(params: {
  requester_session_key?: string;
  parent_agent_id?: string;
  dag_id?: string;
  run_id?: string;
  task_id?: string;
}): RequesterSessionScope | null {
  let scopes = listRequesterSessionScopes(params.requester_session_key);
  if (params.parent_agent_id) {
    scopes = scopes.filter(scope => scope.parent_agent_id === params.parent_agent_id);
  }
  if (params.dag_id) {
    scopes = scopes.filter(scope => scope.dag_id === params.dag_id);
  }
  if (params.run_id) {
    const runMatch = scopes.find(scope => scope.active_run_ids.includes(params.run_id!));
    if (runMatch) {
      return runMatch;
    }
  }
  if (params.task_id) {
    const taskMatch = scopes.find(scope => scope.active_task_ids.includes(params.task_id!));
    if (taskMatch) {
      return taskMatch;
    }
  }
  if (params.dag_id) {
    const dagMatch = scopes.find(scope => scope.dag_id === params.dag_id);
    if (dagMatch) {
      return dagMatch;
    }
  }
  return null;
}

export function findRequesterSessionScopeByRunId(runId: string): RequesterSessionScope | null {
  return Object.values(loadData().scopes).find(scope => scope.active_run_ids.includes(runId)) || null;
}

export function completeRequesterSessionRun(params: {
  requester_session_key?: string;
  parent_agent_id?: string;
  dag_id?: string;
  run_id?: string;
  task_ids?: string[];
}): RequesterSessionScope | null {
  const data = loadData();
  const scope = findRequesterSessionScope(params);
  if (!scope) {
    return null;
  }
  const nextScope = {
    ...scope,
    active_run_ids: scope.active_run_ids.filter(runId => runId !== params.run_id),
    active_task_ids: scope.active_task_ids.filter(taskId => !(params.task_ids || []).includes(taskId)),
    updated_at: new Date().toISOString(),
  };
  if (nextScope.active_run_ids.length === 0 && nextScope.active_task_ids.length === 0) {
    delete data.scopes[scope.scope_id];
  } else {
    data.scopes[scope.scope_id] = nextScope;
  }
  saveData(data);
  return nextScope;
}

export function removeTasksFromRequesterScopes(params: {
  parent_agent_id: string;
  dag_id: string;
  task_ids: string[];
  run_ids?: string[];
}): number {
  const data = loadData();
  let updated = 0;
  const taskIdSet = new Set(params.task_ids);
  const runIdSet = new Set(params.run_ids || []);

  for (const [scopeId, scope] of Object.entries(data.scopes)) {
    if (scope.parent_agent_id !== params.parent_agent_id || scope.dag_id !== params.dag_id) {
      continue;
    }
    const nextTaskIds = scope.active_task_ids.filter(taskId => !taskIdSet.has(taskId));
    const nextRunIds = scope.active_run_ids.filter(runId => !runIdSet.has(runId));
    if (nextTaskIds.length === scope.active_task_ids.length && nextRunIds.length === scope.active_run_ids.length) {
      continue;
    }
    updated++;
    if (nextTaskIds.length === 0 && nextRunIds.length === 0) {
      delete data.scopes[scopeId];
      continue;
    }
    data.scopes[scopeId] = {
      ...scope,
      active_task_ids: nextTaskIds,
      active_run_ids: nextRunIds,
      updated_at: new Date().toISOString(),
    };
  }

  saveData(data);
  return updated;
}

export function getRequesterSessionsFilePath(): string {
  return getRequesterSessionsFile();
}
