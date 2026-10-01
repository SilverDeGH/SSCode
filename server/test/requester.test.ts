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

const LEGACY_TOKEN = 'legacy-token-for-requester-tests';
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
      requesterDeviceId: input.requesterDeviceId ?? null,
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

async function api(
  ctx: Ctx,
  path: string,
  opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
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

function makeProjectAndSession(repo: Repo): { projectId: string; sessionId: string } {
  const project = repo.projects.create({
    name: 'demo',
    path: `e:/tmp/p-${Math.random()}`,
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

function makeApproval(ctx: Ctx, taskId: string): Approval {
  const toolCall = ctx.repo.toolCalls.create({
    taskId,
    seq: 1,
    tool: 'write_file',
    args: { path: 'a.ts' },
    state: 'awaiting_approval',
  });
  return ctx.repo.approvals.create({
    taskId,
    toolCallId: toolCall.id,
    operation: 'write a.ts',
    params: { path: 'a.ts' },
    reason: 'test',
    riskSummary: 'low',
  });
}

test('发起设备: 会话设备提交任务，审批事件与审批 JSON 携带设备 id 与设备名', async (t) => {
  const ctx = await setup(t);
  const { projectId, sessionId } = makeProjectAndSession(ctx.repo);
  const owner = await linkDevice(ctx, 'Pixel 8');

  const created = await submitTask(ctx, owner.accessToken, projectId, sessionId);
  assert.equal(created.status, 201);
  const taskId = (created.json.task as { id: string }).id;
  assert.equal(
    ctx.repo.tasks.getById(taskId)?.createdByDeviceId,
    owner.deviceId,
    '任务应记录提交设备',
  );

  const approval = makeApproval(ctx, taskId);
  assert.equal(approval.requesterDeviceId, owner.deviceId, '审批应继承任务的发起设备');

  const requested = ctx.repo.events
    .listAfter(0, projectId)
    .filter((e) => e.type === 'approval.requested');
  assert.equal(requested.length, 1);
  assert.equal(requested[0]?.payload.requesterDeviceId, owner.deviceId);
  assert.equal(requested[0]?.payload.requesterDeviceName, 'Pixel 8');

  const detail = await api(ctx, `/v1/tasks/${taskId}`, { token: owner.accessToken });
  assert.equal(detail.status, 200);
  const pending = detail.json.pendingApprovals as Record<string, unknown>[];
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.requesterDeviceId, owner.deviceId);
  assert.equal(pending[0]?.requesterDeviceName, 'Pixel 8');

  const decided = await api(ctx, `/v1/approvals/${approval.id}/decision`, {
    method: 'POST',
    token: owner.accessToken,
    body: { decision: 'approve' },
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.json.requesterDeviceId, owner.deviceId);
  assert.equal(decided.json.requesterDeviceName, 'Pixel 8');

  const decidedEvents = ctx.repo.events
    .listAfter(0, projectId)
    .filter((e) => e.type === 'approval.decided');
  assert.equal(decidedEvents.length, 1);
  assert.equal(decidedEvents[0]?.payload.requesterDeviceId, owner.deviceId);
  assert.equal(decidedEvents[0]?.payload.requesterDeviceName, 'Pixel 8');
});

test('发起设备: 旧本地管理员 Token 提交的任务与审批，设备字段为 null', async (t) => {
  const ctx = await setup(t);
  const { projectId, sessionId } = makeProjectAndSession(ctx.repo);

  const created = await submitTask(ctx, LEGACY_TOKEN, projectId, sessionId);
  assert.equal(created.status, 201);
  const taskId = (created.json.task as { id: string }).id;
  assert.equal(ctx.repo.tasks.getById(taskId)?.createdByDeviceId, null);

  const approval = makeApproval(ctx, taskId);
  assert.equal(approval.requesterDeviceId, null);

  const requested = ctx.repo.events
    .listAfter(0, projectId)
    .filter((e) => e.type === 'approval.requested');
  assert.equal(requested.length, 1);
  assert.equal(requested[0]?.payload.requesterDeviceId, null);
  assert.equal(requested[0]?.payload.requesterDeviceName, null);

  const detail = await api(ctx, `/v1/tasks/${taskId}`, { token: LEGACY_TOKEN });
  const pending = detail.json.pendingApprovals as Record<string, unknown>[];
  assert.equal(pending[0]?.requesterDeviceId, null);
  assert.equal(pending[0]?.requesterDeviceName, null);
});

test('发起设备: 设备被撤销后审批仍返回 id 与名字；设备行缺失时名字为 null', async (t) => {
  const ctx = await setup(t);
  const { projectId, sessionId } = makeProjectAndSession(ctx.repo);
  const owner = await linkDevice(ctx, 'Pixel 8');

  const created = await submitTask(ctx, owner.accessToken, projectId, sessionId);
  const taskId = (created.json.task as { id: string }).id;
  const revokedApproval = makeApproval(ctx, taskId);
  ctx.repo.devices.revoke(owner.deviceId, Date.now());

  const detail = await api(ctx, `/v1/tasks/${taskId}`, { token: LEGACY_TOKEN });
  const pending = detail.json.pendingApprovals as Record<string, unknown>[];
  const revoked = pending.find((a) => a.id === revokedApproval.id);
  assert.equal(revoked?.requesterDeviceId, owner.deviceId, '设备撤销后仍返回 id');
  assert.equal(revoked?.requesterDeviceName, 'Pixel 8', '设备行仍在，保留名字');

  // 设备行被物理删除（绕过 revoke）：名字解析为 null，id 保留
  const orphanApproval = makeApproval(ctx, taskId);
  ctx.db.prepare('DELETE FROM project_members WHERE device_id = ?').run(owner.deviceId);
  ctx.db.prepare('DELETE FROM auth_sessions WHERE device_id = ?').run(owner.deviceId);
  ctx.db.prepare('DELETE FROM devices WHERE id = ?').run(owner.deviceId);
  const detail2 = await api(ctx, `/v1/tasks/${taskId}`, { token: LEGACY_TOKEN });
  const pending2 = detail2.json.pendingApprovals as Record<string, unknown>[];
  const orphan = pending2.find((a) => a.id === orphanApproval.id);
  assert.equal(orphan?.requesterDeviceId, owner.deviceId);
  assert.equal(orphan?.requesterDeviceName, null, '设备行缺失时名字为 null');
});
