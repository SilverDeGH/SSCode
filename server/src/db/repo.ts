import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Approval,
  EventRecord,
  FileChangeKind,
  ModelConfig,
  Project,
  Session,
  Snapshot,
  SnapshotFile,
  Task,
  TaskState,
  ToolCall,
  ToolCallState,
  ToolName,
} from '../types.ts';
import { ERR, TASK_TRANSITIONS, TERMINAL_STATES } from '../types.ts';
import { AuthSessionsRepo, DevicesRepo, ProjectMembersRepo } from './authRepo.ts';

export class RepoError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RepoError';
    this.code = code;
  }
}

type SqlParams = (string | number | null)[];

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------- 行映射

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  is_git: number;
  created_at: number;
}

interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  created_at: number;
}

interface TaskRow {
  approval_mode: import('../types.ts').ApprovalMode;
  id: string;
  project_id: string;
  session_id: string;
  seq: number;
  state: string;
  input: string;
  summary: string | null;
  model_config_id: string | null;
  client_request_id: string;
  created_by_device_id: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

interface ToolCallRow {
  id: string;
  task_id: string;
  seq: number;
  tool: string;
  args: string;
  state: string;
  result: string | null;
  approval_id: string | null;
  created_at: number;
  ended_at: number | null;
}

interface ApprovalRow {
  id: string;
  task_id: string;
  tool_call_id: string;
  operation: string;
  params: string;
  reason: string;
  risk_summary: string;
  state: string;
  decided_at: number | null;
  note: string | null;
  requester_device_id: string | null;
  created_at: number;
}

interface EventRow {
  id: number;
  project_id: string | null;
  task_id: string | null;
  type: string;
  payload: string;
  created_at: number;
}

interface SnapshotRow {
  id: string;
  task_id: string;
  project_id: string;
  created_at: number;
  undone_at: number | null;
}

interface SnapshotFileRow {
  id: string;
  snapshot_id: string;
  path: string;
  change_kind: string;
  existed_before: number;
  before_hash: string | null;
  after_hash: string | null;
  backup_path: string | null;
}

interface ModelConfigRow {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key_ref: string;
  is_default: number;
  created_at: number;
}

function mapProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, path: r.path, isGit: r.is_git !== 0, createdAt: r.created_at };
}

function mapSession(r: SessionRow): Session {
  return { id: r.id, projectId: r.project_id, title: r.title, createdAt: r.created_at };
}

function mapTask(r: TaskRow): Task {
  return {
    id: r.id,
    projectId: r.project_id,
    sessionId: r.session_id,
    seq: r.seq,
    state: r.state as TaskState,
    approvalMode: r.approval_mode,
    input: r.input,
    summary: r.summary,
    modelConfigId: r.model_config_id,
    clientRequestId: r.client_request_id,
    createdByDeviceId: r.created_by_device_id,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function mapToolCall(r: ToolCallRow): ToolCall {
  return {
    id: r.id,
    taskId: r.task_id,
    seq: r.seq,
    tool: r.tool as ToolName,
    args: JSON.parse(r.args) as Record<string, unknown>,
    state: r.state as ToolCallState,
    result: r.result,
    approvalId: r.approval_id,
    createdAt: r.created_at,
    endedAt: r.ended_at,
  };
}

function mapApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    taskId: r.task_id,
    toolCallId: r.tool_call_id,
    operation: r.operation,
    params: JSON.parse(r.params) as Record<string, unknown>,
    reason: r.reason,
    riskSummary: r.risk_summary,
    state: r.state as Approval['state'],
    decidedAt: r.decided_at,
    note: r.note,
    requesterDeviceId: r.requester_device_id,
    createdAt: r.created_at,
  };
}

function mapEvent(r: EventRow): EventRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    taskId: r.task_id,
    type: r.type,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

function mapSnapshot(r: SnapshotRow): Snapshot {
  return {
    id: r.id,
    taskId: r.task_id,
    projectId: r.project_id,
    createdAt: r.created_at,
    undoneAt: r.undone_at,
  };
}

