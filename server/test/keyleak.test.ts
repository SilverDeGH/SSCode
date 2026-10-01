import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import { createApiServer } from '../src/api/server.ts';
import type { ApiDeps } from '../src/api/server.ts';
import { AuthService, sha256Hex } from '../src/api/auth.ts';
import type {
  Approval,
  ApprovalMode,
  EngineFacade,
  SubmitTaskInput,
  Task,
  UndoReport,
} from '../src/types.ts';

// plan §9 安全验证：API Key / refresh token 泄露静态与功能扫描（功能测试优先）
const LEGACY_TOKEN = 'legacy-token-for-keyleak-tests';
const CANARY_LINK = 'sk-canary-link-9f8e7d6c5b4a0011';
const CANARY_UPDATE = 'sk-canary-update-223344556677aabb';
const CANARY_ECHO = 'sk-canary-echo-ffeeddccbbaa9988';
const ALL_CANARIES = [CANARY_LINK, CANARY_UPDATE, CANARY_ECHO];

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
  keyStore: Map<string, string>;
  /** 记录所有响应原文用于最终统一扫描；issuance 标记 link/refresh 签发响应（合法包含新 token） */
  responses: { label: string; text: string; issuance: boolean }[];
}

async function setup(
  t: import('node:test').TestContext,
  opts: { testKeyOk?: boolean } = {},
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
    // 恶意回显适配器：失败时把提交的 Key 原样写进错误详情，服务端必须脱敏
    testModelKey: async ({ apiKey }) =>
      testKeyOk
        ? { ok: true, detail: 'stub ok' }
        : { ok: false, detail: `provider 401 unauthorized: invalid api key ${apiKey}` },
    setModelKey: (ref, key) => {
      keyStore.set(ref, key);
    },
    deleteModelKey: (ref) => {
      keyStore.delete(ref);
    },
    version: '0.0.0-test',
  };
  const server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  t.after(() => {
    server.close();
    db.close();
  });
  return {
    db,
    repo,
    server,
    base: `http://127.0.0.1:${addr.port}`,
    keyStore,
    responses: [],
  };
}

async function api(
  ctx: Ctx,
  label: string,
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    token?: string;
    issuance?: boolean;
  } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
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
  const text = await res.text();
  ctx.responses.push({ label, text, issuance: opts.issuance ?? false });
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown> };
}

function linkBody(deviceName: string, apiKey: string): Record<string, unknown> {
  return {
    deviceName,
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5',
    apiKey,
  };
}

