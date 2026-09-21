import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelAdapter, Project, Session, Task, TaskState } from '../src/types.ts';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import { SnapshotStore } from '../src/snapshot/snapshot.ts';
import { snapshotRepoAdapter } from '../src/snapshot/repoAdapter.ts';
import { SecretsStore } from '../src/ai/secrets.ts';
import { MockAdapter } from '../src/ai/mock.ts';
import type { MockTurn } from '../src/ai/mock.ts';
import { TaskEngine } from '../src/engine/engine.ts';

interface Env {
  dir: string;
  projectRoot: string;
  repo: Repo;
  engine: TaskEngine;
  project: Project;
  session: Session;
}

function makeEnv(resolveAdapter: (modelConfigId: string | null) => ModelAdapter): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-engine-'));
  const projectRoot = path.join(dir, 'proj');
  fs.mkdirSync(projectRoot, { recursive: true });
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new Repo(db);
  const engine = new TaskEngine({
    repo,
    snapshots: new SnapshotStore(snapshotRepoAdapter(repo), dataDir),
    secrets: new SecretsStore(dataDir),
    dataDir,
    resolveAdapter,
  });
  const project = repo.projects.create({ name: 'p', path: projectRoot, isGit: false });
  const session = repo.sessions.create({ projectId: project.id, title: 's' });
  return { dir, projectRoot, repo, engine, project, session };
}

function submit(env: Env, input: string, clientRequestId: string): Promise<{ task: Task; deduplicated: boolean }> {
  return env.engine.submitTask({
    projectId: env.project.id,
    sessionId: env.session.id,
    input,
    clientRequestId,
  });
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`等待超时: ${label}`);
}

async function waitTaskState(repo: Repo, taskId: string, states: TaskState[], timeoutMs = 5000): Promise<Task> {
  await waitFor(() => {
    const t = repo.tasks.getById(taskId);
    return t !== null && states.includes(t.state);
  }, `任务进入 ${states.join('/')}`, timeoutMs);
  const t = repo.tasks.getById(taskId);
  assert.ok(t);
  return t;
}

function cleanup(env: Env): void {
  fs.rmSync(env.dir, { recursive: true, force: true });
}

test('persisted auto approval finishes without a connected client and progress survives reattachment', async t => {
  const adapter = new MockAdapter([
    { text: '准备删除测试文件', toolCalls: [{ name: 'delete_file', args: { path: 'delete-me.txt' } }] },
    { toolCalls: [{ name: 'finish', args: { summary: '后台完成' } }] },
  ]);
  const env = makeEnv(() => adapter);
  t.after(() => cleanup(env));
  fs.writeFileSync(path.join(env.projectRoot, 'delete-me.txt'), 'test');
  const { task } = await env.engine.submitTask({ projectId: env.project.id, sessionId: env.session.id,
    input: 'delete', clientRequestId: 'offline', approvalMode: 'auto' });
  await waitTaskState(env.repo, task.id, ['completed']);
  assert.equal(env.repo.tasks.getById(task.id)?.approvalMode, 'auto');
  assert.equal(env.repo.approvals.pendingByTask(task.id).length, 0);
  assert.equal(fs.existsSync(path.join(env.projectRoot, 'delete-me.txt')), false);
  assert.ok(env.repo.events.listByTask(task.id).some(e => e.payload.text === '准备删除测试文件'));
});

// a. 完整闭环：write_file ×2 + run_command + finish
test('switching a waiting task to full approves pending and future operations without a client', async t => {
  const adapter = new MockAdapter([
    { toolCalls: [{ name: 'delete_file', args: { path: 'first.txt' } }] },
    { toolCalls: [{ name: 'delete_file', args: { path: 'second.txt' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: '.env', content: 'SYNTHETIC=test' } }] },
    { toolCalls: [{ name: 'finish', args: { summary: 'finished unattended' } }] },
  ]);
  const env = makeEnv(() => adapter);
  t.after(() => cleanup(env));
  for (const name of ['first.txt', 'second.txt']) fs.writeFileSync(path.join(env.projectRoot, name), 'test');
  const { task } = await submit(env, 'test', 'mode-change');
  await waitTaskState(env.repo, task.id, ['awaiting_approval']);
  await env.engine.setApprovalMode(task.id, 'full');
  const done = await waitTaskState(env.repo, task.id, ['completed']);
  assert.equal(done.approvalMode, 'full');
  assert.equal(done.summary, 'finished unattended');
  assert.equal(env.repo.approvals.pendingByTask(task.id).length, 0);
  assert.equal(fs.existsSync(path.join(env.projectRoot, 'second.txt')), false);
  assert.equal(fs.readFileSync(path.join(env.projectRoot, '.env'), 'utf8'), 'SYNTHETIC=test');
  await assert.rejects(env.engine.setApprovalMode(task.id, 'manual'), /already ended/);
});