function mapSnapshotFile(r: SnapshotFileRow): SnapshotFile {
  return {
    id: r.id,
    snapshotId: r.snapshot_id,
    path: r.path,
    changeKind: r.change_kind as FileChangeKind,
    existedBefore: r.existed_before !== 0,
    beforeHash: r.before_hash,
    afterHash: r.after_hash,
    backupPath: r.backup_path,
  };
}

function mapModelConfig(r: ModelConfigRow): ModelConfig {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    model: r.model,
    apiKeyRef: r.api_key_ref,
    isDefault: r.is_default !== 0,
    createdAt: r.created_at,
  };
}

function insertEvent(
  db: DatabaseSync,
  projectId: string | null,
  taskId: string | null,
  type: string,
  payload: Record<string, unknown>,
): EventRecord {
  const createdAt = Date.now();
  const res = db
    .prepare('INSERT INTO events (project_id, task_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, taskId, type, JSON.stringify(payload), createdAt);
  return { id: Number(res.lastInsertRowid), projectId, taskId, type, payload, createdAt };
}

/** 解析设备名供审批事件与 API 展示；设备行不存在时返回 null（仅保留 id），已撤销设备仍返回其名字 */
function deviceNameOf(db: DatabaseSync, deviceId: string | null): string | null {
  if (deviceId === null) return null;
  const row = db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId) as
    | { name: string }
    | undefined;
  return row ? row.name : null;
}

// ---------------------------------------------------------------- projects

export interface CreateProjectInput {
  name: string;
  path: string;
  isGit: boolean;
}

class ProjectsRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(input: CreateProjectInput): Project {
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      path: input.path,
      isGit: input.isGit,
      createdAt: Date.now(),
    };
    this.#db
      .prepare('INSERT INTO projects (id, name, path, is_git, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(project.id, project.name, project.path, project.isGit ? 1 : 0, project.createdAt);
    return project;
  }

  list(): Project[] {
    const rows = this.#db
      .prepare('SELECT * FROM projects ORDER BY created_at ASC, id ASC')
      .all() as unknown as ProjectRow[];
    return rows.map(mapProject);
  }

  getById(id: string): Project | null {
    const row = this.#db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined;
    return row ? mapProject(row) : null;
  }

  getByPath(path: string): Project | null {
    const row = this.#db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as
      | ProjectRow
      | undefined;
    return row ? mapProject(row) : null;
  }

  delete(id: string): boolean {
    return inTransaction(this.#db, () => {
      const db = this.#db;
      db.prepare(
        'DELETE FROM approvals WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
      ).run(id);
      db.prepare(
        'DELETE FROM tool_calls WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
      ).run(id);
      db.prepare(
        'DELETE FROM snapshot_files WHERE snapshot_id IN (SELECT id FROM snapshots WHERE project_id = ?)',
      ).run(id);
      db.prepare('DELETE FROM snapshots WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM events WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM project_members WHERE project_id = ?').run(id);
      const res = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return Number(res.changes) > 0;
    });
  }
}

// ---------------------------------------------------------------- sessions

export interface CreateSessionInput {
  projectId: string;
  title: string;
}

class SessionsRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(input: CreateSessionInput): Session {
    const session: Session = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title,
      createdAt: Date.now(),
    };
    this.#db
      .prepare('INSERT INTO sessions (id, project_id, title, created_at) VALUES (?, ?, ?, ?)')
      .run(session.id, session.projectId, session.title, session.createdAt);
    return session;
  }

  listByProject(projectId: string): Session[] {
    const rows = this.#db
      .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at ASC, id ASC')
      .all(projectId) as unknown as SessionRow[];
    return rows.map(mapSession);
  }

  getById(id: string): Session | null {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row ? mapSession(row) : null;
  }
}

// ---------------------------------------------------------------- tasks

export interface CreateTaskInput {
  approvalMode?: import('../types.ts').ApprovalMode;
  projectId: string;
  sessionId: string;
  input: string;
  clientRequestId: string;
  modelConfigId?: string | null;
  /** 提交任务的设备 id（会话认证）；旧静态 Token 或迁移前数据为 null */
  requesterDeviceId?: string | null;
}

