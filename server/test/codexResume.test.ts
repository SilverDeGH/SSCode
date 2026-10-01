import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type { ChildProcess, spawn } from 'node:child_process';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import { createApiServer } from '../src/api/server.ts';
import type { ApiDeps } from '../src/api/server.ts';
import type { EngineFacade } from '../src/types.ts';
import { CodexWatchManager } from '../src/codexwatch/codexWatchManager.ts';
import { CodexResumeManager } from '../src/codexwatch/codexResumeManager.ts';
import { AuthService } from '../src/api/auth.ts';

const tmpDirs: string[] = [];

after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-codexresume-'));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------- 假 spawn

type SpawnBehavior =
  | { kind: 'exit'; code: number; stderr?: string }
  | { kind: 'exit-after'; ms: number; code: number }
  | { kind: 'error'; error: Error }
  | { kind: 'hang' };

interface SpawnCall {
  file: string;
  args: string[];
  cwd: unknown;
  windowsHide: unknown;
  envPath: unknown;
}

function fakeSpawn(behavior: (file: string, args: string[]) => SpawnBehavior): {
  spawnFn: typeof spawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnFn = ((file: unknown, args: unknown, options: { cwd?: unknown; windowsHide?: unknown; env?: NodeJS.ProcessEnv }) => {
    const argv = (args as unknown[]).map(String);
    const env = options?.env ?? {};
    const envPath = Object.keys(env).find((k) => k.toLowerCase() === 'path');
    calls.push({ file: String(file), args: argv, cwd: options?.cwd, windowsHide: options?.windowsHide, envPath: envPath === undefined ? undefined : env[envPath] });
    const child = new EventEmitter() as ChildProcess;
    (child as { stderr?: unknown }).stderr = new PassThrough();
    (child as { stdout?: unknown }).stdout = new PassThrough();
    (child as { stdin?: unknown }).stdin = new PassThrough();
    const b = behavior(String(file), argv);
    if (b.kind === 'exit') {
      setImmediate(() => {
        if (b.stderr !== undefined) (child.stderr as PassThrough).write(b.stderr);
        child.emit('close', b.code);
      });
    } else if (b.kind === 'exit-after') {
      setTimeout(() => child.emit('close', b.code), b.ms).unref();
    } else if (b.kind === 'error') {
      setImmediate(() => child.emit('error', b.error));
    }
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, calls };
}

function errStatus(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

// ---------------------------------------------------------------- manager 单测

test('sendMessage: spawn 参数为 exec resume 位置参数，cwd/windowsHide 正确，CLI 检测只跑一次', async () => {
  const { spawnFn, calls } = fakeSpawn(() => ({ kind: 'exit', code: 0 }));
  const m = new CodexResumeManager({ codexBin: 'codex-fake', spawnFn });

  await m.sendMessage('thread-1', '继续修复登录', '/repo/demo');
  await m.sendMessage('thread-1', '再补一条', '/repo/demo');

  assert.equal(calls.length, 3, '第二次发送不应重复 --version 检测');
  assert.deepEqual(calls[0]?.args, ['--version']);
  assert.deepEqual(calls[1]?.args, ['exec', 'resume', 'thread-1', '继续修复登录']);
  assert.equal(calls[1]?.cwd, '/repo/demo');
  assert.equal(calls[1]?.windowsHide, true);
  assert.deepEqual(calls[2]?.args, ['exec', 'resume', 'thread-1', '再补一条']);
  for (const call of calls) assert.equal(call.file, 'codex-fake');
});

test('sendMessage: 同一线程互斥，并发第二次 409', async () => {
  const { spawnFn } = fakeSpawn((_file, args) =>
    args[0] === '--version' ? { kind: 'exit', code: 0 } : { kind: 'hang' },
  );
  const m = new CodexResumeManager({ spawnFn });

  const first = m.sendMessage('thread-busy', '第一条', '/repo/demo');
  first.catch(() => {}); // hang 永不 resolve，仅防 unhandled rejection
  await assert.rejects(m.sendMessage('thread-busy', '第二条', '/repo/demo'), (err) => {
    assert.equal(errStatus(err), 409);
    assert.match((err as Error).message, /codex thread is busy/);
    return true;
  });
  // 其他线程不受影响（同样 hang，但应能进入执行而非 409）
  const other = m.sendMessage('thread-free', 'x', '/repo/demo');
  other.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
});

test('sendMessage: spawn ENOENT → 503 codex cli unavailable，检测结果缓存', async () => {
  const enoent = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
  enoent.code = 'ENOENT';
  const { spawnFn, calls } = fakeSpawn(() => ({ kind: 'error', error: enoent }));
  const m = new CodexResumeManager({ spawnFn });

  await assert.rejects(m.sendMessage('thread-1', 'hi', '/repo'), (err) => {
    assert.equal(errStatus(err), 503);
    assert.match((err as Error).message, /codex cli unavailable/);
    return true;
  });
  await assert.rejects(m.sendMessage('thread-1', 'hi', '/repo'), (err) => errStatus(err) === 503);
  assert.equal(calls.length, 1, 'CLI 不可用结果应缓存，不再重复 spawn');
});

test('sendMessage: exec 非零退出 → 502，message 带 stderr 摘要', async () => {
  const { spawnFn } = fakeSpawn((_file, args) =>
    args[0] === '--version'
      ? { kind: 'exit', code: 0 }
      : { kind: 'exit', code: 1, stderr: 'thread not found in local store' },
  );
  const m = new CodexResumeManager({ spawnFn });

  await assert.rejects(m.sendMessage('thread-x', 'hi', '/repo'), (err) => {
    assert.equal(errStatus(err), 502);
    assert.match((err as Error).message, /exit 1/);
    assert.match((err as Error).message, /thread not found in local store/);
    return true;
  });
});

test('sendMessage: 超过宽限期仍在运行 → 受理返回，互斥锁保留到进程退出', async () => {
  const { spawnFn } = fakeSpawn((_file, args) =>
    args[0] === '--version' ? { kind: 'exit', code: 0 } : { kind: 'exit-after', ms: 150, code: 0 },
  );
  const m = new CodexResumeManager({ spawnFn, graceMs: 20 });

  // 进程跑 150ms，宽限期 20ms：sendMessage 应在 ~20ms 后受理返回而不是等退出
  await m.sendMessage('thread-slow', 'hi', '/repo');
  // 进程未退出，锁仍在：同线程第二次 409
  await assert.rejects(m.sendMessage('thread-slow', 'again', '/repo'), (err) => errStatus(err) === 409);
  // 等进程退出后解锁，可再次发送
  await new Promise(resolve => setTimeout(resolve, 300));
  await m.sendMessage('thread-slow', 'third', '/repo');
});

test('sendMessage: codexBin 含路径时把所在目录前置到子进程 PATH', async () => {
  const { spawnFn, calls } = fakeSpawn(() => ({ kind: 'exit', code: 0 }));
  const m = new CodexResumeManager({ codexBin: '/fake/node/bin/codex', spawnFn });

  await m.sendMessage('thread-1', 'hi', '/repo');
  const execCall = calls.find(c => c.args[0] === 'exec');
  assert.ok(execCall !== undefined);
  assert.match(String(execCall.envPath), /^\/fake\/node\/bin([:;]|$)/, 'PATH 应以 codexBin 目录开头');
});

// ---------------------------------------------------------------- 路由测试

const TOKEN = 'test-token-0123456789';

const STATE_SCHEMA = `
CREATE TABLE threads (
  id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, name TEXT, preview TEXT,
  cwd TEXT, model TEXT, is_pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
  thread_source TEXT, originator TEXT, project_id TEXT,
  created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER,
  thread_section_id TEXT
);
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER DEFAULT 0);
CREATE TABLE project_roots (project_id TEXT, path TEXT);
CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT);`;

/** 造 state 库：thread-aaa 属 /repo/demo，thread-bbb 属 /repo/other */
function seedCodexDir(): string {
  const dir = mkTmp();
  const db = new DatabaseSync(path.join(dir, 'state_1.sqlite'));
  db.exec(STATE_SCHEMA);
  const insert = db.prepare(
    `INSERT INTO threads (id, rollout_path, title, name, preview, cwd, model, is_pinned, archived,
       thread_source, originator, project_id, created_at_ms, updated_at_ms, recency_at_ms, thread_section_id)
     VALUES (?, NULL, NULL, NULL, ?, ?, NULL, 0, 0, 'user', NULL, NULL, 1, 1, 1, NULL)`,
  );
  insert.run('thread-aaa', '任务 A', '/repo/demo');
  insert.run('thread-bbb', '任务 B', '/repo/other');
  db.close();
  return dir;
}

function stubEngine(): EngineFacade {
  const fail = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    setApprovalMode: fail,
    submitTask: fail,
    appendMessage: fail,
    answerTask: fail,
    stopTask: fail,
    cancelQueued: fail,
    decideApproval: fail,
    undoTask: fail,
    resumeInterrupted: fail,
  };
}

async function setupApi(
  t: import('node:test').TestContext,
  resume: CodexResumeManager,
): Promise<{ base: string; repo: Repo; authService: AuthService }> {
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new Repo(db);
  const authService = new AuthService(repo);
  const deps: ApiDeps = {
    repo,
    engine: stubEngine(),
    authToken: TOKEN,
    authService,
    testModel: async () => ({ ok: true, detail: 'stub' }),
    setModelKey: () => {},
    deleteModelKey: () => {},
    version: '0.1.0-test',
    codexWatch: new CodexWatchManager({ codexDir: seedCodexDir() }),
    codexResume: resume,
  };
  const server: http.Server = createApiServer(deps);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  t.after(() => {
    server.close();
    db.close();
  });
  return { base: `http://127.0.0.1:${addr.port}`, repo, authService };
}

function postMessage(base: string, projectId: string, threadId: string, token: string, text: string) {
  return fetch(`${base}/v1/projects/${projectId}/codex/tasks/${threadId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

test('路由: viewer 角色 403，写角色 202 且假 spawnFn 收到 exec resume，审计落库', async (t) => {
  const { spawnFn, calls } = fakeSpawn(() => ({ kind: 'exit', code: 0 }));
  const { base, repo, authService } = await setupApi(t, new CodexResumeManager({ spawnFn }));
  const proj = repo.projects.create({ name: 'A', path: '/repo/demo', isGit: false });

  const viewer = authService.createDevice('viewer-phone');
  repo.projectMembers.setRole(proj.id, viewer.id, 'viewer');
  const viewerToken = authService.issueSession(viewer.id).accessToken;
  const denied = await postMessage(base, proj.id, 'thread-aaa', viewerToken, '你好');
  assert.equal(denied.status, 403);

  const operator = authService.createDevice('operator-phone');
  repo.projectMembers.setRole(proj.id, operator.id, 'operator');
  const operatorToken = authService.issueSession(operator.id).accessToken;
  const ok = await postMessage(base, proj.id, 'thread-aaa', operatorToken, '继续处理');
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { accepted: true, threadId: 'thread-aaa' });

  const execCall = calls.find(c => c.args[0] === 'exec');
  assert.ok(execCall !== undefined, '假 spawnFn 应收到 exec resume 调用');
  assert.deepEqual(execCall.args, ['exec', 'resume', 'thread-aaa', '继续处理']);
  assert.equal(execCall.cwd, '/repo/demo');

  const audits = repo.events.listAfter(0, proj.id).filter(e => e.type === 'audit');
  assert.ok(audits.some(e => (e.payload as { action?: string }).action === 'codex.message_send'));
});

test('路由: 线程不存在或不属于项目 → 404（与 GET 详情同一规则）', async (t) => {
  const { spawnFn, calls } = fakeSpawn(() => ({ kind: 'exit', code: 0 }));
  const { base, repo } = await setupApi(t, new CodexResumeManager({ spawnFn }));
  const proj = repo.projects.create({ name: 'A', path: '/repo/demo', isGit: false });

  const missing = await postMessage(base, proj.id, 'no-such-thread', TOKEN, 'hi');
  assert.equal(missing.status, 404);

  // thread-bbb 的 cwd 在 /repo/other，不属于本项目
  const crossProject = await postMessage(base, proj.id, 'thread-bbb', TOKEN, 'hi');
  assert.equal(crossProject.status, 404);

  assert.equal(calls.filter(c => c.args[0] === 'exec').length, 0, '404 场景不应触发 spawn exec');
});

test('路由: 空 text 400，无 token 401', async (t) => {
  const { spawnFn } = fakeSpawn(() => ({ kind: 'exit', code: 0 }));
  const { base, repo } = await setupApi(t, new CodexResumeManager({ spawnFn }));
  const proj = repo.projects.create({ name: 'A', path: '/repo/demo', isGit: false });

  const empty = await postMessage(base, proj.id, 'thread-aaa', TOKEN, '');
  assert.equal(empty.status, 400);

  const noToken = await fetch(`${base}/v1/projects/${proj.id}/codex/tasks/thread-aaa/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(noToken.status, 401);
});
