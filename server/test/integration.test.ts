import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { MockAdapter } from '../src/ai/mock.ts';
import type { MockTurn } from '../src/ai/mock.ts';

/** 端到端：真实 HTTP + 真实引擎 + Mock 模型，走完整任务闭环 */
let app: App;
let base: string;
let headers: Record<string, string>;
let projectDir: string;
let dataDir: string;

const script: MockTurn[] = [
  { text: '先看一下项目结构', toolCalls: [{ name: 'search', args: { pattern: 'hello' } }] },
  { toolCalls: [{ name: 'write_file', args: { path: 'src/hello.ts', content: 'export const hello = "world";\n' } }] },
  { toolCalls: [{ name: 'write_file', args: { path: 'README.md', content: '# demo\n' } }] },
  { toolCalls: [{ name: 'run_command', args: { command: 'node -e "console.log(1)"' } }] },
  { text: '已完成：新增 hello.ts 与 README，验证命令通过', toolCalls: [{ name: 'finish', args: { summary: '新增 2 个文件，验证成功' } }] },
];

async function api(method: string, p: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function waitTaskState(id: string, targets: string[], timeoutMs = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api('GET', `/v1/tasks/${id}`);
    if (targets.includes(body.state as string)) return body;
    if (Date.now() > deadline) throw new Error(`任务未进入 ${targets.join('/')}，当前 ${String(body.state)}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-it-data-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-it-proj-'));
  fs.writeFileSync(path.join(projectDir, 'existing.ts'), 'console.log("old");\n');
  app = createApp({ dataDir, resolveAdapter: () => new MockAdapter(script) });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  headers = { authorization: `Bearer ${app.authToken}` };
});

after(async () => {
  await new Promise(r => app.server.close(r));
  app.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('端到端：建项目→会话→提交任务→完成→变更→撤销', async () => {
  const health = await fetch(`${base}/v1/health`);
  assert.equal(health.status, 200);

  const proj = await api('POST', '/v1/projects', { name: 'demo', path: projectDir });
  assert.equal(proj.status, 201);
  const projectId = proj.body.id as string;

  const sess = await api('POST', `/v1/projects/${projectId}/sessions`, { title: '默认会话' });
  assert.equal(sess.status, 201);
  const sessionId = sess.body.id as string;

  const created = await api('POST', '/v1/tasks',
    { projectId, sessionId, input: '新增 hello 模块并验证' },
    { 'x-client-request-id': 'it-req-1' });
  assert.equal(created.status, 201);
  const taskId = (created.body.task as Record<string, unknown>).id as string;

  // 重复提交同一 clientRequestId：不产生第二个任务
  const dup = await api('POST', '/v1/tasks',
    { projectId, sessionId, input: '新增 hello 模块并验证' },
    { 'x-client-request-id': 'it-req-1' });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.deduplicated, true);
  assert.equal((dup.body.task as Record<string, unknown>).id, taskId);

  const done = await waitTaskState(taskId, ['completed']);
  assert.ok(typeof done.summary === 'string' && done.summary.length > 0);

  // 文件真实写入项目目录
  assert.equal(fs.readFileSync(path.join(projectDir, 'src/hello.ts'), 'utf8'), 'export const hello = "world";\n');
  assert.ok(fs.existsSync(path.join(projectDir, 'README.md')));

  // 修改审查：变更文件列表
  const changes = await api('GET', `/v1/tasks/${taskId}/changes`);
  assert.equal(changes.status, 200);
  const files = changes.body.files as { path: string; changeKind: string }[];
  assert.equal(files.length, 2);
  assert.ok(files.every(f => f.changeKind === 'created'));

  // 事件流含状态与工具事件（断线重连补发依据）
  const events = await api('GET', `/v1/events?after=0&projectId=${projectId}`);
  const types = (events.body.events as { type: string }[]).map(e => e.type);
  assert.ok(types.includes('task.state'));
  assert.ok(types.includes('tool.start'));
  assert.ok(types.includes('tool.end'));

  // 撤销：任务新建文件被删除
  const undo = await api('POST', `/v1/tasks/${taskId}/undo`);
  assert.equal(undo.status, 200);
  assert.equal(undo.body.hasConflict, false);
  assert.ok(!fs.existsSync(path.join(projectDir, 'src/hello.ts')));
  assert.ok(!fs.existsSync(path.join(projectDir, 'README.md')));
  // 任务前已有文件不受影响
  assert.equal(fs.readFileSync(path.join(projectDir, 'existing.ts'), 'utf8'), 'console.log("old");\n');
});

test('端到端：第二个项目独立排队执行，已有文件不受任务影响', async () => {
  const projectDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-it-proj2-'));
  fs.writeFileSync(path.join(projectDir2, 'existing.ts'), 'console.log("old");\n');
  try {
    const proj = await api('POST', '/v1/projects', { name: 'demo2', path: projectDir2 });
    assert.equal(proj.status, 201);
    const projectId = proj.body.id as string;
    const sess = await api('POST', `/v1/projects/${projectId}/sessions`, { title: 's2' });
    const sessionId = sess.body.id as string;

    const t = await api('POST', '/v1/tasks',
      { projectId, sessionId, input: '搭建 demo' },
      { 'x-client-request-id': 'it-req-2' });
    const taskId = (t.body.task as Record<string, unknown>).id as string;
    await waitTaskState(taskId, ['completed']);
    // 任务新增了自己的文件，任务前已有文件内容不变
    assert.equal(fs.readFileSync(path.join(projectDir2, 'existing.ts'), 'utf8'), 'console.log("old");\n');
    assert.ok(fs.existsSync(path.join(projectDir2, 'src/hello.ts')));
  } finally {
    fs.rmSync(projectDir2, { recursive: true, force: true });
  }
});