class TasksRepo {
  setApprovalMode(id: string, mode: import('../types.ts').ApprovalMode): Task {
    this.#db.prepare('UPDATE tasks SET approval_mode = ? WHERE id = ?').run(mode, id);
    const task = this.getById(id);
    if (!task) throw new RepoError(ERR.NOT_FOUND, 'Task not found');
    return task;
  }
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(input: CreateTaskInput): Task {
    return inTransaction(this.#db, () => {
      const seqRow = this.#db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM tasks WHERE project_id = ?')
        .get(input.projectId) as { next_seq: number };
      const task: Task = {
        id: randomUUID(),
        projectId: input.projectId,
        sessionId: input.sessionId,
        seq: seqRow.next_seq,
        state: 'queued',
        approvalMode: input.approvalMode ?? 'manual',
        input: input.input,
        summary: null,
        modelConfigId: input.modelConfigId ?? null,
        clientRequestId: input.clientRequestId,
        createdByDeviceId: input.requesterDeviceId ?? null,
        createdAt: Date.now(),
        startedAt: null,
        endedAt: null,
      };
      this.#db
        .prepare(
          'INSERT INTO tasks (id, project_id, session_id, seq, state, input, summary, model_config_id, client_request_id, created_by_device_id, created_at, started_at, ended_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          task.id,
          task.projectId,
          task.sessionId,
          task.seq,
          task.state,
          task.input,
          task.summary,
          task.modelConfigId,
          task.clientRequestId,
          task.createdByDeviceId,
          task.createdAt,
          task.startedAt,
          task.endedAt,
        );
      this.#db.prepare('UPDATE tasks SET approval_mode = ? WHERE id = ?').run(task.approvalMode!, task.id);
      insertEvent(this.#db, task.projectId, task.id, 'task.created', {
        id: task.id,
        projectId: task.projectId,
        sessionId: task.sessionId,
        input: task.input.slice(0, 500),
        state: task.state,
        approvalMode: task.approvalMode,
        createdAt: task.createdAt,
      });
      return task;
    });
  }

  getById(id: string): Task | null {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  listByProject(projectId: string): Task[] {
    const rows = this.#db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY seq ASC')
      .all(projectId) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  listBySession(sessionId: string): Task[] {
    const rows = this.#db
      .prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  findByClientRequestId(projectId: string, clientRequestId: string): Task | null {
    const row = this.#db
      .prepare('SELECT * FROM tasks WHERE project_id = ? AND client_request_id = ?')
      .get(projectId, clientRequestId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  updateState(id: string, to: TaskState): Task {
    return inTransaction(this.#db, () => {
      const current = this.getById(id);
      if (!current) {
        throw new RepoError(ERR.NOT_FOUND, `task not found: ${id}`);
      }
      if (!TASK_TRANSITIONS[current.state].includes(to)) {
        throw new RepoError(
          ERR.INVALID_STATE,
          `invalid task state transition: ${current.state} -> ${to}`,
        );
      }
      const now = Date.now();
      const startedAt =
        to === 'running' && current.startedAt === null ? now : current.startedAt;
      const endedAt = TERMINAL_STATES.includes(to) ? now : current.endedAt;
      this.#db
        .prepare('UPDATE tasks SET state = ?, started_at = ?, ended_at = ? WHERE id = ?')
        .run(to, startedAt, endedAt, id);
      insertEvent(this.#db, current.projectId, id, 'task.state', {
        taskId: id,
        from: current.state,
        to,
      });
      const updated = this.getById(id);
      if (!updated) throw new RepoError(ERR.INTERNAL, `task vanished after update: ${id}`);
      return updated;
    });
  }

  updateSummary(id: string, summary: string): Task {
    const res = this.#db.prepare('UPDATE tasks SET summary = ? WHERE id = ?').run(summary, id);
    if (Number(res.changes) === 0) {
      throw new RepoError(ERR.NOT_FOUND, `task not found: ${id}`);
    }
    const task = this.getById(id);
    if (!task) throw new RepoError(ERR.INTERNAL, `task vanished after update: ${id}`);
    return task;
  }

  updateInput(id: string, input: string): Task {
    const res = this.#db.prepare('UPDATE tasks SET input = ? WHERE id = ?').run(input, id);
    if (Number(res.changes) === 0) {
      throw new RepoError(ERR.NOT_FOUND, `task not found: ${id}`);
    }
    const task = this.getById(id);
    if (!task) throw new RepoError(ERR.INTERNAL, `task vanished after update: ${id}`);
    return task;
  }

  nextQueued(projectId: string): Task | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM tasks WHERE project_id = ? AND state = 'queued' ORDER BY seq ASC LIMIT 1",
      )
      .get(projectId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }
}

// ---------------------------------------------------------------- tool calls

export interface CreateToolCallInput {
  taskId: string;
  seq: number;
  tool: ToolName;
  args: Record<string, unknown>;
  state?: ToolCallState;
  approvalId?: string | null;
}

class ToolCallsRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(input: CreateToolCallInput): ToolCall {
    const toolCall: ToolCall = {
      id: randomUUID(),
      taskId: input.taskId,
      seq: input.seq,
      tool: input.tool,
      args: input.args,
      state: input.state ?? 'pending',
      result: null,
      approvalId: input.approvalId ?? null,
      createdAt: Date.now(),
      endedAt: null,
    };
    this.#db
      .prepare(
        'INSERT INTO tool_calls (id, task_id, seq, tool, args, state, result, approval_id, created_at, ended_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        toolCall.id,
        toolCall.taskId,
        toolCall.seq,
        toolCall.tool,
        JSON.stringify(toolCall.args),
        toolCall.state,
        toolCall.result,
        toolCall.approvalId,
        toolCall.createdAt,
        toolCall.endedAt,
      );
    return toolCall;
  }

  getById(id: string): ToolCall | null {
    const row = this.#db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as
      | ToolCallRow
      | undefined;
    return row ? mapToolCall(row) : null;
  }

  listByTask(taskId: string): ToolCall[] {
    const rows = this.#db
      .prepare('SELECT * FROM tool_calls WHERE task_id = ? ORDER BY seq ASC')
      .all(taskId) as unknown as ToolCallRow[];
    return rows.map(mapToolCall);
  }

  updateState(id: string, state: ToolCallState): ToolCall {
    const res = this.#db.prepare('UPDATE tool_calls SET state = ? WHERE id = ?').run(state, id);
    if (Number(res.changes) === 0) {
      throw new RepoError(ERR.NOT_FOUND, `tool call not found: ${id}`);
    }
    const toolCall = this.getById(id);
    if (!toolCall) throw new RepoError(ERR.INTERNAL, `tool call vanished after update: ${id}`);
    return toolCall;
  }

  updateResult(id: string, result: string): ToolCall {
    const res = this.#db
      .prepare('UPDATE tool_calls SET result = ?, ended_at = ? WHERE id = ?')
      .run(result, Date.now(), id);
    if (Number(res.changes) === 0) {
      throw new RepoError(ERR.NOT_FOUND, `tool call not found: ${id}`);
    }
    const toolCall = this.getById(id);
    if (!toolCall) throw new RepoError(ERR.INTERNAL, `tool call vanished after update: ${id}`);
    return toolCall;
  }
}

