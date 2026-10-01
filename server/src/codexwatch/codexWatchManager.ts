import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

/** 事件回调：projectId 为事件归属的 SSCode 项目（全局摘要为 null）；app.ts 装配时接 repo.events.append */
export type AppendEventFn = (projectId: string | null, type: string, payload: Record<string, unknown>) => void;

export interface CodexTaskProgress {
  state: string;
  label: string;
  tone: string;
}

export interface CodexTaskGoal {
  id: string;
  objective: string;
  status: CodexTaskProgress;
  elapsedSeconds: number;
  elapsed: string;
}

export interface CodexTask {
  id: string;
  title: string;
  project: string;
  projectId: string | null;
  cwd: string;
  model: string | null;
  pinned: boolean;
  queuedCount: number;
  progress: CodexTaskProgress;
  activity: string;
  latestTask: string;
  latestResult: string;
  updatedAt: number;
  goal: CodexTaskGoal | null;
}

export interface CodexMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  pending: boolean;
}

export interface CodexQueuedMessage extends CodexMessage {
  queueOrder: number;
  queueRevision: number;
}

interface TaskRow {
  id: string;
  name: string | null;
  title: string | null;
  preview: string | null;
  cwd: string | null;
  model: string | null;
  is_pinned: number | null;
  project_id: string | null;
  updated_at_ms: number | null;
  recency_at_ms: number | null;
  rollout_path: string | null;
  project_name: string | null;
  section_name: string | null;
  queued_count: number | null;
  queued_message: string | null;
  turn_status: string | null;
  last_item_type: string | null;
  last_activity_at: number | null;
  latest_user: string | null;
  latest_assistant: string | null;
  goal_id: string | null;
  goal_objective: string | null;
  goal_status: string | null;
  goal_time_used_seconds: number | null;
}

interface MessageRow {
  queue_item_id?: string | null;
  queue_order?: number | null;
  queue_revision?: number | null;
  created_at_ms: number | null;
  item_type: string;
  item_json: string;
  pending: number;
}

interface RolloutSnapshot {
  lifecycle: string | null;
  latestUser: string;
  latestAssistant: string;
  lastActivityType: string | null;
  lastActivityAt: number;
  messages: CodexMessage[];
}

const TASK_SQL = `
SELECT t.id, t.name, t.title, t.preview, t.cwd, t.model, t.is_pinned, p.id AS project_id,
       t.updated_at_ms, t.recency_at_ms, t.rollout_path,
       p.name AS project_name, s.name AS section_name,
       (SELECT COUNT(*) FROM queue_db.queued_items qi WHERE qi.thread_id = t.id) AS queued_count,
       (SELECT json_extract(qi.payload_json, '$.UserInput.content[0].text') FROM queue_db.queued_items qi WHERE qi.thread_id = t.id ORDER BY qi.queue_order DESC LIMIT 1) AS queued_message,
       (SELECT ht.status FROM history_db.thread_turns ht WHERE ht.thread_id = t.id ORDER BY ht.rollout_ordinal DESC LIMIT 1) AS turn_status,
       (SELECT hi.item_type FROM history_db.thread_items hi WHERE hi.thread_id = t.id ORDER BY hi.rollout_ordinal DESC LIMIT 1) AS last_item_type,
       (SELECT hi.created_at_ms FROM history_db.thread_items hi WHERE hi.thread_id = t.id ORDER BY hi.rollout_ordinal DESC LIMIT 1) AS last_activity_at,
       NULL AS latest_user,
       NULL AS latest_assistant,
       g.goal_id, g.objective AS goal_objective, g.status AS goal_status,
       g.time_used_seconds AS goal_time_used_seconds
FROM threads t
LEFT JOIN projects p ON p.id = COALESCE(t.project_id, (
  SELECT pr.project_id FROM project_roots pr
  WHERE t.cwd = pr.path OR t.cwd LIKE pr.path || '/%'
  ORDER BY LENGTH(pr.path) DESC LIMIT 1
))
LEFT JOIN thread_sections s ON s.id = t.thread_section_id
LEFT JOIN goal_db.thread_goals g ON g.thread_id = t.id
WHERE t.archived = 0 AND t.preview <> '' AND (
  t.thread_source = 'user'
  OR (t.thread_source IS NULL AND t.originator = 'Codex Desktop' AND t.project_id IS NOT NULL)
)
ORDER BY t.is_pinned DESC, t.recency_at_ms DESC
LIMIT 80;`;

