import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import { createApiServer } from '../src/api/server.ts';
import type { ApiDeps, RateLimiters } from '../src/api/server.ts';
import { AuthService } from '../src/api/auth.ts';
import { RateLimiter } from '../src/api/rateLimit.ts';
import type {
  Approval,
  ApprovalMode,
  EngineFacade,
  SubmitTaskInput,
  Task,
  UndoReport,
} from '../src/types.ts';

const LEGACY_TOKEN = 'legacy-token-for-auth-tests';
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
  keyStore: Map<string, string>;
}

async function setup(
  t: import('node:test').TestContext,
  opts: { testKeyOk?: boolean; rateLimiters?: RateLimiters } = {},
): Promise<Ctx> {
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new Repo(db);
  const keyStore = new Map<string, string>();
  const testKeyOk = opts.testKeyOk ?? true;
  const deps: ApiDeps = {
    repo,
    engine: new StubEngine(repo),
    authToken: LEGACY_TOKEN,
    authService: new AuthService(repo),
    testModel: async () => ({ ok: true, detail: 'stub ok' }),
    testModelKey: async ({ apiKey }) =>
      testKeyOk
        ? { ok: true, detail: 'stub ok' }
        : { ok: false, detail: `provider rejected key ${apiKey}` },
    setModelKey: (ref, key) => {
      keyStore.set(ref, key);
    },
    deleteModelKey: (ref) => {
      keyStore.delete(ref);
    },
    version: '0.0.0-test',
    ...(opts.rateLimiters !== undefined ? { rateLimiters: opts.rateLimiters } : {}),
  };
  const server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  t.after(() => {
    server.close();
    db.close();
  });
  return { db, repo, server, base: `http://127.0.0.1:${addr.port}`, keyStore };
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
}

async function api(
  ctx: Ctx,
  path: string,
  opts: ApiOptions = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== undefined && opts.token !== null) {
    headers['authorization'] = `Bearer ${opts.token}`;
  }
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

function linkBody(deviceName: string): Record<string, unknown> {
  return {
    deviceName,
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5',
    apiKey: API_KEY,
  };
}

interface LinkedDevice {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  role: string;
}

async function linkDevice(ctx: Ctx, deviceName: string): Promise<LinkedDevice> {
  const res = await api(ctx, '/v1/auth/link', { method: 'POST', body: linkBody(deviceName) });
  assert.equal(res.status, 201, `link ${deviceName} should succeed: ${JSON.stringify(res.json)}`);
  return res.json as unknown as LinkedDevice;
}

test('link: 首次绑定成功签发会话，响应与存储不泄露 API Key', async (t) => {
  const ctx = await setup(t);
  const project = ctx.repo.projects.create({ name: 'demo', path: `e:/tmp/p-${Math.random()}`, isGit: false });

  const res = await api(ctx, '/v1/auth/link', { method: 'POST', body: linkBody('Pixel 8') });
  assert.equal(res.status, 201);
  const linked = res.json as unknown as LinkedDevice & { modelConfig: { id: string; apiKeyRef: string } };
  assert.ok(linked.deviceId.length > 0);
  assert.ok(linked.accessToken.length > 0);
  assert.ok(linked.refreshToken.length > 0);
  assert.equal(linked.role, 'owner', '首台绑定设备应成为现有项目 owner');
  assert.ok(!JSON.stringify(res.json).includes(API_KEY), '响应不得包含 API Key');
  assert.equal(ctx.keyStore.size, 1);
  assert.ok([...ctx.keyStore.values()].includes(API_KEY), 'Key 只进受保护存储');

  const me = await api(ctx, '/v1/auth/me', { token: linked.accessToken });
  assert.equal(me.status, 200);
  const device = me.json.device as { name: string };
  assert.equal(device.name, 'Pixel 8');
  const memberships = me.json.memberships as { projectId: string; role: string }[];
  assert.deepEqual(
    memberships.map((m) => ({ projectId: m.projectId, role: m.role })),
    [{ projectId: project.id, role: 'owner' }],
  );

  const projects = await api(ctx, '/v1/projects', { token: linked.accessToken });
  assert.equal(projects.status, 200);
  const list = projects.json.projects as { id: string; role: string }[];
  assert.equal(list.length, 1);
  assert.equal(list[0]?.role, 'owner');
});

test('link: 连接测试失败 -> 400，不落库不建设备，错误信息脱敏', async (t) => {
  const ctx = await setup(t, { testKeyOk: false });

  const res = await api(ctx, '/v1/auth/link', { method: 'POST', body: linkBody('Pixel 8') });
  assert.equal(res.status, 400);
  const error = res.json.error as { code: string; message: string };
  assert.equal(error.code, 'validation_error');
  assert.ok(!error.message.includes(API_KEY), '错误信息不得包含 API Key');

  assert.equal(ctx.repo.devices.list().length, 0);
  assert.equal(ctx.repo.modelConfigs.list().length, 0);
  assert.equal(ctx.keyStore.size, 0, '验证失败不得保存 Key');
});

