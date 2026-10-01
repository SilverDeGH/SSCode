import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import { createApiServer } from '../src/api/server.ts';
import type { ApiDeps } from '../src/api/server.ts';
import { AuthService } from '../src/api/auth.ts';
import { TaskEngine } from '../src/engine/engine.ts';
import { SnapshotStore } from '../src/snapshot/snapshot.ts';
import { snapshotRepoAdapter } from '../src/snapshot/repoAdapter.ts';
import { SecretsStore } from '../src/ai/secrets.ts';
import { MockAdapter } from '../src/ai/mock.ts';
import type {
  Approval,
  ApprovalMode,
  EngineFacade,
  ModelAdapter,
  SubmitTaskInput,
  Task,
  TaskState,
  UndoReport,
} from '../src/types.ts';

const LEGACY_TOKEN = 'legacy-token-for-concurrency-tests';
const API_KEY = 'sk-test-1234567890abcdef';

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

async function setup(
  t: import('node:test').TestContext,
  makeEngine: (repo: Repo) => EngineFacade,
): Promise<Ctx> {
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new Repo(db);
  const deps: ApiDeps = {
    repo,
    engine: makeEngine(repo),
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

/** 真实 TaskEngine（MockAdapter 脚本化模型），用于检验引擎级并发语义 */
function realEngineFactory(
  t: import('node:test').TestContext,
  adapter: ModelAdapter,
): (repo: Repo) => EngineFacade {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-conc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return (repo) =>
    new TaskEngine({
      repo,
      snapshots: new SnapshotStore(snapshotRepoAdapter(repo), dir),
      secrets: new SecretsStore(dir),
      dataDir: dir,
      resolveAdapter: () => adapter,
    });
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
  assert.equal(res.status, 201, `link ${deviceName} should succeed: ${JSON.stringify(res.json)}`);
  return res.json as unknown as LinkedDevice;
}

interface TwoDevices {
  projectId: string;
  sessionId: string;
  d1: LinkedDevice;
  d2: LinkedDevice;
}

/** 两台设备：d1 = owner（首台绑定），d2 提升为 operator（可写可审批） */
async function twoOperatorDevices(ctx: Ctx, projectPath?: string): Promise<TwoDevices> {
  const project = ctx.repo.projects.create({
    name: 'demo',
    path: projectPath ?? `e:/tmp/p-${Math.random()}`,
    isGit: false,
  });
  const session = ctx.repo.sessions.create({ projectId: project.id, title: 's1' });
  const d1 = await linkDevice(ctx, 'Pixel 8');
  const d2 = await linkDevice(ctx, 'Galaxy S24');
  const promote = await api(ctx, `/v1/projects/${project.id}/members`, {
    method: 'POST',
    token: d1.accessToken,
    body: { deviceId: d2.deviceId, role: 'operator' },
  });
  assert.equal(promote.status, 200, 'owner 应能将 d2 提升为 operator');
  return { projectId: project.id, sessionId: session.id, d1, d2 };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待超时: ${label}`);
}

async function waitTaskState(
  repo: Repo,
  taskId: string,
  states: TaskState[],
  timeoutMs = 10000,
): Promise<Task> {
  await waitFor(() => {
    const task = repo.tasks.getById(taskId);
    return task !== null && states.includes(task.state);
  }, `任务进入 ${states.join('/')}`, timeoutMs);
  const task = repo.tasks.getById(taskId);
  assert.ok(task);
  return task;
}

test('并发提交：两设备同 X-Client-Request-Id 只创建一个任务，仅一条 task.created', async (t) => {
  const ctx = await setup(t, realEngineFactory(t, new MockAdapter([])));
  const { projectId, sessionId, d1, d2 } = await twoOperatorDevices(ctx);

  const headers = { 'x-client-request-id': 'cr-concurrent-submit' };
  const [r1, r2] = await Promise.all([
    api(ctx, '/v1/tasks', {
      method: 'POST',
      token: d1.accessToken,
      headers,
      body: { projectId, sessionId, input: 'device one' },
    }),
    api(ctx, '/v1/tasks', {
      method: 'POST',
      token: d2.accessToken,
      headers,
      body: { projectId, sessionId, input: 'device two' },
    }),
  ]);

  assert.deepEqual(
    [r1.status, r2.status].sort(),
    [200, 201],
    '一个创建（201），另一个幂等命中（200）',
  );
  const id1 = (r1.json.task as { id: string }).id;
  const id2 = (r2.json.task as { id: string }).id;
  assert.equal(id1, id2, '两个响应必须引用同一任务');
  assert.equal(ctx.repo.tasks.listByProject(projectId).length, 1, '只创建一个任务');

  const createdEvents = ctx.repo.events
    .listAfter(0, projectId)
    .filter((e) => e.type === 'task.created');
  assert.equal(createdEvents.length, 1, '去重路径不得重复发出 task.created');
  assert.equal((createdEvents[0]!.payload as { id: string }).id, id1);

  // 让 MockAdapter 跑完，避免测试结束后仍有后台任务
  await waitTaskState(ctx.repo, id1, ['completed']);
});

test('并发停止：两设备同时停止运行中任务，均 200 且只停止一次', async (t) => {
  const adapter = new MockAdapter([
    { toolCalls: [{ name: 'run_command', args: { command: 'node -e "setTimeout(()=>{},60000)"' } }] },
  ]);
  const ctx = await setup(t, realEngineFactory(t, adapter));
  // 真实项目目录：run_command 需要在其中 spawn，否则子进程立即退出、running 状态一闪而过
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-conc-proj-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const { projectId, sessionId, d1, d2 } = await twoOperatorDevices(ctx, projectRoot);

  const submitted = await api(ctx, '/v1/tasks', {
    method: 'POST',
    token: d1.accessToken,
    headers: { 'x-client-request-id': 'cr-concurrent-stop' },
    body: { projectId, sessionId, input: 'long running task' },
  });
  assert.equal(submitted.status, 201);
  const taskId = (submitted.json.task as { id: string }).id;
  await waitFor(
    () => ctx.repo.toolCalls.listByTask(taskId).some((tc) => tc.state === 'running'),
    '工具调用进入 running',
    15000,
  );

  const [s1, s2] = await Promise.all([
    api(ctx, `/v1/tasks/${taskId}/stop`, { method: 'POST', token: d1.accessToken }),
    api(ctx, `/v1/tasks/${taskId}/stop`, { method: 'POST', token: d2.accessToken }),
  ]);
  assert.equal(s1.status, 200, `d1 停止应成功: ${JSON.stringify(s1.json)}`);
  assert.equal(s2.status, 200, `d2 并发停止应幂等成功: ${JSON.stringify(s2.json)}`);

  const stopped = await waitTaskState(ctx.repo, taskId, ['stopped'], 15000);
  assert.equal(stopped.state, 'stopped');

  const stateEvents = ctx.repo.events
    .listAfter(0, projectId)
    .filter((e) => e.type === 'task.state');
  assert.equal(
    stateEvents.filter((e) => e.payload.to === 'stopping').length,
    1,
    'running -> stopping 只发生一次',
  );
  assert.equal(stateEvents.filter((e) => e.payload.to === 'stopped').length, 1);

  // 终态重复停止：幂等 200 而非 409
  const again = await api(ctx, `/v1/tasks/${taskId}/stop`, { method: 'POST', token: d2.accessToken });
  assert.equal(again.status, 200);
  assert.equal(again.json.state, 'stopped');
});

test('并发审批：approve+reject 同时到达，决定只生效一次且响应一致', async (t) => {
  const ctx = await setup(t, (repo) => new StubEngine(repo));
  const { projectId, sessionId, d1, d2 } = await twoOperatorDevices(ctx);

  const task = ctx.repo.tasks.create({
    projectId,
    sessionId,
    input: 'x',
    clientRequestId: 'cr-concurrent-approval',
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

  const [r1, r2] = await Promise.all([
    api(ctx, `/v1/approvals/${approval.id}/decision`, {
      method: 'POST',
      token: d1.accessToken,
      body: { decision: 'approve' },
    }),
    api(ctx, `/v1/approvals/${approval.id}/decision`, {
      method: 'POST',
      token: d2.accessToken,
      body: { decision: 'reject' },
    }),
  ]);

  assert.equal(r1.status, 200, `d1 决定应成功: ${JSON.stringify(r1.json)}`);
  assert.equal(r2.status, 200, `d2 并发决定应幂等成功: ${JSON.stringify(r2.json)}`);
  assert.ok(
    r1.json.state === 'approved' || r1.json.state === 'rejected',
    '响应应携带最终决定状态',
  );
  assert.equal(r2.json.state, r1.json.state, '两个响应必须反映同一已决定状态');

  const final = ctx.repo.approvals.getById(approval.id);
  assert.equal(final?.state, r1.json.state, '数据库最终状态与响应一致');

  const decidedEvents = ctx.repo.events
    .listAfter(0, projectId)
    .filter((e) => e.type === 'approval.decided');
  assert.equal(decidedEvents.length, 1, '审批只决定一次');
});

test('并发轮换：同一 refresh token 并行刷新，一个成功一个 401', async (t) => {
  const ctx = await setup(t, (repo) => new StubEngine(repo));
  const linked = await linkDevice(ctx, 'Pixel 8');

  const [r1, r2] = await Promise.all([
    api(ctx, '/v1/auth/refresh', { method: 'POST', body: { refreshToken: linked.refreshToken } }),
    api(ctx, '/v1/auth/refresh', { method: 'POST', body: { refreshToken: linked.refreshToken } }),
  ]);

  assert.deepEqual(
    [r1.status, r2.status].sort(),
    [200, 401],
    '轮换重用保护：恰好一个请求成功，另一个 401',
  );
  const winner = r1.status === 200 ? r1 : r2;
  const rotated = winner.json as { accessToken: string; refreshToken: string };
  assert.notEqual(rotated.refreshToken, linked.refreshToken);
  const me = await api(ctx, '/v1/auth/me', { token: rotated.accessToken });
  assert.equal(me.status, 200, '新 access token 应可用');
});