const BASIC_TASK_SQL = `
SELECT t.id, t.name, t.title, t.preview, t.cwd, t.model, t.is_pinned, NULL AS project_id,
       t.updated_at_ms, t.recency_at_ms, t.rollout_path,
       NULL AS project_name, NULL AS section_name,
       0 AS queued_count, NULL AS queued_message,
       NULL AS turn_status, NULL AS last_item_type, NULL AS last_activity_at,
       NULL AS latest_user, NULL AS latest_assistant,
       NULL AS goal_id, NULL AS goal_objective, NULL AS goal_status,
       NULL AS goal_time_used_seconds
FROM threads t
WHERE t.archived = 0 AND t.preview <> '' AND (
  t.thread_source = 'user'
  OR (t.thread_source IS NULL AND t.originator = 'Codex Desktop' AND t.project_id IS NOT NULL)
)
ORDER BY t.is_pinned DESC, t.recency_at_ms DESC
LIMIT 80;`;

const MESSAGES_SQL = `
SELECT created_at_ms, item_type, item_json, 0 AS pending
FROM history_db.thread_items
WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage')
ORDER BY rollout_ordinal DESC
LIMIT 24;`;

const QUEUED_SQL = `
SELECT qi.id AS queue_item_id, qi.created_at_ms, qi.queue_order,
       COALESCE(qr.revision, 0) AS queue_revision,
       'queuedMessage' AS item_type, qi.payload_json AS item_json, 1 AS pending
FROM queue_db.queued_items qi
LEFT JOIN queue_db.queued_thread_revisions qr ON qr.thread_id = qi.thread_id
WHERE qi.thread_id = ?
ORDER BY qi.queue_order ASC
LIMIT 50;`;

const ATTACH_SPECS = [
  { alias: 'queue_db', prefix: 'queue' },
  { alias: 'history_db', prefix: 'thread_history' },
  { alias: 'goal_db', prefix: 'goals' },
] as const;

const ROLLOUT_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 20;
const DEFAULT_POLL_MS = 2000;

function truncate(value: unknown, length = 180): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

function folderName(dir: string | null): string {
  const clean = String(dir ?? '').replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/);
  return clean ? parts[parts.length - 1] ?? '' : '';
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text'))
    .map((item) => String(item.text ?? ''))
    .join('\n')
    .trim();
}

function isInternalMessage(text: string): boolean {
  const value = String(text ?? '').trim();
  return !value || /^<(image_resize_notice|environment_context|recommended_plugins|app-context|skills_instructions|permissions\b)/.test(value);
}

function cleanUserMessage(text: string): string {
  const value = String(text ?? '').trim();
  const marker = '## My request:';
  if (value.includes(marker)) return value.slice(value.lastIndexOf(marker) + marker.length).trim();
  if (value.startsWith('<in-app-browser-context')) return '';
  return value;
}

function inferProgress(opts: { lifecycle: string | null; lastActivityAt: number; queued: number; now: number }): CodexTaskProgress {
  const { lifecycle, lastActivityAt, queued, now } = opts;
  if (lifecycle === 'task_started' || lifecycle === 'inProgress') return { state: 'running', label: '进行中', tone: 'blue' };
  if (lifecycle === 'turn_aborted' || lifecycle === 'interrupted') return { state: 'paused', label: '已暂停', tone: 'amber' };
  if (lifecycle === 'failed') return { state: 'failed', label: '需处理', tone: 'red' };
  if (queued > 0) return { state: 'queued', label: '已排队', tone: 'violet' };
  if (lifecycle === 'task_complete' || lifecycle === 'completed') return { state: 'done', label: '已完成', tone: 'green' };
  if (lastActivityAt && now - lastActivityAt < 120_000) return { state: 'running', label: '同步中', tone: 'blue' };
  return { state: 'idle', label: '待命', tone: 'slate' };
}