test('link: 字段校验（非法 baseUrl / 过短 apiKey） -> 400', async (t) => {
  const ctx = await setup(t);

  const badUrl = await api(ctx, '/v1/auth/link', {
    method: 'POST',
    body: { ...linkBody('d1'), baseUrl: 'ftp://example.com' },
  });
  assert.equal(badUrl.status, 400);

  const shortKey = await api(ctx, '/v1/auth/link', {
    method: 'POST',
    body: { ...linkBody('d1'), apiKey: 'sk-1' },
  });
  assert.equal(shortKey.status, 400);
  assert.equal(ctx.repo.devices.list().length, 0);
});

test('refresh: 轮换成功且旧 refresh token 立即失效', async (t) => {
  const ctx = await setup(t);
  const linked = await linkDevice(ctx, 'Pixel 8');

  const refreshed = await api(ctx, '/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: linked.refreshToken },
  });
  assert.equal(refreshed.status, 200);
  const rotated = refreshed.json as { accessToken: string; refreshToken: string };
  assert.notEqual(rotated.refreshToken, linked.refreshToken);
  assert.notEqual(rotated.accessToken, linked.accessToken);

  const reuseOld = await api(ctx, '/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: linked.refreshToken },
  });
  assert.equal(reuseOld.status, 401, '旧 refresh token 轮换后必须失效');

  const meWithNew = await api(ctx, '/v1/auth/me', { token: rotated.accessToken });
  assert.equal(meWithNew.status, 200);
});

test('access token: 合法会话可访问，伪造 token -> 401', async (t) => {
  const ctx = await setup(t);
  const linked = await linkDevice(ctx, 'Pixel 8');

  const ok = await api(ctx, '/v1/projects', { token: linked.accessToken });
  assert.equal(ok.status, 200);

  const forged = await api(ctx, '/v1/projects', { token: 'forged-access-token' });
  assert.equal(forged.status, 401);

  const legacy = await api(ctx, '/v1/projects', { token: LEGACY_TOKEN });
  assert.equal(legacy.status, 200, '旧静态 Token 在兼容窗口内仍可用');
});

test('revoke: 撤销当前会话后 access/refresh 均失效', async (t) => {
  const ctx = await setup(t);
  const linked = await linkDevice(ctx, 'Pixel 8');

  const revoked = await api(ctx, '/v1/auth/revoke', { method: 'POST', token: linked.accessToken });
  assert.equal(revoked.status, 200);

  const me = await api(ctx, '/v1/auth/me', { token: linked.accessToken });
  assert.equal(me.status, 401);

  const refreshed = await api(ctx, '/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: linked.refreshToken },
  });
  assert.equal(refreshed.status, 401);
});

test('devices: 管理员可撤销其他设备且立即生效；设备不能撤销他人', async (t) => {
  const ctx = await setup(t);
  const first = await linkDevice(ctx, 'Pixel 8');
  const second = await linkDevice(ctx, 'Galaxy S24');

  const forbidden = await api(ctx, `/v1/auth/devices/${first.deviceId}`, {
    method: 'DELETE',
    token: second.accessToken,
  });
  assert.equal(forbidden.status, 403, '会话设备不能撤销其他设备');

  const revoked = await api(ctx, `/v1/auth/devices/${first.deviceId}`, {
    method: 'DELETE',
    token: LEGACY_TOKEN,
  });
  assert.equal(revoked.status, 200);

  const me = await api(ctx, '/v1/auth/me', { token: first.accessToken });
  assert.equal(me.status, 401, '设备撤销后 access token 必须立即失效');

  const refreshed = await api(ctx, '/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: first.refreshToken },
  });
  assert.equal(refreshed.status, 401, '设备撤销后 refresh token 必须立即失效');

  const secondStillOk = await api(ctx, '/v1/auth/me', { token: second.accessToken });
  assert.equal(secondStillOk.status, 200, '其他设备不受影响');
});

test('rate limit: 连续失败绑定触发 429', async (t) => {
  const ctx = await setup(t, {
    testKeyOk: false,
    rateLimiters: {
      link: new RateLimiter(2, 60_000),
      refresh: new RateLimiter(100, 60_000),
      authFailures: new RateLimiter(100, 60_000),
    },
  });

  const first = await api(ctx, '/v1/auth/link', { method: 'POST', body: linkBody('d1') });
  const second = await api(ctx, '/v1/auth/link', { method: 'POST', body: linkBody('d1') });
  const third = await api(ctx, '/v1/auth/link', { method: 'POST', body: linkBody('d1') });
  assert.equal(first.status, 400);
  assert.equal(second.status, 400);
  assert.equal(third.status, 429);
  assert.equal((third.json.error as { code: string }).code, 'rate_limited');
});