// ---------------------------------------------------------------- approvals

export interface CreateApprovalInput {
  taskId: string;
  toolCallId: string;
  operation: string;
  params: Record<string, unknown>;
  reason: string;
  riskSummary: string;
}

class ApprovalsRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(input: CreateApprovalInput): Approval {
    const taskRow = this.#db
      .prepare('SELECT project_id, created_by_device_id FROM tasks WHERE id = ?')
      .get(input.taskId) as { project_id: string; created_by_device_id: string | null } | undefined;
    if (!taskRow) {
      throw new RepoError(ERR.NOT_FOUND, `task not found: ${input.taskId}`);
    }
    const approval: Approval = {
      id: randomUUID(),
      taskId: input.taskId,
      toolCallId: input.toolCallId,
      operation: input.operation,
      params: input.params,
      reason: input.reason,
      riskSummary: input.riskSummary,
      state: 'pending',
      decidedAt: null,
      note: null,
      requesterDeviceId: taskRow.created_by_device_id,
      createdAt: Date.now(),
    };
    this.#db
      .prepare(
        'INSERT INTO approvals (id, task_id, tool_call_id, operation, params, reason, risk_summary, state, decided_at, note, requester_device_id, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        approval.id,
        approval.taskId,
        approval.toolCallId,
        approval.operation,
        JSON.stringify(approval.params),
        approval.reason,
        approval.riskSummary,
        approval.state,
        approval.decidedAt,
        approval.note,
        approval.requesterDeviceId,
        approval.createdAt,
      );
    insertEvent(this.#db, taskRow.project_id, approval.taskId, 'approval.requested', {
      approvalId: approval.id,
      taskId: approval.taskId,
      toolCallId: approval.toolCallId,
      operation: approval.operation,
      riskSummary: approval.riskSummary,
      requesterDeviceId: approval.requesterDeviceId,
      requesterDeviceName: deviceNameOf(this.#db, approval.requesterDeviceId),
    });
    return approval;
  }

  getById(id: string): Approval | null {
    const row = this.#db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalRow
      | undefined;
    return row ? mapApproval(row) : null;
  }

  pendingByTask(taskId: string): Approval[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM approvals WHERE task_id = ? AND state = 'pending' ORDER BY created_at ASC, id ASC",
      )
      .all(taskId) as unknown as ApprovalRow[];
    return rows.map(mapApproval);
  }

  decide(id: string, decision: 'approve' | 'reject', note?: string | null): Approval {
    return inTransaction(this.#db, () => {
      const current = this.getById(id);
      if (!current) {
        throw new RepoError(ERR.NOT_FOUND, `approval not found: ${id}`);
      }
      if (current.state !== 'pending') {
        return current;
      }
      const newState = decision === 'approve' ? 'approved' : 'rejected';
      const decidedAt = Date.now();
      this.#db
        .prepare('UPDATE approvals SET state = ?, decided_at = ?, note = ? WHERE id = ?')
        .run(newState, decidedAt, note ?? null, id);
      this.#db
        .prepare('UPDATE tool_calls SET state = ? WHERE id = ?')
        .run(newState, current.toolCallId);
      const taskRow = this.#db
        .prepare('SELECT project_id, created_by_device_id FROM tasks WHERE id = ?')
        .get(current.taskId) as { project_id: string } | undefined;
      insertEvent(this.#db, taskRow ? taskRow.project_id : null, current.taskId, 'approval.decided', {
        approvalId: id,
        taskId: current.taskId,
        toolCallId: current.toolCallId,
        decision: newState,
        note: note ?? null,
        requesterDeviceId: current.requesterDeviceId,
        requesterDeviceName: deviceNameOf(this.#db, current.requesterDeviceId),
      });
      const updated = this.getById(id);
      if (!updated) throw new RepoError(ERR.INTERNAL, `approval vanished after update: ${id}`);
      return updated;
    });
  }
}