function activityLabel(type: string | null): string {
  const labels: Record<string, string> = {
    command_execution: '正在执行任务',
    file_change: '正在更新文件',
    mcp_tool_call: '正在连接工具',
    web_search: '正在检索资料',
    reasoning: '正在处理',
    agent_message: '正在整理结果',
  };
  return (type !== null && labels[type]) || '正在推进任务';
}

function goalStatus(status: string | null): CodexTaskProgress {
  const states: Record<string, CodexTaskProgress> = {
    active: { state: 'active', label: '执行中', tone: 'blue' },
    paused: { state: 'paused', label: '已暂停', tone: 'amber' },
    blocked: { state: 'blocked', label: '受阻', tone: 'red' },
    usage_limited: { state: 'usage_limited', label: '用量受限', tone: 'amber' },
    budget_limited: { state: 'budget_limited', label: '预算已用完', tone: 'red' },
    complete: { state: 'complete', label: '已完成', tone: 'green' },
  };
  return (status !== null && states[status]) || { state: 'unknown', label: '状态未知', tone: 'slate' };
}

function formatDuration(totalSeconds: unknown): string {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes) return `${minutes} 分钟`;
  return `${seconds} 秒`;
}

function presentTask(row: TaskRow, now: number): CodexTask {
  const progress = inferProgress({
    lifecycle: row.turn_status,
    lastActivityAt: Number(row.last_activity_at ?? row.updated_at_ms ?? 0),
    queued: Number(row.queued_count ?? 0),
    now,
  });
  const goal = row.goal_id !== null && row.goal_id !== undefined
    ? {
        id: String(row.goal_id),
        objective: String(row.goal_objective ?? '').trim(),
        status: goalStatus(row.goal_status),
        elapsedSeconds: Number(row.goal_time_used_seconds ?? 0),
        elapsed: formatDuration(row.goal_time_used_seconds),
      }
    : null;
  return {
    id: String(row.id),
    title: truncate(row.name || row.title || row.preview || '未命名任务', 80),
    project: row.project_name || row.section_name || folderName(row.cwd) || '未分组',
    projectId: row.project_id ?? null,
    cwd: String(row.cwd ?? ''),
    model: row.model ?? null,
    pinned: Boolean(row.is_pinned),
    queuedCount: Number(row.queued_count ?? 0),
    progress,
    activity: progress.state === 'running' ? activityLabel(row.last_item_type) : progress.label,
    latestTask: truncate(cleanUserMessage(row.latest_user ?? '') || row.preview || row.title || '', 220),
    latestResult: truncate(row.latest_assistant ?? '', 520),
    updatedAt: Math.max(
      Number(row.recency_at_ms ?? 0),
      Number(row.updated_at_ms ?? 0),
      Number(row.last_activity_at ?? 0),
    ),
    goal,
  };
}

function parseHistoryMessage(row: MessageRow): CodexMessage | CodexQueuedMessage | null {
  try {
    const item = JSON.parse(row.item_json) as Record<string, unknown>;
    const queued = row.item_type === 'queuedMessage';
    const role: 'user' | 'assistant' = row.item_type === 'agentMessage' ? 'assistant' : 'user';
    const rawText = queued
      ? extractMessageText((item.UserInput as Record<string, unknown> | undefined)?.content)
      : role === 'assistant'
        ? String(item.text ?? '').trim()
        : extractMessageText(item.content);
    const text = role === 'user' ? cleanUserMessage(rawText) : rawText;
    if (isInternalMessage(text)) return null;
    const base: CodexMessage = {
      id: String(row.queue_item_id || item.id || `${row.created_at_ms ?? 0}-${row.item_type}`),
      role,
      text,
      timestamp: Number(row.created_at_ms ?? 0),
      pending: Boolean(row.pending),
    };
    if (!queued) return base;
    return { ...base, queueOrder: Number(row.queue_order ?? 0), queueRevision: Number(row.queue_revision ?? 0) };
  } catch {
    return null;
  }
}

