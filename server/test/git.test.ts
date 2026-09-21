import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import type { ApiDeps, ExtraRouteCtx, RouteResult } from '../src/api/server.ts';
import type { EngineFacade } from '../src/types.ts';
import { gitRoutes } from '../src/features/git.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

interface Setup {
  dir: string;
  projectId: string;
  deps: ApiDeps;
}

function setup(initRepo: boolean): Setup {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-git-')));
  if (initRepo) {
    git(dir, 'init');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
  }
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new Repo(db);
  const project = repo.projects.create({ name: 'demo', path: dir, isGit: initRepo });
  const deps: ApiDeps = {
    repo,
    engine: {} as EngineFacade,
    authToken: 't',
    testModel: async () => ({ ok: true, detail: '' }),
    setModelKey: () => {},
    deleteModelKey: () => {},
    version: 'test',
  };
  return { dir, projectId: project.id, deps };
}

async function call(
  deps: ApiDeps,
  method: string,
  parts: string[],
  query: Record<string, string> = {},
  body?: unknown,
): Promise<RouteResult> {
  const route = gitRoutes.find((r) => r.method === method && r.match(parts) !== null);
  assert.ok(route !== undefined, `route not found: ${method} ${parts.join('/')}`);
  const qs = new URLSearchParams(query).toString();
  const url = new URL(`http://127.0.0.1/v1/${parts.join('/')}${qs === '' ? '' : `?${qs}`}`);
  const ctx: ExtraRouteCtx = {
    deps,
    req: null as unknown as http.IncomingMessage,
    url,
    parts,
    params: route.match(parts) ?? {},
    readBody: async () => body,
  };
  return route.handle(ctx);
}

async function callErr(
  deps: ApiDeps,
  method: string,
  parts: string[],
  query: Record<string, string>,
  body: unknown,
  status: number,
): Promise<Error> {
  let caught: Error | null = null;
  await assert.rejects(call(deps, method, parts, query, body), (err: unknown) => {
    const e = err as { status?: number };
    if (e.status !== status) return false;
    caught = err as Error;
    return true;
  });
  return caught!;
}

interface StatusBody {
  isRepo: boolean;
  branch?: string | null;
  ahead?: number;
  behind?: number;
  files?: { path: string; index: string; worktree: string }[];
}

async function status(deps: ApiDeps, projectId: string): Promise<StatusBody> {
  const res = await call(deps, 'GET', ['git', 'status'], { projectId });
  return res.body as StatusBody;
}

test('git/status: 非仓库返回 isRepo:false 不报错', async () => {
  const { projectId, deps } = setup(false);
  const body = await status(deps, projectId);
  assert.equal(body.isRepo, false);
});

test('git/status: 解析未跟踪文件与分支头', async () => {
  const { dir, projectId, deps } = setup(true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const body = await status(deps, projectId);
  assert.equal(body.isRepo, true);
  assert.ok(typeof body.branch === 'string' && body.branch.length > 0);
  const f = body.files!.find((e) => e.path === 'a.txt');
  assert.ok(f !== undefined);
  assert.equal(f.index, '?');
  assert.equal(f.worktree, '?');
});

test('git/stage + commit: 暂存后 index=A，提交后工作区干净', async () => {
  const { dir, projectId, deps } = setup(true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  await call(deps, 'POST', ['git', 'stage'], {}, { projectId, paths: ['a.txt'] });
  let body = await status(deps, projectId);
  const staged = body.files!.find((e) => e.path === 'a.txt');
  assert.equal(staged!.index, 'A');

  const commitRes = await call(deps, 'POST', ['git', 'commit'], {}, { projectId, message: 'init' });
  assert.equal((commitRes.body as { ok: boolean }).ok, true);
  body = await status(deps, projectId);
  assert.equal(body.files!.length, 0);
});

test('git/unstage: 取消暂存后回到未跟踪', async () => {
  const { dir, projectId, deps } = setup(true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  await call(deps, 'POST', ['git', 'stage'], {}, { projectId, paths: ['a.txt'] });
  await call(deps, 'POST', ['git', 'unstage'], {}, { projectId, paths: ['a.txt'] });
  const body = await status(deps, projectId);
  const f = body.files!.find((e) => e.path === 'a.txt');
  assert.equal(f!.index, '?');
});

test('git/branch + checkout: 创建并切换分支', async () => {
  const { dir, projectId, deps } = setup(true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  await call(deps, 'POST', ['git', 'stage'], {}, { projectId, paths: ['a.txt'] });
  await call(deps, 'POST', ['git', 'commit'], {}, { projectId, message: 'init' });
  await call(deps, 'POST', ['git', 'branch'], {}, { projectId, name: 'feat' });
  await call(deps, 'POST', ['git', 'checkout'], {}, { projectId, name: 'feat' });
  const body = await status(deps, projectId);
  assert.equal(body.branch, 'feat');
});

test('git/checkout: 未提交改动冲突时返回 409 与 git 原文', async () => {
  const { dir, projectId, deps } = setup(true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
  await call(deps, 'POST', ['git', 'stage'], {}, { projectId, paths: ['a.txt'] });
  await call(deps, 'POST', ['git', 'commit'], {}, { projectId, message: 'init' });
  const main = git(dir, 'branch', '--show-current').trim();
  await call(deps, 'POST', ['git', 'branch'], {}, { projectId, name: 'feat' });
  await call(deps, 'POST', ['git', 'checkout'], {}, { projectId, name: 'feat' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2-on-feat');
  await call(deps, 'POST', ['git', 'stage'], {}, { projectId, paths: ['a.txt'] });
  await call(deps, 'POST', ['git', 'commit'], {}, { projectId, message: 'feat change' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty');
  const err = await callErr(
    deps, 'POST', ['git', 'checkout'], {}, { projectId, name: main }, 409,
  );
  assert.ok(err.message.length > 0);
});

test('git/diff: 未暂存改动文本；staged 参数走 --cached', async () => {
  const { dir, projectId, deps } = setup(true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  await call(deps, 'POST', ['git', 'stage'], {}, { projectId, paths: ['a.txt'] });
  await call(deps, 'POST', ['git', 'commit'], {}, { projectId, message: 'init' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2\n');
  let res = await call(deps, 'GET', ['git', 'diff'], { projectId, path: 'a.txt' });
  let body = res.body as { diff: string; truncated: boolean };
  assert.ok(body.diff.includes('+v2'));
  assert.equal(body.truncated, false);

  res = await call(deps, 'GET', ['git', 'diff'], { projectId, staged: '1' });
  body = res.body as { diff: string; truncated: boolean };
  assert.equal(body.diff, '');

  await call(deps, 'POST', ['git', 'stage'], {}, { projectId, paths: ['a.txt'] });
  res = await call(deps, 'GET', ['git', 'diff'], { projectId, staged: 'true' });
  body = res.body as { diff: string; truncated: boolean };
  assert.ok(body.diff.includes('+v2'));
});

test('git/commit: 无改动时 409', async () => {
  const { dir, projectId, deps } = setup(true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
  await call(deps, 'POST', ['git', 'stage'], {}, { projectId, paths: ['a.txt'] });
  await call(deps, 'POST', ['git', 'commit'], {}, { projectId, message: 'init' });
  await callErr(deps, 'POST', ['git', 'commit'], {}, { projectId, message: 'empty' }, 409);
});