// ---------------------------------------------------------------- events

class EventsRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  append(
    projectId: string | null,
    taskId: string | null,
    type: string,
    payload: Record<string, unknown>,
  ): EventRecord {
    return insertEvent(this.#db, projectId, taskId, type, payload);
  }

  listByTask(taskId: string): EventRecord[] {
    return (this.#db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id ASC').all(taskId) as unknown as EventRow[]).map(mapEvent);
  }

  listAfter(cursor: number, projectId?: string | null, limit?: number): EventRecord[] {
    let sql = 'SELECT * FROM events WHERE id > ?';
    const params: SqlParams = [cursor];
    if (projectId !== undefined && projectId !== null) {
      sql += ' AND project_id = ?';
      params.push(projectId);
    }
    sql += ' ORDER BY id ASC';
    if (limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    const rows = this.#db.prepare(sql).all(...params) as unknown as EventRow[];
    return rows.map(mapEvent);
  }
}

// ---------------------------------------------------------------- snapshots

export interface CreateSnapshotInput {
  taskId: string;
  projectId: string;
}

export interface AddSnapshotFileInput {
  snapshotId: string;
  path: string;
  changeKind: FileChangeKind;
  existedBefore: boolean;
  beforeHash?: string | null;
  afterHash?: string | null;
  backupPath?: string | null;
}

class SnapshotsRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  createSnapshot(input: CreateSnapshotInput): Snapshot {
    const snapshot: Snapshot = {
      id: randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      createdAt: Date.now(),
      undoneAt: null,
    };
    this.#db
      .prepare('INSERT INTO snapshots (id, task_id, project_id, created_at, undone_at) VALUES (?, ?, ?, ?, ?)')
      .run(snapshot.id, snapshot.taskId, snapshot.projectId, snapshot.createdAt, snapshot.undoneAt);
    return snapshot;
  }

  addFile(input: AddSnapshotFileInput): SnapshotFile {
    const file: SnapshotFile = {
      id: randomUUID(),
      snapshotId: input.snapshotId,
      path: input.path,
      changeKind: input.changeKind,
      existedBefore: input.existedBefore,
      beforeHash: input.beforeHash ?? null,
      afterHash: input.afterHash ?? null,
      backupPath: input.backupPath ?? null,
    };
    this.#db
      .prepare(
        'INSERT INTO snapshot_files (id, snapshot_id, path, change_kind, existed_before, before_hash, after_hash, backup_path) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        file.id,
        file.snapshotId,
        file.path,
        file.changeKind,
        file.existedBefore ? 1 : 0,
        file.beforeHash,
        file.afterHash,
        file.backupPath,
      );
    return file;
  }

  listFiles(snapshotId: string): SnapshotFile[] {
    const rows = this.#db
      .prepare('SELECT * FROM snapshot_files WHERE snapshot_id = ? ORDER BY path ASC')
      .all(snapshotId) as unknown as SnapshotFileRow[];
    return rows.map(mapSnapshotFile);
  }

  getByTask(taskId: string): Snapshot | null {
    const row = this.#db.prepare('SELECT * FROM snapshots WHERE task_id = ?').get(taskId) as
      | SnapshotRow
      | undefined;
    return row ? mapSnapshot(row) : null;
  }

  markUndone(id: string): Snapshot {
    const res = this.#db
      .prepare('UPDATE snapshots SET undone_at = ? WHERE id = ?')
      .run(Date.now(), id);
    if (Number(res.changes) === 0) {
      throw new RepoError(ERR.NOT_FOUND, `snapshot not found: ${id}`);
    }
    const row = this.#db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as
      | SnapshotRow
      | undefined;
    if (!row) throw new RepoError(ERR.INTERNAL, `snapshot vanished after update: ${id}`);
    return mapSnapshot(row);
  }

  updateFileAfterHash(id: string, afterHash: string | null, changeKind: string): void {
    const res = this.#db
      .prepare('UPDATE snapshot_files SET after_hash = ?, change_kind = ? WHERE id = ?')
      .run(afterHash, changeKind, id);
    if (Number(res.changes) === 0) {
      throw new RepoError(ERR.NOT_FOUND, `snapshot file not found: ${id}`);
    }
  }
}

// ---------------------------------------------------------------- model configs

export interface CreateModelConfigInput {
  name: string;
  baseUrl: string;
  model: string;
  apiKeyRef: string;
  isDefault?: boolean;
}

class ModelConfigsRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(input: CreateModelConfigInput): ModelConfig {
    return inTransaction(this.#db, () => {
      if (input.isDefault) {
        this.#db.prepare('UPDATE model_configs SET is_default = 0').run();
      }
      const config: ModelConfig = {
        id: randomUUID(),
        name: input.name,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKeyRef: input.apiKeyRef,
        isDefault: input.isDefault ?? false,
        createdAt: Date.now(),
      };
      this.#db
        .prepare(
          'INSERT INTO model_configs (id, name, base_url, model, api_key_ref, is_default, created_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          config.id,
          config.name,
          config.baseUrl,
          config.model,
          config.apiKeyRef,
          config.isDefault ? 1 : 0,
          config.createdAt,
        );
      return config;
    });
  }

  list(): ModelConfig[] {
    const rows = this.#db
      .prepare('SELECT * FROM model_configs ORDER BY created_at ASC, id ASC')
      .all() as unknown as ModelConfigRow[];
    return rows.map(mapModelConfig);
  }

  getById(id: string): ModelConfig | null {
    const row = this.#db.prepare('SELECT * FROM model_configs WHERE id = ?').get(id) as
      | ModelConfigRow
      | undefined;
    return row ? mapModelConfig(row) : null;
  }

  getDefault(): ModelConfig | null {
    const row = this.#db
      .prepare('SELECT * FROM model_configs WHERE is_default = 1 LIMIT 1')
      .get() as ModelConfigRow | undefined;
    return row ? mapModelConfig(row) : null;
  }

  setDefault(id: string): ModelConfig {
    return inTransaction(this.#db, () => {
      this.#db.prepare('UPDATE model_configs SET is_default = 0').run();
      const res = this.#db
        .prepare('UPDATE model_configs SET is_default = 1 WHERE id = ?')
        .run(id);
      if (Number(res.changes) === 0) {
        throw new RepoError(ERR.NOT_FOUND, `model config not found: ${id}`);
      }
      const config = this.getById(id);
      if (!config) throw new RepoError(ERR.INTERNAL, `model config vanished after update: ${id}`);
      return config;
    });
  }

  delete(id: string): boolean {
    const res = this.#db.prepare('DELETE FROM model_configs WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }
}