function parseRolloutLines(lines: string[], maxMessages = MAX_MESSAGES): RolloutSnapshot {
  const snapshot: RolloutSnapshot = {
    lifecycle: null,
    latestUser: '',
    latestAssistant: '',
    lastActivityType: null,
    lastActivityAt: 0,
    messages: [],
  };
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp = Date.parse(String(entry.timestamp ?? '')) || 0;
    snapshot.lastActivityAt = Math.max(snapshot.lastActivityAt, timestamp);
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    if (entry.type === 'event_msg') {
      if (['task_started', 'task_complete', 'turn_aborted'].includes(String(payload.type))) {
        snapshot.lifecycle = String(payload.type);
      }
      if (payload.type === 'item_started' || payload.type === 'item_completed') {
        const item = (payload.item ?? {}) as Record<string, unknown>;
        snapshot.lastActivityType = String(item.type ?? '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      }
    }
    if (entry.type !== 'response_item' || payload.type !== 'message') continue;
    let text = extractMessageText(payload.content);
    const content = Array.isArray(payload.content) ? payload.content : [];
    const first = content[0] as Record<string, unknown> | undefined;
    const role = String(payload.role ?? first?.type ?? '');
    if (role === 'user' || role === 'input_text') {
      text = cleanUserMessage(text);
      if (isInternalMessage(text)) continue;
      snapshot.latestUser = text;
      snapshot.messages.push({ id: String(payload.id || `${timestamp}-user`), role: 'user', text, timestamp, pending: false });
    }
    if (role === 'assistant' || role === 'output_text') {
      if (isInternalMessage(text)) continue;
      snapshot.latestAssistant = text;
      snapshot.messages.push({ id: String(payload.id || `${timestamp}-assistant`), role: 'assistant', text, timestamp, pending: false });
    }
  }
  snapshot.messages = snapshot.messages.slice(-maxMessages);
  return snapshot;
}

async function readTail(filePath: string, maxBytes = ROLLOUT_TAIL_BYTES): Promise<{ text: string; mtimeMs: number }> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, stat.size - length);
    let text = buffer.toString('utf8');
    if (stat.size > length) text = text.slice(text.indexOf('\n') + 1);
    return { text, mtimeMs: stat.mtimeMs };
  } finally {
    await file.close();
  }
}

async function readRolloutSnapshot(filePath: string | null): Promise<RolloutSnapshot | null> {
  if (!filePath) return null;
  try {
    const { text, mtimeMs } = await readTail(filePath);
    const snapshot = parseRolloutLines(text.split('\n').filter(Boolean));
    if (!snapshot.lastActivityAt) snapshot.lastActivityAt = mtimeMs;
    return snapshot;
  } catch {
    return null;
  }
}

function escapeSqlitePath(value: string): string {
  return value.replaceAll("'", "''");
}

