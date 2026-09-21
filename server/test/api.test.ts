import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import { createApiServer } from '../src/api/server.ts';
import type { ApiDeps } from '../src/api/server.ts';
import { issueAuthToken } from '../src/api/auth.ts';
import type {
  Approval,
  EngineFacade,
  SubmitTaskInput,
  Task,
  UndoReport,
} from '../src/types.ts';

const TOKEN = 'test-token-0123456789';
const VERSION = '0.1.0-test';

class StubEngine implements EngineFacade {
  async setApprovalMode(taskId: string, mode: import('../src/types.ts').ApprovalMode): Promise<Task> {
    return this.repo.tasks.setApprovalMode(taskId, mode);
  }
  repo: Repo;
  submitCalls: SubmitTaskInput[] = [];
  decideCalls: { approvalId: string; decision: 'approve' | 'reject'; note?: string }[] = [];
  appended: { taskId: string; text: string }[] = [];

  constructor(repo: Repo) {
    this.repo = repo;
  }

  #mustTask(taskId: string): Task {
    const task = this.repo.tasks.getById(taskId);
    if (task === null) {
      const err = new Error(`task not found: ${taskId}`);
      (err as { code?: string }).code = 'not_found';
      throw err;
    }
    return task;
  }

  async submitTask(input: SubmitTaskInput): Promise<{ task: Task; deduplicated: boolean }> {
    this.submitCalls.push(input);
    const task = this.repo.tasks.create({
      projectId: input.projectId,
      sessionId: input.sessionId,
      input: input.input,
      clientRequestId: input.clientRequestId,
      modelConfigId: input.modelConfigId ?? null,
    });
    return { task, deduplicated: false };
  }

  async appendMessage(taskId: string, text: string): Promise<Task> {
    this.appended.push({ taskId, text });
    return this.#mustTask(taskId);
  }

  async answerTask(taskId: string, _text: string): Promise<Task> {
    return this.#mustTask(taskId);
  }

  async stopTask(taskId: string): Promise<Task> {
    return this.#mustTask(taskId);
  }

  async cancelQueued(taskId: string): Promise<Task> {
    return this.#mustTask(taskId);
  }

  async resumeInterrupted(taskId: string): Promise<Task> {
    return this.#mustTask(taskId);
  }

  async decideApproval(
    approvalId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ): Promise<Approval> {
    this.decideCalls.push(note !== undefined ? { approvalId, decision, note } : { approvalId, decision });
    return this.repo.approvals.decide(approvalId, decision, note ?? null);
  }

  async undoTask(taskId: string): Promise<UndoReport> {
    this.#mustTask(taskId);
    return { taskId, snapshotId: null, results: [], hasConflict: false, caveats: [] };
  }
}

interface Ctx {
  db: DatabaseSync;
  repo: Repo;
  engine: StubEngine;
  server: http.Server;
  base: string;
}

async function setup(t: import('node:test').TestContext): Promise<Ctx> {
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new Repo(db);
  const engine = new StubEngine(repo);
  const deps: ApiDeps = {
    repo,
    engine,
    authToken: TOKEN,
    testModel: async (configId) => ({ ok: true, detail: `stub ok for ${configId}` }),
    setModelKey: () => {},
    deleteModelKey: () => {},
    version: VERSION,
    terminalBackend: 'spawn',
  };
  const server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  t.after(() => {
    server.close();
    db.close();
  });
  return { db, repo, engine, server, base: `http://127.0.0.1:${addr.port}` };
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  token?: string | null;
  headers?: Record<string, string>;
}

