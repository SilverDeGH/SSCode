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

const LEGACY_TOKEN = 'legacy-token-for-sse-tests';
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
  opts: { sse?: ApiDeps['sse'] } = {},
): Promise<Ctx> {
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
    ...(opts.sse !== undefined ? { sse: opts.sse } : {}),
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

interface LinkedDevice {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  role: string;
}

async function linkDevice(ctx: Ctx, deviceName: string): Promise<LinkedDevice> {
  const res = await fetch(`${ctx.base}/v1/auth/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceName,
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      apiKey: API_KEY,
    }),
  });
  assert.equal(res.status, 201, `link ${deviceName} should succeed`);
  return (await res.json()) as unknown as LinkedDevice;
}

interface SseMessage {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

interface SseConnection {
  status: number;
  headers: Headers;
  messages: SseMessage[];
  /** 收到的 SSE 注释帧（`: connected` / `: heartbeat` 等） */
  comments: string[];
  waitFor: (
    pred: (messages: SseMessage[]) => boolean,
    label: string,
    timeoutMs?: number,
  ) => Promise<void>;
  close: () => void;
}

async function openSse(
  ctx: Ctx,
  path: string,
  opts: { token?: string; headers?: Record<string, string> } = {},
): Promise<SseConnection> {
  const controller = new AbortController();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${ctx.base}${path}`, { headers, signal: controller.signal });
  const messages: SseMessage[] = [];
  const comments: string[] = [];
  if (res.status === 200 && res.body !== null) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf('\n\n');
          while (idx >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            idx = buf.indexOf('\n\n');
            if (raw.startsWith(':')) {
              comments.push(raw);
              continue;
            }
            let id = '';
            let event = '';
            const dataLines: string[] = [];
            for (const line of raw.split('\n')) {
              if (line.startsWith('id: ')) id = line.slice(4);
              else if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
            }
            messages.push({
              id,
              event,
              data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
            });
          }
        }
      } catch {
        // 连接被测试主动中止
      }
    })();
  }
  const waitFor: SseConnection['waitFor'] = async (pred, label, timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (pred(messages)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`SSE 等待超时: ${label}（已收到 ${messages.length} 条）`);
  };
  return { status: res.status, headers: res.headers, messages, comments, waitFor, close: () => controller.abort() };
}