// ---------------------------------------------------------------- idempotency / kv

class IdempotencyRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(scopeKey: string): string | null {
    const row = this.#db
      .prepare('SELECT response FROM idempotency_keys WHERE key = ?')
      .get(scopeKey) as { response: string } | undefined;
    return row ? row.response : null;
  }

  set(scopeKey: string, responseJson: string): void {
    this.#db
      .prepare('INSERT OR IGNORE INTO idempotency_keys (key, response, created_at) VALUES (?, ?, ?)')
      .run(scopeKey, responseJson, Date.now());
  }
}

class KvRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM kv_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  set(key: string, value: string): void {
    this.#db
      .prepare(
        'INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
}

// ---------------------------------------------------------------- Repo 门面

export class Repo {
  readonly projects: ProjectsRepo;
  readonly sessions: SessionsRepo;
  readonly tasks: TasksRepo;
  readonly toolCalls: ToolCallsRepo;
  readonly approvals: ApprovalsRepo;
  readonly events: EventsRepo;
  readonly snapshots: SnapshotsRepo;
  readonly modelConfigs: ModelConfigsRepo;
  readonly idempotency: IdempotencyRepo;
  readonly kv: KvRepo;
  readonly devices: DevicesRepo;
  readonly authSessions: AuthSessionsRepo;
  readonly projectMembers: ProjectMembersRepo;

  constructor(db: DatabaseSync) {
    this.projects = new ProjectsRepo(db);
    this.sessions = new SessionsRepo(db);
    this.tasks = new TasksRepo(db);
    this.toolCalls = new ToolCallsRepo(db);
    this.approvals = new ApprovalsRepo(db);
    this.events = new EventsRepo(db);
    this.snapshots = new SnapshotsRepo(db);
    this.modelConfigs = new ModelConfigsRepo(db);
    this.idempotency = new IdempotencyRepo(db);
    this.kv = new KvRepo(db);
    this.devices = new DevicesRepo(db);
    this.authSessions = new AuthSessionsRepo(db);
    this.projectMembers = new ProjectMembersRepo(db);
  }
}