async function api(
  ctx: Ctx,
  path: string,
  opts: ApiOptions = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== null) headers['authorization'] = `Bearer ${opts.token ?? TOKEN}`;
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers['content-type'] = 'application/json';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${ctx.base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

function makeProjectAndSession(repo: Repo): { projectId: string; sessionId: string } {
  const project = repo.projects.create({
    name: 'demo',
    path: `e:/tmp/p-${Math.random()}`,
    isGit: false,
  });
  const session = repo.sessions.create({ projectId: project.id, title: 's1' });
  return { projectId: project.id, sessionId: session.id };
}

test('auth: missing/wrong token -> 401, health is unauthenticated with version', async (t) => {
  const ctx = await setup(t);

  const noToken = await api(ctx, '/v1/projects', { token: null });
  assert.equal(noToken.status, 401);
  assert.equal((noToken.json.error as { code: string }).code, 'unauthorized');

  const wrongToken = await api(ctx, '/v1/projects', { token: 'nope' });
  assert.equal(wrongToken.status, 401);

  const healthNoAuth = await fetch(`${ctx.base}/v1/health`);
  assert.equal(healthNoAuth.status, 200);
  const health = (await healthNoAuth.json()) as {
    version: string; name: string; platform: string; terminalBackend: string | null;
    capabilities: string[];
  };
  assert.equal(health.version, VERSION);
  assert.equal(health.name, 'sscode-server');
  assert.equal(health.platform, process.platform);
  assert.ok(health.terminalBackend !== null, 'terminalBackend 应上报');
  assert.ok(health.capabilities.includes('host-platform'));

  const ok = await api(ctx, '/v1/projects');
  assert.equal(ok.status, 200);
});

test('auth: issueAuthToken persists and reuses token in kv', async (t) => {
  const ctx = await setup(t);
  const t1 = issueAuthToken(ctx.repo);
  const t2 = issueAuthToken(ctx.repo);
  assert.equal(t1, t2);
  assert.match(t1, /^[0-9a-f]{64}$/);
  assert.equal(ctx.repo.kv.get('auth_token'), t1);
});

test('projects: create -> list -> detail -> delete, duplicate path -> 409', async (t) => {
  const ctx = await setup(t);

  const created = await api(ctx, '/v1/projects', {
    method: 'POST',
    body: { name: 'web', path: '.' },
  });
  assert.equal(created.status, 201);
  const project = created.json as { id: string; path: string };
  assert.ok(project.path.length > 1, 'path should be resolved to absolute');

  const dup = await api(ctx, '/v1/projects', {
    method: 'POST',
    body: { name: 'web2', path: '.' },
  });
  assert.equal(dup.status, 409);
  assert.equal((dup.json.error as { code: string }).code, 'conflict');

  const list = await api(ctx, '/v1/projects');
  assert.equal(list.status, 200);
  const projects = list.json.projects as { id: string; tasks: { running: number; queued: number } }[];
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0]?.tasks, { running: 0, queued: 0 });

  const detail = await api(ctx, `/v1/projects/${project.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.sessionCount, 0);

  const session = await api(ctx, `/v1/projects/${project.id}/sessions`, {
    method: 'POST',
    body: { title: 'first' },
  });
  assert.equal(session.status, 201);

  const sessions = await api(ctx, `/v1/projects/${project.id}/sessions`);
  assert.equal((sessions.json.sessions as unknown[]).length, 1);

  const detail2 = await api(ctx, `/v1/projects/${project.id}`);
  assert.equal(detail2.json.sessionCount, 1);

  const del = await api(ctx, `/v1/projects/${project.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const gone = await api(ctx, `/v1/projects/${project.id}`);
  assert.equal(gone.status, 404);
});

test('tasks: idempotent submit via X-Client-Request-Id, missing header -> 400', async (t) => {
  const ctx = await setup(t);
  const { projectId, sessionId } = makeProjectAndSession(ctx.repo);

  const missingHeader = await api(ctx, '/v1/tasks', {
    method: 'POST',
    body: { projectId, sessionId, input: 'build it' },
  });
  assert.equal(missingHeader.status, 400);
  assert.equal((missingHeader.json.error as { code: string }).code, 'validation_error');

  const headers = { 'x-client-request-id': 'cr-123' };
  const first = await api(ctx, '/v1/tasks', {
    method: 'POST',
    headers,
    body: { projectId, sessionId, input: 'build it' },
  });
  assert.equal(first.status, 201);
  assert.equal(first.json.deduplicated, false);

  const second = await api(ctx, '/v1/tasks', {
    method: 'POST',
    headers,
    body: { projectId, sessionId, input: 'build it' },
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.deduplicated, true);
  assert.equal(ctx.engine.submitCalls.length, 1);
  const firstTask = first.json.task as { id: string };
  const secondTask = second.json.task as { id: string };
  assert.equal(secondTask.id, firstTask.id);

  const byProject = await api(ctx, `/v1/tasks?projectId=${projectId}`);
  assert.equal(byProject.status, 200);
  assert.equal((byProject.json.tasks as unknown[]).length, 1);

  const detail = await api(ctx, `/v1/tasks/${firstTask.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.toolCalls, []);
  assert.deepEqual(detail.json.pendingApprovals, []);

  const changes = await api(ctx, `/v1/tasks/${firstTask.id}/changes`);
  assert.equal(changes.status, 200);
  assert.deepEqual(changes.json.files, []);

  const appended = await api(ctx, `/v1/tasks/${firstTask.id}/messages`, {
    method: 'POST',
    body: { text: 'also add tests' },
  });
  assert.equal(appended.status, 200);
  assert.deepEqual(ctx.engine.appended, [{ taskId: firstTask.id, text: 'also add tests' }]);
});

test('events: cursor-based full and incremental fetch', async (t) => {
  const ctx = await setup(t);
  const { projectId } = makeProjectAndSession(ctx.repo);
  const e1 = ctx.repo.events.append(projectId, null, 'log', { n: 1 });
  const e2 = ctx.repo.events.append(projectId, null, 'log', { n: 2 });
  ctx.repo.events.append(projectId, null, 'log', { n: 3 });

  const full = await api(ctx, '/v1/events?after=0');
  assert.equal(full.status, 200);
  const events = full.json.events as { id: number }[];
  assert.equal(events.length, 3);
  assert.equal(full.json.cursor, events[events.length - 1]?.id);

  const incremental = await api(ctx, `/v1/events?after=${e2.id}&projectId=${projectId}`);
  const incEvents = incremental.json.events as { id: number; payload: { n: number } }[];
  assert.equal(incEvents.length, 1);
  assert.equal(incEvents[0]?.payload.n, 3);

  const otherProject = await api(ctx, `/v1/events?after=0&projectId=no-such-project`);
  assert.equal((otherProject.json.events as unknown[]).length, 0);
  assert.equal(otherProject.json.cursor, 0);

  assert.ok(e1.id < e2.id);
});

test('approvals: decision routes to engine.decideApproval and returns approval JSON', async (t) => {
  const ctx = await setup(t);
  const { projectId, sessionId } = makeProjectAndSession(ctx.repo);
  const task = ctx.repo.tasks.create({
    projectId,
    sessionId,
    input: 'x',
    clientRequestId: 'cr-a',
  });
  const toolCall = ctx.repo.toolCalls.create({
    taskId: task.id,
    seq: 1,
    tool: 'write_file',
    args: { path: 'a.ts' },
  });
  const approval = ctx.repo.approvals.create({
    taskId: task.id,
    toolCallId: toolCall.id,
    operation: 'write a.ts',
    params: { path: 'a.ts' },
    reason: 'test',
    riskSummary: 'low',
  });

  const badDecision = await api(ctx, `/v1/approvals/${approval.id}/decision`, {
    method: 'POST',
    body: { decision: 'maybe' },
  });
  assert.equal(badDecision.status, 400);

  const res = await api(ctx, `/v1/approvals/${approval.id}/decision`, {
    method: 'POST',
    body: { decision: 'reject', note: 'do it differently' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.id, approval.id);
  assert.equal(res.json.state, 'rejected');
  assert.equal(res.json.note, 'do it differently');
  assert.deepEqual(ctx.engine.decideCalls, [
    { approvalId: approval.id, decision: 'reject', note: 'do it differently' },
  ]);
});

test('models: CRUD + setDefault + test route', async (t) => {
  const ctx = await setup(t);

  const created = await api(ctx, '/v1/models', {
    method: 'POST',
    body: {
      name: 'Kimi',
      baseUrl: 'https://api.example.com/v1',
      model: 'kimi-k2',
      apiKeyRef: 'vault:kimi',
    },
  });
  assert.equal(created.status, 201);
  const model = created.json as { id: string; isDefault: boolean };
  assert.equal(model.isDefault, false);

  const second = await api(ctx, '/v1/models', {
    method: 'POST',
    body: {
      name: 'Other',
      baseUrl: 'https://api2.example.com/v1',
      model: 'o-1',
      apiKeyRef: 'vault:other',
    },
  });
  const secondModel = second.json as { id: string };

  const list = await api(ctx, '/v1/models');
  const models = list.json.models as Record<string, unknown>[];
  assert.equal(models.length, 2);
  assert.ok(!('apiKey' in (models[0] ?? {})), 'response must not contain raw apiKey');

  const setDef = await api(ctx, `/v1/models/${secondModel.id}/default`, { method: 'POST' });
  assert.equal(setDef.status, 200);
  assert.equal(setDef.json.isDefault, true);

  const listAfter = await api(ctx, '/v1/models');
  const flags = (listAfter.json.models as { id: string; isDefault: boolean }[]).map(
    (m) => m.isDefault,
  );
  assert.deepEqual(flags.filter(Boolean).length, 1);

  const testRes = await api(ctx, `/v1/models/${model.id}/test`, { method: 'POST' });
  assert.equal(testRes.status, 200);
  assert.equal(testRes.json.ok, true);

  const missingTest = await api(ctx, '/v1/models/no-such/test', { method: 'POST' });
  assert.equal(missingTest.status, 404);

  const del = await api(ctx, `/v1/models/${model.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const delAgain = await api(ctx, `/v1/models/${model.id}`, { method: 'DELETE' });
  assert.equal(delAgain.status, 404);

  const badDefault = await api(ctx, '/v1/models/no-such/default', { method: 'POST' });
  assert.equal(badDefault.status, 404);
});

test('misc: invalid JSON -> 400 validation_error, unknown route -> 404', async (t) => {
  const ctx = await setup(t);

  const badJson = await api(ctx, '/v1/projects', {
    method: 'POST',
    rawBody: '{not json',
  });
  assert.equal(badJson.status, 400);
  assert.equal((badJson.json.error as { code: string }).code, 'validation_error');

  const missingField = await api(ctx, '/v1/projects', {
    method: 'POST',
    body: { name: 'x' },
  });
  assert.equal(missingField.status, 400);
  assert.equal((missingField.json.error as { code: string }).code, 'validation_error');

  const unknown = await api(ctx, '/v1/nope');
  assert.equal(unknown.status, 404);
  assert.equal((unknown.json.error as { code: string }).code, 'not_found');
});