/** 根目录下找 prefix_N.sqlite 中 N 最大的文件（库文件名带版本号） */
function resolveDbFile(dir: string, prefix: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const pattern = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`);
  let best: string | null = null;
  let bestVersion = -1;
  for (const entry of entries) {
    const m = pattern.exec(entry);
    if (!m) continue;
    const version = Number(m[1]);
    if (version > bestVersion) {
      bestVersion = version;
      best = entry;
    }
  }
  return best === null ? null : path.join(dir, best);
}

function taskSignature(task: CodexTask): string {
  return `${task.id}:${task.progress.state}:${task.updatedAt}:${task.queuedCount}`;
}

/** Windows 路径归一化：strip \\?\ 前缀、统一分隔符、去尾部斜杠、小写化（大小写不敏感比较） */
export function normalizeCodexPath(value: string): string {
  let clean = String(value ?? '');
  if (clean.startsWith('\\\\?\\UNC\\')) clean = `//${clean.slice(8)}`;
  else if (clean.startsWith('\\\\?\\')) clean = clean.slice(4);
  return clean.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** thread.cwd 与项目路径相同或位于其下子目录即视为属于该项目 */
export function codexPathInProject(threadCwd: string, projectPath: string): boolean {
  const cwd = normalizeCodexPath(threadCwd);
  const project = normalizeCodexPath(projectPath);
  if (cwd === '' || project === '') return false;
  return cwd === project || cwd.startsWith(`${project}/`);
}

/**
 * 只读监视本机 Codex Desktop/CLI 任务：直接读 ~/.codex 下的 sqlite 库（readOnly，
 * 不设 WAL pragma、不写），轮询比对签名后通过 appendEvent 发射事件。
 * 库缺失/被锁时降级（attach 失败退回只查 state 库），完全不抛错，available=false。
 */
export class CodexWatchManager {
  #codexDir: string;
  #pollMs: number;
  #appendEvent: AppendEventFn;
  #resolveProjectId: (cwd: string) => string | null;
  #now: () => number;
  #timer: NodeJS.Timeout | null = null;
  #refreshChain: Promise<void> = Promise.resolve();
  #lastListSignature: string | null = null;
  #taskSignatures = new Map<string, string>();

  constructor(opts: {
    codexDir?: string;
    pollMs?: number;
    appendEvent?: AppendEventFn;
    /** 路径→SSCode 项目 ID 解析器（app.ts 注入，查 repo.projects 路径列表）；变化事件据此打 projectId */
    resolveProjectId?: (cwd: string) => string | null;
    now?: () => number;
  } = {}) {
    this.#codexDir = opts.codexDir ?? process.env.SSCODE_CODEX_DIR ?? path.join(os.homedir(), '.codex');
    this.#pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.#appendEvent = opts.appendEvent ?? (() => {});
    this.#resolveProjectId = opts.resolveProjectId ?? (() => null);
    this.#now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => { void this.refresh(); }, this.#pollMs);
    this.#timer.unref();
    void this.refresh();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** 轮询入口：扫描一次，签名变化才发射 codex.task.state / codex.task.updated */
  refresh(): Promise<void> {
    this.#refreshChain = this.#refreshChain.then(() => this.#refreshOnce());
    return this.#refreshChain;
  }

  async listTasks(): Promise<{ available: boolean; tasks: CodexTask[] }> {
    return this.#scan();
  }

  /** 项目维度：thread.cwd 与 projectPath 相同或位于其子目录（Windows 归一化、大小写不敏感） */
  async listTasksForProject(projectPath: string): Promise<{ available: boolean; tasks: CodexTask[] }> {
    const { available, tasks } = await this.#scan();
    return { available, tasks: tasks.filter((t) => codexPathInProject(t.cwd, projectPath)) };
  }

  async getTask(id: string): Promise<{ task: CodexTask; messages: CodexMessage[]; queuedTasks: CodexQueuedMessage[] } | null> {
    const stateFile = resolveDbFile(this.#codexDir, 'state');
    if (stateFile === null) return null;
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(stateFile, { readOnly: true });
    } catch {
      return null;
    }
    try {
      const full = this.#attachAux(db);
      const rows = this.#queryTasks(db, full);
      const row = rows.find((r) => String(r.id) === id);
      if (!row) return null;
      const messages = await this.#loadMessages(db, full, String(id), row.rollout_path);
      const queuedTasks = this.#loadQueuedTasks(db, full, String(id));
      return { task: presentTask(row, this.#now()), messages, queuedTasks };
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  async #refreshOnce(): Promise<void> {
    const { available, tasks } = await this.#scan();
    const listSignature = `${available}|${tasks.map(taskSignature).join('|')}`;
    if (listSignature === this.#lastListSignature) return;
    const previous = this.#taskSignatures;
    this.#lastListSignature = listSignature;
    this.#taskSignatures = new Map(tasks.map((t) => [t.id, taskSignature(t)]));
    this.#appendEvent(null, 'codex.task.state', { available, taskCount: tasks.length });
    for (const task of tasks) {
      if (previous.get(task.id) !== taskSignature(task)) {
        this.#appendEvent(this.#resolveProjectId(task.cwd), 'codex.task.updated', { task: task as unknown as Record<string, unknown> });
      }
    }
  }

  async #scan(): Promise<{ available: boolean; tasks: CodexTask[] }> {
    const stateFile = resolveDbFile(this.#codexDir, 'state');
    if (stateFile === null) return { available: false, tasks: [] };
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(stateFile, { readOnly: true });
    } catch {
      return { available: false, tasks: [] };
    }
    try {
      const full = this.#attachAux(db);
      const rows = this.#queryTasks(db, full);
      return { available: true, tasks: rows.map((row) => presentTask(row, this.#now())) };
    } catch {
      return { available: false, tasks: [] };
    } finally {
      db.close();
    }
  }

  /** 附加 queue/history/goals 库；任一失败（缺失/被锁）则整体降级为只查 state 库 */
  #attachAux(db: DatabaseSync): boolean {
    const attached: string[] = [];
    try {
      for (const spec of ATTACH_SPECS) {
        const file = resolveDbFile(this.#codexDir, spec.prefix);
        if (file === null) throw new Error(`missing ${spec.prefix} db`);
        db.exec(`ATTACH DATABASE '${escapeSqlitePath(file)}' AS ${spec.alias}`);
        attached.push(spec.alias);
      }
      return true;
    } catch {
      for (const alias of attached) {
        try {
          db.exec(`DETACH DATABASE ${alias}`);
        } catch {
          // 已部分分离则忽略
        }
      }
      return false;
    }
  }

  /** full 模式 SQL 引用附加库；附加库表缺失等错误同样降级到 BASIC_TASK_SQL */
  #queryTasks(db: DatabaseSync, full: boolean): TaskRow[] {
    if (full) {
      try {
        return db.prepare(TASK_SQL).all() as unknown as TaskRow[];
      } catch {
        // 附加库缺表等：降级只查 state 库
      }
    }
    return db.prepare(BASIC_TASK_SQL).all() as unknown as TaskRow[];
  }

  /** 消息优先读 history 库；history 缺失/查询失败回退解析 rollout JSONL 尾部 */
  async #loadMessages(db: DatabaseSync, full: boolean, threadId: string, rolloutPath: string | null): Promise<CodexMessage[]> {
    if (full) {
      try {
        const rows = db.prepare(MESSAGES_SQL).all(threadId) as unknown as MessageRow[];
        return rows
          .reverse()
          .map((row) => parseHistoryMessage(row))
          .filter((m): m is CodexMessage => m !== null)
          .slice(-MAX_MESSAGES);
      } catch {
        // 表缺失：走 rollout 回退
      }
    }
    const snapshot = await readRolloutSnapshot(rolloutPath);
    return snapshot?.messages ?? [];
  }

  #loadQueuedTasks(db: DatabaseSync, full: boolean, threadId: string): CodexQueuedMessage[] {
    if (!full) return [];
    try {
      const rows = db.prepare(QUEUED_SQL).all(threadId) as unknown as MessageRow[];
      return rows
        .map((row) => parseHistoryMessage(row))
        .filter((m): m is CodexQueuedMessage => m !== null && 'queueOrder' in m);
    } catch {
      return [];
    }
  }
}
