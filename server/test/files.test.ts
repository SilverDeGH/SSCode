import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import type { ApiDeps, ExtraRouteCtx, RouteResult } from '../src/api/server.ts';
import type { EngineFacade } from '../src/types.ts';
import { fileRoutes } from '../src/features/files.ts';

interface Setup {
  dir: string;
  projectId: string;
  deps: ApiDeps;
}

function setup(): Setup {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-files-')));
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new Repo(db);
  const project = repo.projects.create({ name: 'demo', path: dir, isGit: false });
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
  const route = fileRoutes.find((r) => r.method === method && r.match(parts) !== null);
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
  code?: string,
): Promise<void> {
  await assert.rejects(
    call(deps, method, parts, query, body),
    (err: unknown) => {
      const e = err as { status?: number; code?: string };
      return e.status === status && (code === undefined || e.code === code);
    },
  );
}

function sha256(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

test('files/list: 目录优先排序、kind 与 sensitive 标记', async () => {
  const { dir, projectId, deps } = setup();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  const res = await call(deps, 'GET', ['files', 'list'], { projectId, path: '.' });
  const entries = (res.body as { entries: { name: string; kind: string; size: number; sensitive: boolean }[] }).entries;
  assert.equal(entries[0]!.name, 'sub');
  assert.equal(entries[0]!.kind, 'dir');
  const env = entries.find((e) => e.name === '.env');
  const txt = entries.find((e) => e.name === 'a.txt');
  assert.equal(env!.sensitive, true);
  assert.equal(txt!.sensitive, false);
  assert.equal(txt!.kind, 'file');
  assert.equal(txt!.size, 5);
});

test('files/list: 越界路径返回 400', async () => {
  const { projectId, deps } = setup();
  await callErr(deps, 'GET', ['files', 'list'], { projectId, path: '..' }, undefined, 400, 'validation_error');
});

test('files/content: 文本读取返回 hash/size/truncated', async () => {
  const { dir, projectId, deps } = setup();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world');
  const res = await call(deps, 'GET', ['files', 'content'], { projectId, path: 'a.txt' });
  const body = res.body as { content: string; hash: string; size: number; truncated: boolean };
  assert.equal(body.content, 'hello world');
  assert.equal(body.hash, sha256('hello world'));
  assert.equal(body.size, 11);
  assert.equal(body.truncated, false);
});

test('files/content: 超过 512KB 截断', async () => {
  const { dir, projectId, deps } = setup();
  const big = Buffer.alloc(600 * 1024, 'a');
  fs.writeFileSync(path.join(dir, 'big.txt'), big);
  const res = await call(deps, 'GET', ['files', 'content'], { projectId, path: 'big.txt' });
  const body = res.body as { content: string; hash: string; size: number; truncated: boolean };
  assert.equal(body.truncated, true);
  assert.equal(body.size, 600 * 1024);
  assert.equal(body.content.length, 512 * 1024);
  assert.equal(body.hash, sha256(big));
});

test('files/content: 二进制文件 400，敏感文件 403', async () => {
  const { dir, projectId, deps } = setup();
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  await callErr(deps, 'GET', ['files', 'content'], { projectId, path: 'bin.dat' }, undefined, 400);
  await callErr(deps, 'GET', ['files', 'content'], { projectId, path: '.env' }, undefined, 403, 'forbidden');
});

test('files/write: 新建自动建目录并返回 hash；baseHash 冲突 409', async () => {
  const { dir, projectId, deps } = setup();
  const res = await call(deps, 'POST', ['files', 'write'], {}, {
    projectId,
    path: 'deep/nested/a.txt',
    content: 'v1',
  });
  assert.equal((res.body as { hash: string }).hash, sha256('v1'));
  assert.equal(fs.readFileSync(path.join(dir, 'deep/nested/a.txt'), 'utf8'), 'v1');

  const ok = await call(deps, 'POST', ['files', 'write'], {}, {
    projectId,
    path: 'deep/nested/a.txt',
    content: 'v2',
    baseHash: sha256('v1'),
  });
  assert.equal((ok.body as { hash: string }).hash, sha256('v2'));

  await callErr(deps, 'POST', ['files', 'write'], {}, {
    projectId,
    path: 'deep/nested/a.txt',
    content: 'v3',
    baseHash: sha256('v1'),
  }, 409, 'conflict');
});

test('files/write: 敏感文件 403，越界 400', async () => {
  const { projectId, deps } = setup();
  await callErr(deps, 'POST', ['files', 'write'], {}, {
    projectId, path: '.env', content: 'x',
  }, 403, 'forbidden');
  await callErr(deps, 'POST', ['files', 'write'], {}, {
    projectId, path: '../evil.txt', content: 'x',
  }, 400, 'validation_error');
});

test('files/create: 新建文件与目录；已存在 409', async () => {
  const { dir, projectId, deps } = setup();
  await call(deps, 'POST', ['files', 'create'], {}, { projectId, path: 'newdir', kind: 'dir' });
  assert.ok(fs.statSync(path.join(dir, 'newdir')).isDirectory());
  await call(deps, 'POST', ['files', 'create'], {}, { projectId, path: 'newdir/f.txt', kind: 'file' });
  assert.ok(fs.statSync(path.join(dir, 'newdir/f.txt')).isFile());
  await callErr(deps, 'POST', ['files', 'create'], {}, { projectId, path: 'newdir', kind: 'dir' }, 409, 'conflict');
});

test('files/rename: 同目录重命名；目标存在 409；非法名 400', async () => {
  const { dir, projectId, deps } = setup();
  fs.writeFileSync(path.join(dir, 'old.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'taken.txt'), 'y');
  await call(deps, 'POST', ['files', 'rename'], {}, { projectId, path: 'old.txt', newName: 'new.txt' });
  assert.ok(fs.existsSync(path.join(dir, 'new.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'old.txt')));
  await callErr(deps, 'POST', ['files', 'rename'], {}, { projectId, path: 'new.txt', newName: 'taken.txt' }, 409);
  await callErr(deps, 'POST', ['files', 'rename'], {}, { projectId, path: 'new.txt', newName: '../evil' }, 400);
});

test('files/move: 移动到子目录；目标目录不存在 404；目标已存在 409', async () => {
  const { dir, projectId, deps } = setup();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'm.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'dup.txt'), 'y');
  fs.writeFileSync(path.join(dir, 'dup.txt'), 'z');
  await call(deps, 'POST', ['files', 'move'], {}, { projectId, path: 'm.txt', destDir: 'sub' });
  assert.ok(fs.existsSync(path.join(dir, 'sub', 'm.txt')));
  await callErr(deps, 'POST', ['files', 'move'], {}, { projectId, path: 'sub/m.txt', destDir: 'nope' }, 404);
  await callErr(deps, 'POST', ['files', 'move'], {}, { projectId, path: 'dup.txt', destDir: 'sub' }, 409);
  await call(deps, 'POST', ['files', 'move'], {}, { projectId, path: 'sub/m.txt', destDir: '' });
  assert.equal(fs.readFileSync(path.join(dir, 'm.txt'), 'utf8'), 'x');
  assert.ok(!fs.existsSync(path.join(dir, 'sub', 'm.txt')));
  await callErr(deps, 'POST', ['files', 'move'], {}, { projectId, path: 'm.txt' }, 400);
  await callErr(deps, 'POST', ['files', 'move'], {}, { projectId, path: 'm.txt', destDir: '../' }, 400);
});

test('files DELETE: 删文件与递归目录；根目录 400；敏感 403；不存在 404', async () => {
  const { dir, projectId, deps } = setup();
  fs.mkdirSync(path.join(dir, 'tree/sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tree/sub/f.txt'), 'x');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  await call(deps, 'DELETE', ['files'], {}, { projectId, path: 'tree' });
  assert.ok(!fs.existsSync(path.join(dir, 'tree')));
  await callErr(deps, 'DELETE', ['files'], {}, { projectId, path: '.' }, 400, 'validation_error');
  await callErr(deps, 'DELETE', ['files'], {}, { projectId, path: '.env' }, 403, 'forbidden');
  await callErr(deps, 'DELETE', ['files'], {}, { projectId, path: 'missing.txt' }, 404);
});

test('files: 项目不存在 404', async () => {
  const { deps } = setup();
  await callErr(deps, 'GET', ['files', 'list'], { projectId: 'no-such-id', path: '.' }, undefined, 404, 'not_found');
});
