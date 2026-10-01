import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import { createApiServer } from '../src/api/server.ts';
import type { ApiDeps } from '../src/api/server.ts';
import { AuthService } from '../src/api/auth.ts';
import type {
  Approval,
  ApprovalMode,
  EngineFacade,
  SubmitTaskInput,
  Task,
  UndoReport,
} from '../src/types.ts';

const LEGACY_TOKEN = 'legacy-token-for-policy-tests';
const API_KEY = 'sk-test-abcdef1234567890';

class StubEngine implements EngineFacade {
  repo: Repo;
  constructor(repo: Repo) {
    this.repo = repo;
  }

  async setApprovalMode(taskId: string, mode: ApprovalMode): Promise<Task> {
    return this.repo.tasks.setApprovalMode(taskId, mode);
  }

  async submitTask(input: SubmitTaskInput): Promise<{ task: Task; deduplicated: boolean }> {
    const task = this.repo.tasks.create({
      projectId: input.projectId,
      sessionId: input.sessionId,
      input: input.input,
      clientRequestId: input.clientRequestId,
      modelConfigId: input.modelConfigId ?? null,
    });
    return { task, deduplicated: false };
  }

  async appendMessage(taskId: string, _text: string): Promise<Task> {
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
    return this.repo.approvals.decide(approvalId, decision, note ?? null);
  }

  async undoTask(taskId: string): Promise<UndoReport> {
    this.#mustTask(taskId);
    return { taskId, snapshotId: null, results: [], hasConflict: false, caveats: [] };
  }

  #mustTask(taskId: string): Task {
    const task = this.repo.tasks.getById(taskId);
    if (task === null) throw new Error(`task not found: ${taskId}`);
    return task;
  }
}

interface Ctx {
  db: DatabaseSync;
  repo: Repo;
  server: http.Server;
  base: string;
}