test('canary Key 全链路扫描：响应/事件/审计/models/auth/me 均不泄露', async (t) => {
  const ctx = await setup(t);
  ctx.repo.projects.create({ name: 'demo', path: `e:/tmp/p-${Math.random()}`, isGit: false });

  // 1. 完整 link 流程（canary Key）
  const linked = await api(ctx, 'link', '/v1/auth/link', {
    method: 'POST',
    body: linkBody('Pixel 8', CANARY_LINK),
    issuance: true,
  });
  assert.equal(linked.status, 201);
  assert.ok(!JSON.stringify(linked.json).includes(CANARY_LINK), 'link 响应不得包含 Key');
  const modelConfig = linked.json.modelConfig as { id: string; apiKeyRef: string };
  assert.ok([...ctx.keyStore.values()].includes(CANARY_LINK), 'Key 只进受保护存储');
  const deviceId = linked.json.deviceId as string;
  const accessToken = linked.json.accessToken as string;
  const refreshToken = linked.json.refreshToken as string;

  // 2. 模型 Key 更新流程（第二个 canary）
  const keyUpdate = await api(ctx, 'key-update', `/v1/models/${modelConfig.id}/key`, {
    method: 'POST',
    token: accessToken,
    body: { apiKey: CANARY_UPDATE },
  });
  assert.equal(keyUpdate.status, 200);
  assert.equal(ctx.keyStore.get(modelConfig.apiKeyRef), CANARY_UPDATE);

  // 3. 常规读取端点
  const models = await api(ctx, 'models', '/v1/models', { token: accessToken });
  assert.equal(models.status, 200);
  const me = await api(ctx, 'auth/me', '/v1/auth/me', { token: accessToken });
  assert.equal(me.status, 200);
  await api(ctx, 'auth/devices', '/v1/auth/devices', { token: accessToken });
  await api(ctx, 'projects', '/v1/projects', { token: accessToken });
  await api(ctx, 'events', '/v1/events?after=0', { token: LEGACY_TOKEN });
  await api(ctx, 'models-legacy', '/v1/models', { token: LEGACY_TOKEN });

  // 4. refresh 轮换：新 token 合法签发（issuance），旧 token 立即失效且错误响应不回显
  const refreshed = await api(ctx, 'refresh', '/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
    issuance: true,
  });
  assert.equal(refreshed.status, 200);
  const rotatedRefreshToken = refreshed.json.refreshToken as string;
  const reuseOld = await api(ctx, 'refresh-reuse-old', '/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
  });
  assert.equal(reuseOld.status, 401);
  assert.ok(!reuseOld.json.error || !JSON.stringify(reuseOld.json).includes(refreshToken));

  // 5. DB 直接断言：auth_sessions 只存哈希
  const sessions = ctx.db
    .prepare('SELECT * FROM auth_sessions')
    .all() as unknown as { refresh_token_hash: string }[];
  assert.equal(sessions.length, 1);
  const sessionsJson = JSON.stringify(sessions);
  assert.ok(!sessionsJson.includes(refreshToken), 'auth_sessions 不得出现 refresh token 明文');
  assert.ok(!sessionsJson.includes(rotatedRefreshToken), '轮换后同样不存明文');
  assert.equal(sessions[0]?.refresh_token_hash, sha256Hex(rotatedRefreshToken), '只存 sha256 哈希');
  assert.match(sessions[0]!.refresh_token_hash, /^[0-9a-f]{64}$/);

  // 6. DB 扫描：events（含 audit）与 model_configs 不含任何 canary
  const eventRows = ctx.db
    .prepare('SELECT type, payload FROM events')
    .all() as unknown as { type: string; payload: string }[];
  assert.ok(eventRows.length > 0);
  for (const canary of ALL_CANARIES) {
    for (const row of eventRows) {
      assert.ok(!row.payload.includes(canary), `events(${row.type}) 不得包含 Key`);
    }
  }
  const auditRows = eventRows.filter((r) => r.type === 'audit');
  assert.ok(auditRows.length >= 2, 'link 与 key_update 应产生审计');
  const configRows = ctx.db.prepare('SELECT * FROM model_configs').all();
  assert.ok(!JSON.stringify(configRows).includes(CANARY_LINK));
  assert.ok(!JSON.stringify(configRows).includes(CANARY_UPDATE));

  // 7. 统一扫描全部响应原文：canary 绝不出现在任何响应；
  //    refresh token 只允许出现在签发（link/refresh）响应中
  for (const r of ctx.responses) {
    for (const canary of ALL_CANARIES) {
      assert.ok(!r.text.includes(canary), `响应[${r.label}]不得包含 Key`);
    }
    if (!r.issuance) {
      assert.ok(!r.text.includes(refreshToken), `响应[${r.label}]不得包含 refresh token`);
      assert.ok(!r.text.includes(rotatedRefreshToken), `响应[${r.label}]不得包含轮换后 refresh token`);
    }
  }
  assert.ok(deviceId.length > 0);
});

test('canary Key 扫描：恶意回显适配器 + 连接失败时错误响应脱敏，且不留下痕迹', async (t) => {
  const ctx = await setup(t, { testKeyOk: false });

  const failed = await api(ctx, 'link-fail', '/v1/auth/link', {
    method: 'POST',
    body: linkBody('Evilphone', CANARY_ECHO),
  });
  assert.equal(failed.status, 400);
  assert.ok(!JSON.stringify(failed.json).includes(CANARY_ECHO), '适配器回显的 Key 必须被脱敏');
  assert.equal(ctx.keyStore.size, 0, '验证失败不得保存 Key');
  assert.equal(ctx.repo.modelConfigs.list().length, 0);

  // 失败路径也不得在事件/审计中留下 Key
  const eventRows = ctx.db
    .prepare('SELECT type, payload FROM events')
    .all() as unknown as { type: string; payload: string }[];
  for (const row of eventRows) {
    assert.ok(!row.payload.includes(CANARY_ECHO), `events(${row.type}) 不得包含 Key`);
  }
});