test('sse: 会话 token 连接，回放历史事件并接收实时事件，游标前进', async (t) => {
  const ctx = await setup(t);
  const project = ctx.repo.projects.create({ name: 'demo', path: `e:/tmp/p-${Math.random()}`, isGit: false });
  const linked = await linkDevice(ctx, 'Pixel 8');
  const e1 = ctx.repo.events.append(project.id, null, 'log', { n: 1 });
  const e2 = ctx.repo.events.append(project.id, null, 'log', { n: 2 });

  const conn = await openSse(ctx, `/v1/events/stream?projectId=${project.id}&after=0`, {
    token: linked.accessToken,
  });
  t.after(() => conn.close());
  assert.equal(conn.status, 200);
  assert.match(conn.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(conn.headers.get('cache-control'), 'no-cache');
  assert.equal(conn.headers.get('x-accel-buffering'), 'no');

  await conn.waitFor((m) => m.length >= 2, '回放 2 条历史事件');
  assert.deepEqual(conn.messages.map((m) => m.id), [String(e1.id), String(e2.id)]);
  assert.ok(conn.messages.every((m) => m.event === 'log'));

  ctx.repo.events.append(project.id, null, 'log', { n: 3 });
  await conn.waitFor((m) => m.length >= 3, '接收实时事件');
  assert.equal((conn.messages[2]!.data.payload as { n: number }).n, 3);
  assert.ok(
    Number(conn.messages[2]!.id) > Number(conn.messages[1]!.id),
    '事件 id 即游标应单调前进',
  );
});

test('sse: Last-Event-ID 头作为断线重连游标', async (t) => {
  const ctx = await setup(t);
  const project = ctx.repo.projects.create({ name: 'demo', path: `e:/tmp/p-${Math.random()}`, isGit: false });
  const linked = await linkDevice(ctx, 'Pixel 8');
  const e1 = ctx.repo.events.append(project.id, null, 'log', { n: 1 });
  ctx.repo.events.append(project.id, null, 'log', { n: 2 });
  ctx.repo.events.append(project.id, null, 'log', { n: 3 });

  const conn = await openSse(ctx, `/v1/events/stream?projectId=${project.id}`, {
    token: linked.accessToken,
    headers: { 'last-event-id': String(e1.id) },
  });
  t.after(() => conn.close());
  assert.equal(conn.status, 200);
  await conn.waitFor((m) => m.length >= 2, '回放 Last-Event-ID 之后的事件');
  assert.deepEqual(
    conn.messages.map((m) => (m.data.payload as { n: number }).n),
    [2, 3],
  );
});

test('sse: 无认证 401；设备无项目成员关系 403', async (t) => {
  const ctx = await setup(t);
  const linked = await linkDevice(ctx, 'Pixel 8'); // 链接时无项目，无成员关系
  const project = ctx.repo.projects.create({ name: 'demo', path: `e:/tmp/p-${Math.random()}`, isGit: false });

  const noAuth = await fetch(`${ctx.base}/v1/events/stream?projectId=${project.id}`);
  assert.equal(noAuth.status, 401);

  const forbidden = await openSse(ctx, `/v1/events/stream?projectId=${project.id}`, {
    token: linked.accessToken,
  });
  assert.equal(forbidden.status, 403);

  const badCursor = await openSse(ctx, `/v1/events/stream?projectId=${project.id}&after=-1`, {
    token: LEGACY_TOKEN,
  });
  assert.equal(badCursor.status, 400);
});

test('sse: 省略 projectId 时只推送有成员关系项目的事件', async (t) => {
  const ctx = await setup(t);
  const projectA = ctx.repo.projects.create({ name: 'a', path: `e:/tmp/p-${Math.random()}`, isGit: false });
  const linked = await linkDevice(ctx, 'Pixel 8'); // 仅对 A 有 owner 成员关系
  const projectB = ctx.repo.projects.create({ name: 'b', path: `e:/tmp/p-${Math.random()}`, isGit: false });
  ctx.repo.events.append(projectA.id, null, 'log', { which: 'a' });
  ctx.repo.events.append(projectB.id, null, 'log', { which: 'b' });

  const conn = await openSse(ctx, '/v1/events/stream?after=0', { token: linked.accessToken });
  t.after(() => conn.close());
  assert.equal(conn.status, 200);
  await conn.waitFor((m) => m.length >= 1, '收到 A 项目事件');
  // 等待超过一个轮询周期（1s），确认 B 项目事件不会到达
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(conn.messages.length >= 1);
  assert.ok(
    conn.messages.every((m) => m.data.projectId === projectA.id),
    '不应收到无成员关系项目的事件',
  );
});

test('sse: 同设备第 6 条并发流被拒 429；关闭一条后新流可接入', async (t) => {
  const ctx = await setup(t);
  const project = ctx.repo.projects.create({ name: 'demo', path: `e:/tmp/p-${Math.random()}`, isGit: false });
  const linked = await linkDevice(ctx, 'Pixel 8');
  const path = `/v1/events/stream?projectId=${project.id}`;

  const conns: SseConnection[] = [];
  for (let i = 0; i < 5; i += 1) {
    const conn = await openSse(ctx, path, { token: linked.accessToken });
    assert.equal(conn.status, 200, `第 ${i + 1} 条流应成功`);
    conns.push(conn);
  }
  t.after(() => {
    for (const c of conns) c.close();
  });

  const sixth = await openSse(ctx, path, { token: linked.accessToken });
  assert.equal(sixth.status, 429, '同设备第 6 条并发流应被拒');
  sixth.close();

  // 关闭一条后服务端异步释放配额：轮询重试直至接入，避免固定等待
  conns[0]!.close();
  let reopened: SseConnection | null = null;
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const attempt = await openSse(ctx, path, { token: linked.accessToken });
    if (attempt.status === 200) {
      reopened = attempt;
      break;
    }
    attempt.close();
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(reopened !== null, '释放一条流后应能重新接入');
  t.after(() => reopened?.close());
});

test('sse: 空闲连接按注入的心跳间隔收到 : heartbeat 注释', async (t) => {
  const ctx = await setup(t, { sse: { heartbeatIntervalMs: 50, pollIntervalMs: 20 } });
  const project = ctx.repo.projects.create({ name: 'demo', path: `e:/tmp/p-${Math.random()}`, isGit: false });
  const linked = await linkDevice(ctx, 'Pixel 8');

  const conn = await openSse(ctx, `/v1/events/stream?projectId=${project.id}`, {
    token: linked.accessToken,
  });
  t.after(() => conn.close());
  assert.equal(conn.status, 200);

  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (conn.comments.includes(': heartbeat')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(conn.comments.includes(': connected'), '连接建立时应先收到 : connected');
  assert.ok(conn.comments.includes(': heartbeat'), '空闲流应在心跳间隔内收到 : heartbeat');
});