async function setup(t: import('node:test').TestContext): Promise<Ctx> {
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new Repo(db);
  const deps: ApiDeps = {
    repo,
    engine: new StubEngine(repo),
    authToken: LEGACY_TOKEN,
    authService: new AuthService(repo),
    testModel: async () => ({ ok: true, detail: 'stub ok' }),
    testModelKey: async () => ({ ok: true, detail: 'stub ok' }),
    setModelKey: () => {},
    deleteModelKey: () => {},
    version: '0.0.0-test',
  };
  const server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  t.after(() => {
    server.close();
    db.close();
  });
  return { db, repo, server, base: `http://127.0.0.1:${addr.port}` };
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

async function api(
  ctx: Ctx,
  path: string,
  opts: ApiOptions = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
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

interface LinkedDevice {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  role: string;
}

async function linkDevice(ctx: Ctx, deviceName: string): Promise<LinkedDevice> {
  const res = await api(ctx, '/v1/auth/link', {
    method: 'POST',
    body: {
      deviceName,
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      apiKey: API_KEY,
    },
  });
  assert.equal(res.status, 201, `link ${deviceName} should succeed`);
  return res.json as unknown as LinkedDevice;
}

function makeProjectAndSession(repo: Repo, prefix = 'p'): { projectId: string; sessionId: string } {
  const project = repo.projects.create({
    name: 'demo',
    path: `e:/tmp/${prefix}-${Math.random()}`,
    isGit: false,
  });
  const session = repo.sessions.create({ projectId: project.id, title: 's1' });
  return { projectId: project.id, sessionId: session.id };
}

function submitTask(
  ctx: Ctx,
  token: string,
  projectId: string,
  sessionId: string,
  clientRequestId = `cr-${Math.random()}`,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return api(ctx, '/v1/tasks', {
    method: 'POST',
    token,
    headers: { 'x-client-request-id': clientRequestId },
    body: { projectId, sessionId, input: 'build it' },
  });
}

test('角色矩阵: 后续绑定设备默认 viewer，可读不可写', async (t) => {
  const ctx = await setup(t);
  const { projectId, sessionId } = makeProjectAndSession(ctx.repo);
  const owner = await linkDevice(ctx, 'owner-phone');
  const viewer = await linkDevice(ctx, 'viewer-phone');
  assert.equal(owner.role, 'owner');
  assert.equal(viewer.role, 'viewer', '第二台设备默认 viewer');

  const list = await api(ctx, '/v1/projects', { token: viewer.accessToken });
  const projects = list.json.projects as { id: string; role: string }[];
  assert.equal(projects.find((p) => p.id === projectId)?.role, 'viewer');

  const writeDenied = await submitTask(ctx, viewer.accessToken, projectId, sessionId);
  assert.equal(writeDenied.status, 403);
  assert.equal((writeDenied.json.error as { code: string }).code, 'forbidden');

  const created = await submitTask(ctx, owner.accessToken, projectId, sessionId);
  assert.equal(created.status, 201);
  const taskId = (created.json.task as { id: string }).id;

  const read = await api(ctx, `/v1/tasks/${taskId}`, { token: viewer.accessToken });
  assert.equal(read.status, 200, 'viewer 可以读取任务');

  const stopped = await api(ctx, `/v1/tasks/${taskId}/stop`, {
    method: 'POST',
    token: viewer.accessToken,
  });
  assert.equal(stopped.status, 403, 'viewer 不能停止任务');

  const sessionDenied = await api(ctx, `/v1/projects/${projectId}/sessions`, {
    method: 'POST',
    token: viewer.accessToken,
    body: { title: 'nope' },
  });
  assert.equal(sessionDenied.status, 403);

  const sessionRead = await api(ctx, `/v1/projects/${projectId}/sessions`, {
    token: viewer.accessToken,
  });
  assert.equal(sessionRead.status, 200);
});

test('成员管理: owner 可调整角色与移除，非 owner 被拒', async (t) => {
  const ctx = await setup(t);
  const { projectId, sessionId } = makeProjectAndSession(ctx.repo);
  const owner = await linkDevice(ctx, 'owner-phone');
  const viewer = await linkDevice(ctx, 'viewer-phone');

  const denied = await api(ctx, `/v1/projects/${projectId}/members`, {
    method: 'POST',
    token: viewer.accessToken,
    body: { deviceId: viewer.deviceId, role: 'operator' },
  });
  assert.equal(denied.status, 403, 'viewer 不能管理成员');

  const promoted = await api(ctx, `/v1/projects/${projectId}/members`, {
    method: 'POST',
    token: owner.accessToken,
    body: { deviceId: viewer.deviceId, role: 'operator' },
  });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.json.role, 'operator');

  const nowAllowed = await submitTask(ctx, viewer.accessToken, projectId, sessionId);
  assert.equal(nowAllowed.status, 201, 'operator 可以提交任务');

  const members = await api(ctx, `/v1/projects/${projectId}/members`, {
    token: owner.accessToken,
  });
  const memberList = members.json.members as { deviceId: string; role: string; deviceName: string }[];
  assert.deepEqual(
    memberList.map((m) => ({ deviceId: m.deviceId, role: m.role, deviceName: m.deviceName })),
    [
      { deviceId: owner.deviceId, role: 'owner', deviceName: 'owner-phone' },
      { deviceId: viewer.deviceId, role: 'operator', deviceName: 'viewer-phone' },
    ],
  );

  const removed = await api(ctx, `/v1/projects/${projectId}/members/${viewer.deviceId}`, {
    method: 'DELETE',
    token: owner.accessToken,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.removed, true);

  const gone = await api(ctx, `/v1/projects/${projectId}`, { token: viewer.accessToken });
  assert.equal(gone.status, 403, '被移除后立刻失去访问权');
});

test('审批权限: reviewer 可审批并留审计，viewer 被拒', async (t) => {
  const ctx = await setup(t);
  const { projectId, sessionId } = makeProjectAndSession(ctx.repo);
  const owner = await linkDevice(ctx, 'owner-phone');
  const reviewer = await linkDevice(ctx, 'reviewer-phone');

  const task = ctx.repo.tasks.create({
    projectId,
    sessionId,
    input: 'x',
    clientRequestId: 'cr-approval',
  });
  const toolCall = ctx.repo.toolCalls.create({
    taskId: task.id,
    seq: 1,
    tool: 'write_file',
    args: { path: 'a.ts' },
    state: 'awaiting_approval',
  });
  const approval = ctx.repo.approvals.create({
    taskId: task.id,
    toolCallId: toolCall.id,
    operation: 'write a.ts',
    params: { path: 'a.ts' },
    reason: 'test',
    riskSummary: 'low',
  });

  const viewerDenied = await api(ctx, `/v1/approvals/${approval.id}/decision`, {
    method: 'POST',
    token: reviewer.accessToken,
    body: { decision: 'approve' },
  });
  assert.equal(viewerDenied.status, 403, 'viewer 不能审批');

  await api(ctx, `/v1/projects/${projectId}/members`, {
    method: 'POST',
    token: owner.accessToken,
    body: { deviceId: reviewer.deviceId, role: 'reviewer' },
  });

  const decided = await api(ctx, `/v1/approvals/${approval.id}/decision`, {
    method: 'POST',
    token: reviewer.accessToken,
    body: { decision: 'approve' },
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.json.state, 'approved');

  const audits = ctx.repo.events
    .listAfter(0, projectId)
    .filter((e) => e.type === 'audit' && e.payload.action === 'approval.decide');
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.payload.deviceId, reviewer.deviceId, '审计需记录操作设备');
  assert.ok(!JSON.stringify(audits[0]?.payload).includes(API_KEY), '审计不得包含 API Key');
});

test('事件流: 只返回授权项目的事件，可按项目过滤', async (t) => {
  const ctx = await setup(t);
  const { projectId: projectA } = makeProjectAndSession(ctx.repo, 'pa');
  const owner = await linkDevice(ctx, 'owner-phone');
  const viewer = await linkDevice(ctx, 'viewer-phone');

  // owner 会话创建项目 B：viewer 不是成员
  const createdB = await api(ctx, '/v1/projects', {
    method: 'POST',
    token: owner.accessToken,
    body: { name: 'b', path: `e:/tmp/pb-${Math.random()}` },
  });
  assert.equal(createdB.status, 201);
  const projectB = createdB.json.id as string;

  ctx.repo.events.append(projectA, null, 'log', { tag: 'a' });
  ctx.repo.events.append(projectB, null, 'log', { tag: 'b' });

  const viewerEvents = await api(ctx, '/v1/events?after=0', { token: viewer.accessToken });
  const viewerTags = (viewerEvents.json.events as { payload: { tag: string } }[]).map(
    (e) => e.payload.tag,
  );
  assert.deepEqual(viewerTags, ['a'], 'viewer 只能看到授权项目事件');

  const deniedB = await api(ctx, `/v1/events?after=0&projectId=${projectB}`, {
    token: viewer.accessToken,
  });
  assert.equal(deniedB.status, 403);

  const ownerEvents = await api(ctx, '/v1/events?after=0', { token: owner.accessToken });
  const ownerTags = (ownerEvents.json.events as { payload: { tag?: string } }[])
    .map((e) => e.payload.tag)
    .filter((tag) => tag !== undefined);
  assert.deepEqual(ownerTags.sort(), ['a', 'b']);

  const legacyEvents = await api(ctx, '/v1/events?after=0', { token: LEGACY_TOKEN });
  const legacyTags = (legacyEvents.json.events as { payload: { tag?: string } }[])
    .map((e) => e.payload.tag)
    .filter((tag) => tag !== undefined);
  assert.deepEqual(legacyTags.sort(), ['a', 'b']);
});

test('任务创建: sessionId 必须属于 projectId，禁止跨项目挂靠', async (t) => {
  const ctx = await setup(t);
  const { projectId: projectA } = makeProjectAndSession(ctx.repo, 'pa');
  const { sessionId: sessionB } = makeProjectAndSession(ctx.repo, 'pb');
  const owner = await linkDevice(ctx, 'owner-phone');

  const mismatch = await api(ctx, '/v1/tasks', {
    method: 'POST',
    token: owner.accessToken,
    headers: { 'x-client-request-id': 'cr-mismatch' },
    body: { projectId: projectA, sessionId: sessionB, input: 'x' },
  });
  assert.equal(mismatch.status, 400);
  assert.equal((mismatch.json.error as { code: string }).code, 'validation_error');
});

test('模型 Key 管理: 非 owner 设备不能创建或更新模型配置', async (t) => {
  const ctx = await setup(t);
  makeProjectAndSession(ctx.repo);
  await linkDevice(ctx, 'owner-phone');
  const viewer = await linkDevice(ctx, 'viewer-phone');

  const denied = await api(ctx, '/v1/models', {
    method: 'POST',
    token: viewer.accessToken,
    body: {
      name: 'Other',
      baseUrl: 'https://api2.example.com/v1',
      model: 'o-1',
      apiKeyRef: 'vault:other',
    },
  });
  assert.equal(denied.status, 403, 'viewer 不能管理模型 Key');

  const listAllowed = await api(ctx, '/v1/models', { token: viewer.accessToken });
  assert.equal(listAllowed.status, 200, 'viewer 可以读取模型列表（脱敏）');
  assert.ok(!JSON.stringify(listAllowed.json).includes(API_KEY));
});