test('完整闭环：写文件、跑命令、finish 完成任务', async t => {
  const adapter = new MockAdapter([
    { toolCalls: [{ name: 'write_file', args: { path: 'a.ts', content: 'export const a = 1;\n' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'b.ts', content: 'export const b = 2;\n' } }] },
    { toolCalls: [{ name: 'run_command', args: { command: 'node -e "console.log(1)"' } }] },
    { toolCalls: [{ name: 'finish', args: { summary: '完成 a.ts b.ts 并验证' } }] },
  ]);
  const env = makeEnv(() => adapter);
  t.after(() => cleanup(env));

  const { task, deduplicated } = await submit(env, '创建两个文件并验证', 'req-a');
  assert.equal(deduplicated, false);

  const done = await waitTaskState(env.repo, task.id, ['completed']);
  assert.equal(done.summary, '完成 a.ts b.ts 并验证');
  assert.equal(fs.readFileSync(path.join(env.projectRoot, 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(fs.readFileSync(path.join(env.projectRoot, 'b.ts'), 'utf8'), 'export const b = 2;\n');

  const toolCalls = env.repo.toolCalls.listByTask(task.id);
  assert.equal(toolCalls.length, 4);
  assert.ok(toolCalls.every(tc => tc.state === 'done'));
  const cmd = toolCalls.find(tc => tc.tool === 'run_command');
  assert.ok(cmd);
  assert.match(cmd.result ?? '', /退出码 0/);
  assert.match(cmd.result ?? '', /1/);

  const types = new Set(env.repo.events.listAfter(0, env.project.id).map(e => e.type));
  assert.ok(types.has('tool.start'));
  assert.ok(types.has('tool.end'));
  assert.ok(types.has('task.state'));
});

// b. 幂等去重
test('同 clientRequestId 重复提交去重', async t => {
  const env = makeEnv(() => new MockAdapter([]));
  t.after(() => cleanup(env));

  const first = await submit(env, '做点什么', 'req-dup');
  const second = await submit(env, '做点什么', 'req-dup');
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.task.id, first.task.id);
  assert.equal(env.repo.tasks.listByProject(env.project.id).length, 1);

  await waitTaskState(env.repo, first.task.id, ['completed']);
});

// c1. 审批流 approve
test('审批 approve：命令真实执行', async t => {
  const adapter = new MockAdapter([
    { toolCalls: [{ name: 'run_command', args: { command: 'npm --version' } }] },
    { toolCalls: [{ name: 'finish', args: { summary: '审批后执行完成' } }] },
  ]);
  const env = makeEnv(() => adapter);
  t.after(() => cleanup(env));

  const { task } = await submit(env, '查 npm 版本', 'req-approve');
  await waitTaskState(env.repo, task.id, ['awaiting_approval']);

  const pending = env.repo.approvals.pendingByTask(task.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.state, 'pending');

  const decided = await env.engine.decideApproval(pending[0]!.id, 'approve');
  assert.equal(decided.state, 'approved');

  const done = await waitTaskState(env.repo, task.id, ['completed'], 15000);
  assert.equal(done.summary, '审批后执行完成');
  const tc = env.repo.toolCalls.listByTask(task.id).find(c => c.tool === 'run_command');
  assert.ok(tc);
  assert.equal(tc.state, 'done');
  assert.match(tc.result ?? '', /退出码 0/);
});

// c2. 审批流 reject
test('审批 reject：模型收到拒绝信息并 finish', async t => {
  const adapter = new MockAdapter([
    { toolCalls: [{ name: 'run_command', args: { command: 'npm --version' } }] },
    { toolCalls: [{ name: 'finish', args: { summary: '用户拒绝，改用说明答复' } }] },
  ]);
  const env = makeEnv(() => adapter);
  t.after(() => cleanup(env));

  const { task } = await submit(env, '查 npm 版本', 'req-reject');
  await waitTaskState(env.repo, task.id, ['awaiting_approval']);

  const pending = env.repo.approvals.pendingByTask(task.id);
  assert.equal(pending.length, 1);
  const decided = await env.engine.decideApproval(pending[0]!.id, 'reject', '不允许执行');
  assert.equal(decided.state, 'rejected');
  assert.equal(decided.note, '不允许执行');

  const done = await waitTaskState(env.repo, task.id, ['completed']);
  assert.equal(done.summary, '用户拒绝，改用说明答复');
  const tc = env.repo.toolCalls.listByTask(task.id).find(c => c.tool === 'run_command');
  assert.ok(tc);
  assert.equal(tc.state, 'rejected');
  assert.match(tc.result ?? '', /用户拒绝了该操作/);
});

// d. 同项目串行
test('同项目任务串行执行', async t => {
  const scripts: MockTurn[][] = [
    [
      { toolCalls: [{ name: 'run_command', args: { command: 'node -e "setTimeout(()=>{},400)"' } }] },
      { toolCalls: [{ name: 'finish', args: { summary: 't1 done' } }] },
    ],
    [], // t2 脚本为空，耗尽后自动 finish
  ];
  const env = makeEnv(() => new MockAdapter(scripts.shift() ?? []));
  t.after(() => cleanup(env));

  const first = await submit(env, '任务一', 'req-s1');
  await waitTaskState(env.repo, first.task.id, ['running']);

  const second = await submit(env, '任务二', 'req-s2');
  assert.equal(second.task.state, 'queued');

  await waitTaskState(env.repo, first.task.id, ['completed']);
  const t2 = await waitTaskState(env.repo, second.task.id, ['completed']);
  assert.ok(t2.startedAt !== null && t2.startedAt >= (env.repo.tasks.getById(first.task.id)!.endedAt ?? 0));
});

// e. stopTask 中止执行中的任务
test('stopTask：执行中停止，子进程被中止', async t => {
  const adapter = new MockAdapter([
    { toolCalls: [{ name: 'run_command', args: { command: 'node -e "setTimeout(()=>{},60000)"' } }] },
  ]);
  const env = makeEnv(() => adapter);
  t.after(() => cleanup(env));

  const { task } = await submit(env, '长时间运行', 'req-stop');
  await waitFor(
    () => env.repo.toolCalls.listByTask(task.id).some(tc => tc.state === 'running'),
    '工具调用进入 running',
  );

  const stopping = await env.engine.stopTask(task.id);
  assert.ok(stopping.state === 'stopping' || stopping.state === 'stopped');

  const stopped = await waitTaskState(env.repo, task.id, ['stopped']);
  assert.equal(stopped.state, 'stopped');
});

// f. undoTask 集成：恢复被修改的已有文件
test('undoTask：任务修改的文件恢复原文', async t => {
  const adapter = new MockAdapter([
    { toolCalls: [{ name: 'write_file', args: { path: 'exist.txt', content: 'v2' } }] },
    { toolCalls: [{ name: 'finish', args: { summary: '改了 exist.txt' } }] },
  ]);
  const env = makeEnv(() => adapter);
  t.after(() => cleanup(env));
  const file = path.join(env.projectRoot, 'exist.txt');
  fs.writeFileSync(file, 'v1');

  const { task } = await submit(env, '修改 exist.txt', 'req-undo');
  await waitTaskState(env.repo, task.id, ['completed']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v2');

  const report = await env.engine.undoTask(task.id);
  assert.equal(report.hasConflict, false);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]!.status, 'restored');
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1');
});

// g. recoverOnBoot / resumeInterrupted / 非终态 undo 拒绝
test('recoverOnBoot 置 interrupted，resumeInterrupted 重新排队', async t => {
  const env = makeEnv(() => new MockAdapter([]));
  t.after(() => cleanup(env));

  const task = env.repo.tasks.create({
    projectId: env.project.id,
    sessionId: env.session.id,
    input: '模拟崩溃前的任务',
    clientRequestId: 'req-boot',
  });
  env.repo.tasks.updateState(task.id, 'running');

  await assert.rejects(() => env.engine.undoTask(task.id), /终态/);

  env.engine.recoverOnBoot();
  const interrupted = env.repo.tasks.getById(task.id);
  assert.equal(interrupted!.state, 'interrupted');
  const types = env.repo.events.listAfter(0, env.project.id).map(e => e.type);
  assert.ok(types.includes('task.state'));

  const resumed = await env.engine.resumeInterrupted(task.id);
  assert.equal(resumed.state, 'queued');
  assert.match(resumed.summary ?? '', /重新排队/);
});
