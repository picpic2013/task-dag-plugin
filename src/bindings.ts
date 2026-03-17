/**
 * 绑定层与落盘结构
 *
 * 为 task/session/run/event 提供确定性的持久化绑定。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const DEFAULT_WORKSPACE = path.join(os.homedir(), '.openclaw');
const WORKSPACE_PREFIX = 'workspace-';
const DAG_DIR = 'tasks';
const TASK_BINDINGS_FILE = 'task-bindings.json';
const SESSION_RUNS_FILE = 'session-runs.json';
const PENDING_EVENTS_FILE = 'pending-events.jsonl';
const SPAWN_INTENTS_FILE = 'spawn-intents.json';

export type BindingStatus = 'active' | 'completed' | 'failed' | 'released';
export type SpawnMode = 'single_task' | 'multi_task' | 'shared_worker' | 'unknown';
export type PendingEventType =
  | 'subagent_spawned'
  | 'subagent_completed'
  | 'subagent_failed'
  | 'task_completed'
  | 'task_failed'
  | 'task_progress'
  | 'resume_requested'
  | 'task_ready'
  | 'task_reopened'
  | 'binding_orphaned';

export interface TaskBinding {
  binding_id: string;
  dag_id: string;
  task_id: string;
  executor_type: 'parent' | 'subagent';
  executor_agent_id?: string;
  session_key?: string;
  run_id?: string;
  binding_status: BindingStatus;
  claimed_at: string;
  completed_at?: string;
}

export interface SessionRun {
  run_id: string;
  child_session_key: string;
  child_agent_id?: string;
  requester_session_key?: string;
  parent_agent_id: string;
  dag_id: string;
  spawn_mode: SpawnMode;
  label?: string;
  active_task_ids: string[];
  created_at: string;
  completed_at?: string;
}

export interface PendingEvent {
  event_id: string;
  type: PendingEventType;
  dag_id: string;
  task_id?: string;
  session_key?: string;
  run_id?: string;
  dedupe_key?: string;
  payload?: Record<string, unknown>;
  created_at: string;
  consumed_at?: string;
}

export type SpawnIntentStatus = 'prepared' | 'spawned' | 'cancelled';

export interface SpawnIntent {
  intent_id: string;
  dag_id: string;
  task_id: string;
  parent_agent_id: string;
  requester_session_key?: string;
  target_agent_id?: string;
  label: string;
  status: SpawnIntentStatus;
  created_at: string;
  spawned_at?: string;
  cancelled_at?: string;
}

interface TaskBindingsData {
  bindings: Record<string, TaskBinding>;
}

interface SessionRunsData {
  runs: Record<string, SessionRun>;
  by_session: Record<string, string[] | string>;
}

interface SpawnIntentsData {
  intents: Record<string, SpawnIntent>;
}

function getStorageDirForAgent(agentId: string, dagId: string): string {
  const baseDir = process.env.WORKSPACE_DIR || DEFAULT_WORKSPACE;

  if (agentId === 'main') {
    return path.join(baseDir, 'workspace', DAG_DIR, dagId);
  }

  return path.join(baseDir, `${WORKSPACE_PREFIX}${agentId}`, DAG_DIR, dagId);
}

function resolveContext(agentId?: string, dagId?: string): { agentId: string; dagId: string } {
  if (!agentId) {
    throw new Error('bindings context requires explicit agentId');
  }
  if (!dagId) {
    throw new Error('bindings context requires explicit dagId');
  }
  return { agentId, dagId };
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getTaskBindingsFile(agentId: string, dagId: string): string {
  return path.join(getStorageDirForAgent(agentId, dagId), TASK_BINDINGS_FILE);
}

function getSessionRunsFile(agentId: string, dagId: string): string {
  return path.join(getStorageDirForAgent(agentId, dagId), SESSION_RUNS_FILE);
}

function getPendingEventsFile(agentId: string, dagId: string): string {
  return path.join(getStorageDirForAgent(agentId, dagId), PENDING_EVENTS_FILE);
}

function getSpawnIntentsFile(agentId: string, dagId: string): string {
  return path.join(getStorageDirForAgent(agentId, dagId), SPAWN_INTENTS_FILE);
}

function loadTaskBindingsData(agentId: string, dagId: string): TaskBindingsData {
  return readJsonFile(getTaskBindingsFile(agentId, dagId), { bindings: {} });
}

function saveTaskBindingsData(agentId: string, dagId: string, data: TaskBindingsData): void {
  writeJsonFile(getTaskBindingsFile(agentId, dagId), data);
}

function loadSessionRunsData(agentId: string, dagId: string): SessionRunsData {
  return readJsonFile(getSessionRunsFile(agentId, dagId), { runs: {}, by_session: {} });
}

function saveSessionRunsData(agentId: string, dagId: string, data: SessionRunsData): void {
  writeJsonFile(getSessionRunsFile(agentId, dagId), data);
}

function loadSpawnIntentsData(agentId: string, dagId: string): SpawnIntentsData {
  return readJsonFile(getSpawnIntentsFile(agentId, dagId), { intents: {} });
}

function saveSpawnIntentsData(agentId: string, dagId: string, data: SpawnIntentsData): void {
  writeJsonFile(getSpawnIntentsFile(agentId, dagId), data);
}

function getRunIdsForSession(data: SessionRunsData, sessionKey: string): string[] {
  const raw = data.by_session[sessionKey];
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  return [raw];
}

function appendJsonLine(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(data)}\n`);
}

function loadPendingEventsData(agentId: string, dagId: string): Record<string, PendingEvent> {
  const file = getPendingEventsFile(agentId, dagId);
  if (!fs.existsSync(file)) {
    return {};
  }

  const events: Record<string, PendingEvent> = {};
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as PendingEvent;
      events[event.event_id] = event;
    } catch {
      // ignore malformed lines
    }
  }

  return events;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function upsertTaskBinding(
  input: Omit<TaskBinding, 'binding_id' | 'claimed_at'> & {
    binding_id?: string;
    claimed_at?: string;
  },
  context?: { agentId?: string; dagId?: string }
): TaskBinding {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const data = loadTaskBindingsData(agentId, dagId);
  const bindingId = input.binding_id || createId('binding');
  const binding: TaskBinding = {
    binding_id: bindingId,
    dag_id: input.dag_id || dagId,
    task_id: input.task_id,
    executor_type: input.executor_type,
    executor_agent_id: input.executor_agent_id,
    session_key: input.session_key,
    run_id: input.run_id,
    binding_status: input.binding_status,
    claimed_at: input.claimed_at || new Date().toISOString(),
    completed_at: input.completed_at,
  };

  data.bindings[bindingId] = binding;
  saveTaskBindingsData(agentId, dagId, data);
  return binding;
}

export function listTaskBindings(
  filter: {
    task_id?: string;
    session_key?: string;
    run_id?: string;
    binding_status?: BindingStatus;
  } = {},
  context?: { agentId?: string; dagId?: string }
): TaskBinding[] {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const data = loadTaskBindingsData(agentId, dagId);
  return Object.values(data.bindings).filter(binding => {
    if (filter.task_id && binding.task_id !== filter.task_id) return false;
    if (filter.session_key && binding.session_key !== filter.session_key) return false;
    if (filter.run_id && binding.run_id !== filter.run_id) return false;
    if (filter.binding_status && binding.binding_status !== filter.binding_status) return false;
    return true;
  });
}

export function getTaskBinding(
  bindingId: string,
  context?: { agentId?: string; dagId?: string }
): TaskBinding | null {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const data = loadTaskBindingsData(agentId, dagId);
  return data.bindings[bindingId] || null;
}

export function completeTaskBinding(
  bindingId: string,
  status: Extract<BindingStatus, 'completed' | 'failed' | 'released'>,
  context?: { agentId?: string; dagId?: string }
): TaskBinding | null {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const data = loadTaskBindingsData(agentId, dagId);
  const binding = data.bindings[bindingId];
  if (!binding) {
    return null;
  }

  binding.binding_status = status;
  binding.completed_at = new Date().toISOString();
  saveTaskBindingsData(agentId, dagId, data);
  return binding;
}

export function saveSessionRun(
  input: Omit<SessionRun, 'created_at' | 'active_task_ids'> & {
    active_task_ids?: string[];
    created_at?: string;
  },
  context?: { agentId?: string; dagId?: string }
): SessionRun {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const data = loadSessionRunsData(agentId, dagId);
  const existing = data.runs[input.run_id];
  const sessionRun: SessionRun = {
    run_id: input.run_id,
    child_session_key: input.child_session_key,
    child_agent_id: input.child_agent_id || existing?.child_agent_id,
    requester_session_key: input.requester_session_key,
    parent_agent_id: input.parent_agent_id,
    dag_id: input.dag_id || dagId,
    spawn_mode: input.spawn_mode,
    label: input.label,
    active_task_ids: input.active_task_ids || existing?.active_task_ids || [],
    created_at: input.created_at || existing?.created_at || new Date().toISOString(),
    completed_at: input.completed_at || existing?.completed_at,
  };

  data.runs[sessionRun.run_id] = sessionRun;
  const existingRunIds = getRunIdsForSession(data, sessionRun.child_session_key);
  data.by_session[sessionRun.child_session_key] = Array.from(new Set([...existingRunIds, sessionRun.run_id]));
  saveSessionRunsData(agentId, dagId, data);
  return sessionRun;
}

export function attachTaskToSessionRun(
  runId: string,
  taskId: string,
  context?: { agentId?: string; dagId?: string }
): SessionRun | null {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const data = loadSessionRunsData(agentId, dagId);
  const sessionRun = data.runs[runId];
  if (!sessionRun) {
    return null;
  }

  if (!sessionRun.active_task_ids.includes(taskId)) {
    sessionRun.active_task_ids.push(taskId);
  }
  saveSessionRunsData(agentId, dagId, data);
  return sessionRun;
}

export function completeSessionRun(
  runId: string,
  context?: { agentId?: string; dagId?: string }
): SessionRun | null {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const data = loadSessionRunsData(agentId, dagId);
  const sessionRun = data.runs[runId];
  if (!sessionRun) {
    return null;
  }

  sessionRun.completed_at = new Date().toISOString();
  saveSessionRunsData(agentId, dagId, data);
  return sessionRun;
}

export function getSessionRunByRunId(
  runId: string,
  context?: { agentId?: string; dagId?: string }
): SessionRun | null {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const data = loadSessionRunsData(agentId, dagId);
  return data.runs[runId] || null;
}

export function getSessionRunBySessionKey(
  sessionKey: string,
  context?: { agentId?: string; dagId?: string }
): SessionRun | null {
  const sessionRuns = listSessionRunsBySessionKey(sessionKey, context);
  if (sessionRuns.length === 0) {
    return null;
  }
  if (sessionRuns.length === 1) {
    return sessionRuns[0];
  }
  const activeRuns = sessionRuns.filter(run => !run.completed_at);
  if (activeRuns.length === 1) {
    return activeRuns[0];
  }
  return null;
}

export function listSessionRunsBySessionKey(
  sessionKey: string,
  context?: { agentId?: string; dagId?: string }
): SessionRun[] {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const data = loadSessionRunsData(agentId, dagId);
  const runIds = getRunIdsForSession(data, sessionKey);
  return runIds
    .map(runId => data.runs[runId])
    .filter((run): run is SessionRun => !!run)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function appendPendingEvent(
  input: Omit<PendingEvent, 'event_id' | 'created_at'> & {
    event_id?: string;
    created_at?: string;
  },
  context?: { agentId?: string; dagId?: string }
): PendingEvent {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  if (input.dedupe_key) {
    const existing = Object.values(loadPendingEventsData(agentId, dagId)).find(
      event => event.dedupe_key === input.dedupe_key
    );
    if (existing) {
      return existing;
    }
  }

  const event: PendingEvent = {
    event_id: input.event_id || createId('event'),
    type: input.type,
    dag_id: input.dag_id || dagId,
    task_id: input.task_id,
    session_key: input.session_key,
    run_id: input.run_id,
    dedupe_key: input.dedupe_key,
    payload: input.payload,
    created_at: input.created_at || new Date().toISOString(),
    consumed_at: input.consumed_at,
  };

  appendJsonLine(getPendingEventsFile(agentId, dagId), event);
  return event;
}

export function saveSpawnIntent(
  input: Omit<SpawnIntent, 'intent_id' | 'created_at'> & {
    intent_id?: string;
    created_at?: string;
  },
  context?: { agentId?: string; dagId?: string }
): SpawnIntent {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const data = loadSpawnIntentsData(agentId, dagId);
  const intent: SpawnIntent = {
    intent_id: input.intent_id || createId('spawn-intent'),
    dag_id: input.dag_id || dagId,
    task_id: input.task_id,
    parent_agent_id: input.parent_agent_id || agentId,
    requester_session_key: input.requester_session_key,
    target_agent_id: input.target_agent_id,
    label: input.label,
    status: input.status,
    created_at: input.created_at || new Date().toISOString(),
    spawned_at: input.spawned_at,
    cancelled_at: input.cancelled_at,
  };
  data.intents[intent.intent_id] = intent;
  saveSpawnIntentsData(agentId, dagId, data);
  return intent;
}

export function getSpawnIntentById(
  intentId: string,
  context?: { agentId?: string; dagId?: string }
): SpawnIntent | null {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  return loadSpawnIntentsData(agentId, dagId).intents[intentId] || null;
}

export function listSpawnIntents(
  filter: {
    task_id?: string;
    label?: string;
    status?: SpawnIntentStatus;
  } = {},
  context?: { agentId?: string; dagId?: string }
): SpawnIntent[] {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  return Object.values(loadSpawnIntentsData(agentId, dagId).intents)
    .filter(intent => {
      if (filter.task_id && intent.task_id !== filter.task_id) return false;
      if (filter.label && intent.label !== filter.label) return false;
      if (filter.status && intent.status !== filter.status) return false;
      return true;
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function updateSpawnIntent(
  intentId: string,
  updates: Partial<Pick<SpawnIntent, 'status' | 'spawned_at' | 'cancelled_at'>>,
  context?: { agentId?: string; dagId?: string }
): SpawnIntent | null {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const data = loadSpawnIntentsData(agentId, dagId);
  const intent = data.intents[intentId];
  if (!intent) {
    return null;
  }
  data.intents[intentId] = {
    ...intent,
    ...updates,
  };
  saveSpawnIntentsData(agentId, dagId, data);
  return data.intents[intentId];
}

export function listPendingEvents(
  filter: {
    type?: PendingEventType;
    task_id?: string;
    session_key?: string;
    run_id?: string;
    dedupe_key?: string;
    includeConsumed?: boolean;
  } = {},
  context?: { agentId?: string; dagId?: string }
): PendingEvent[] {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  return Object.values(loadPendingEventsData(agentId, dagId))
    .filter(event => {
      if (!filter.includeConsumed && event.consumed_at) return false;
      if (filter.type && event.type !== filter.type) return false;
      if (filter.task_id && event.task_id !== filter.task_id) return false;
      if (filter.session_key && event.session_key !== filter.session_key) return false;
      if (filter.run_id && event.run_id !== filter.run_id) return false;
      if (filter.dedupe_key && event.dedupe_key !== filter.dedupe_key) return false;
      return true;
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function consumePendingEvent(
  eventId: string,
  context?: { agentId?: string; dagId?: string }
): PendingEvent | null {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const events = loadPendingEventsData(agentId, dagId);
  const event = events[eventId];
  if (!event) {
    return null;
  }

  const consumed = {
    ...event,
    consumed_at: new Date().toISOString(),
  };
  appendJsonLine(getPendingEventsFile(agentId, dagId), consumed);
  return consumed;
}

export function removeTaskRuntimeState(
  taskIds: string[],
  context?: { agentId?: string; dagId?: string }
): {
  removed_binding_ids: string[];
  affected_run_ids: string[];
  removed_event_ids: string[];
} {
  const { agentId, dagId } = resolveContext(context?.agentId, context?.dagId);
  const taskIdSet = new Set(taskIds);
  const bindingsData = loadTaskBindingsData(agentId, dagId);
  const runsData = loadSessionRunsData(agentId, dagId);
  const eventsData = loadPendingEventsData(agentId, dagId);

  const removedBindingIds: string[] = [];
  const affectedRunIds = new Set<string>();
  for (const [bindingId, binding] of Object.entries(bindingsData.bindings)) {
    if (taskIdSet.has(binding.task_id)) {
      removedBindingIds.push(bindingId);
      if (binding.run_id) {
        affectedRunIds.add(binding.run_id);
      }
      delete bindingsData.bindings[bindingId];
    }
  }

  for (const runId of Object.keys(runsData.runs)) {
    const run = runsData.runs[runId];
    const nextTaskIds = run.active_task_ids.filter(taskId => !taskIdSet.has(taskId));
    if (nextTaskIds.length === 0) {
      delete runsData.runs[runId];
      const remainingRunIds = getRunIdsForSession(runsData, run.child_session_key).filter(id => id !== runId);
      if (remainingRunIds.length === 0) {
        delete runsData.by_session[run.child_session_key];
      } else {
        runsData.by_session[run.child_session_key] = remainingRunIds;
      }
      affectedRunIds.add(runId);
    } else if (nextTaskIds.length !== run.active_task_ids.length) {
      run.active_task_ids = nextTaskIds;
      affectedRunIds.add(runId);
    }
  }

  const removedEventIds: string[] = [];
  const remainingEvents = Object.values(eventsData).filter(event => {
    const shouldRemove = !!event.task_id && taskIdSet.has(event.task_id);
    if (shouldRemove) {
      removedEventIds.push(event.event_id);
    }
    return !shouldRemove;
  }).sort((a, b) => a.created_at.localeCompare(b.created_at));

  saveTaskBindingsData(agentId, dagId, bindingsData);
  saveSessionRunsData(agentId, dagId, runsData);
  const pendingEventsFile = getPendingEventsFile(agentId, dagId);
  ensureDir(path.dirname(pendingEventsFile));
  fs.writeFileSync(pendingEventsFile, remainingEvents.map(event => JSON.stringify(event)).join('\n') + (remainingEvents.length > 0 ? '\n' : ''));

  return {
    removed_binding_ids: removedBindingIds,
    affected_run_ids: Array.from(affectedRunIds),
    removed_event_ids: removedEventIds,
  };
}
