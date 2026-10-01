import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import { createApiServer } from '../src/api/server.ts';
import type { ApiDeps } from '../src/api/server.ts';
import type { EngineFacade } from '../src/types.ts';
import { CodexWatchManager, codexPathInProject, normalizeCodexPath } from '../src/codexwatch/codexWatchManager.ts';
import type { CodexTask } from '../src/codexwatch/codexWatchManager.ts';
import { makeCodexWatchRoutes } from '../src/codexwatch/codexWatchRoutes.ts';
import { AuthService } from '../src/api/auth.ts';

const tmpDirs: string[] = [];

after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-codexwatch-'));
  tmpDirs.push(d);
  return d;
}

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

const QUEUE_SCHEMA = `
CREATE TABLE queued_items (
  id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT,
  queue_order INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER
);
CREATE TABLE queued_thread_revisions (thread_id TEXT PRIMARY KEY, revision INTEGER);`;

const HISTORY_SCHEMA = `
CREATE TABLE thread_turns (
  thread_id TEXT, turn_id TEXT, status TEXT,
  started_at INTEGER, duration_ms INTEGER, rollout_ordinal INTEGER
);
CREATE TABLE thread_items (
  thread_id TEXT, item_type TEXT, item_json TEXT,
  created_at_ms INTEGER, rollout_ordinal INTEGER
);`;

const GOALS_SCHEMA = `
CREATE TABLE thread_goals (
  thread_id TEXT, goal_id TEXT, objective TEXT, status TEXT, time_used_seconds INTEGER
);`;

function writeDb(file: string, schema: string, seed?: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(file);
  db.exec(schema);
  if (seed !== undefined) seed(db);
  db.close();
}

interface ThreadSeed {
  id: string;
  title?: string;
  preview?: string;
  cwd?: string;
  model?: string;
  isPinned?: number;
  archived?: number;
  source?: string | null;
  originator?: string | null;
  projectId?: string | null;
  rolloutPath?: string | null;
  updatedAtMs?: number;
  recencyAtMs?: number;
}

function insertThread(db: DatabaseSync, t: ThreadSeed): void {
  db.prepare(
    `INSERT INTO threads (id, rollout_path, title, name, preview, cwd, model, is_pinned, archived,
       thread_source, originator, project_id, created_at_ms, updated_at_ms, recency_at_ms, thread_section_id)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    t.id,
    t.rolloutPath ?? null,
    t.title ?? null,
    t.preview ?? null,
    t.cwd ?? null,
    t.model ?? null,
    t.isPinned ?? 0,
    t.archived ?? 0,
    t.source ?? null,
    t.originator ?? null,
    t.projectId ?? null,
    t.updatedAtMs ?? 0,
    t.updatedAtMs ?? 0,
    t.recencyAtMs ?? 0,
  );
}

/** 全量夹具：state/queue/history/goals 四库齐备；state 另造一个低版本诱饵文件验证选最大版本号 */
function seedFullDir(): string {
  const dir = mkTmp();
  writeDb(path.join(dir, 'state_1.sqlite'), STATE_SCHEMA, db => {
    insertThread(db, { id: 'decoy-old-version', title: '诱饵', preview: '不应出现', source: 'user' });
  });
  writeDb(path.join(dir, 'state_5.sqlite'), STATE_SCHEMA, db => {
    db.prepare('INSERT INTO projects (id, name, position) VALUES (?, ?, ?)').run('p1', 'demo-app', 0);
    db.prepare('INSERT INTO project_roots (project_id, path) VALUES (?, ?)').run('p1', '/repo/demo');
    insertThread(db, {
      id: 'thread-aaa', title: '修复登录 bug', preview: '请修复登录页', cwd: '/repo/demo',
      model: 'gpt-5-codex', isPinned: 1, source: 'user', projectId: 'p1',
      updatedAtMs: 1_000_000, recencyAtMs: 1_000_000,
    });
    insertThread(db, {
      id: 'thread-bbb', preview: '整理文档', cwd: '/repo/lib',
      source: null, originator: 'Codex Desktop', projectId: 'p2',
      updatedAtMs: 900_000, recencyAtMs: 900_000,
    });
    insertThread(db, {
      id: 'thread-ccc', preview: '暂停的任务', cwd: '/repo/demo', source: 'user', projectId: 'p1',
      updatedAtMs: 800_000, recencyAtMs: 800_000,
    });
    insertThread(db, {
      id: 'thread-ddd', preview: '失败的任务', cwd: '/repo/demo', source: 'user', projectId: 'p1',
      updatedAtMs: 700_000, recencyAtMs: 700_000,
    });
    insertThread(db, { id: 'thread-archived', preview: 'x', archived: 1, source: 'user' });
    insertThread(db, { id: 'thread-nopreview', preview: '', source: 'user' });
    insertThread(db, { id: 'thread-subagent', preview: 'x', source: 'subagent' });
    insertThread(db, {
      id: 'thread-noproject', preview: 'x', source: null, originator: 'Codex Desktop', projectId: null,
    });
  });
  writeDb(path.join(dir, 'queue_1.sqlite'), QUEUE_SCHEMA, db => {
    db.prepare(
      'INSERT INTO queued_items (id, thread_id, payload_json, queue_order, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'q1', 'thread-aaa',
      JSON.stringify({ UserInput: { content: [{ type: 'input_text', text: '排队消息' }] } }),
      1, 1_000_100, 1_000_100,
    );
    db.prepare('INSERT INTO queued_thread_revisions (thread_id, revision) VALUES (?, ?)').run('thread-aaa', 3);
  });
  writeDb(path.join(dir, 'thread_history_1.sqlite'), HISTORY_SCHEMA, db => {
    db.prepare('INSERT INTO thread_turns (thread_id, turn_id, status, started_at, duration_ms, rollout_ordinal) VALUES (?, ?, ?, ?, ?, ?)')
      .run('thread-aaa', 'turn-1', 'inProgress', 1_000_000, 0, 1);
    db.prepare('INSERT INTO thread_turns (thread_id, turn_id, status, started_at, duration_ms, rollout_ordinal) VALUES (?, ?, ?, ?, ?, ?)')
      .run('thread-bbb', 'turn-2', 'completed', 900_000, 5000, 1);
    db.prepare('INSERT INTO thread_turns (thread_id, turn_id, status, started_at, duration_ms, rollout_ordinal) VALUES (?, ?, ?, ?, ?, ?)')
      .run('thread-ccc', 'turn-3', 'interrupted', 800_000, 1000, 1);
    db.prepare('INSERT INTO thread_turns (thread_id, turn_id, status, started_at, duration_ms, rollout_ordinal) VALUES (?, ?, ?, ?, ?, ?)')
      .run('thread-ddd', 'turn-4', 'failed', 700_000, 1000, 1);
    db.prepare('INSERT INTO thread_items (thread_id, item_type, item_json, created_at_ms, rollout_ordinal) VALUES (?, ?, ?, ?, ?)')
      .run('thread-aaa', 'userMessage', JSON.stringify({ id: 'msg-u1', content: [{ type: 'input_text', text: '第一条消息' }] }), 1_000_000, 1);
    db.prepare('INSERT INTO thread_items (thread_id, item_type, item_json, created_at_ms, rollout_ordinal) VALUES (?, ?, ?, ?, ?)')
      .run('thread-aaa', 'agentMessage', JSON.stringify({ id: 'msg-a1', text: '好的，已处理' }), 1_000_500, 2);
  });
  writeDb(path.join(dir, 'goals_1.sqlite'), GOALS_SCHEMA, db => {
    db.prepare('INSERT INTO thread_goals (thread_id, goal_id, objective, status, time_used_seconds) VALUES (?, ?, ?, ?, ?)')
      .run('thread-bbb', 'goal-1', '完成重构', 'active', 90);
  });
  return dir;
}

interface WatchEvent {
  projectId: string | null;
  type: string;
  payload: Record<string, unknown>;
}

function makeManager(codexDir: string, events?: WatchEvent[]): CodexWatchManager {
  return new CodexWatchManager({
    codexDir,
    appendEvent: (projectId, type, payload) => events?.push({ projectId, type, payload }),
  });
}

// ---------------------------------------------------------------- listTasks

test('listTasks: 过滤 archived/空 preview/subagent，选最大版本号 state 库', async () => {
  const m = makeManager(seedFullDir());
  const { available, tasks } = await m.listTasks();
  assert.equal(available, true);
  const ids = tasks.map(t => t.id);
  assert.deepEqual(ids.sort(), ['thread-aaa', 'thread-bbb', 'thread-ccc', 'thread-ddd']);
  assert.ok(!ids.includes('decoy-old-version'), '应忽略低版本 state_1.sqlite');

  const aaa = tasks.find(t => t.id === 'thread-aaa')!;
  assert.equal(aaa.title, '修复登录 bug');
  assert.equal(aaa.project, 'demo-app');
  assert.equal(aaa.projectId, 'p1');
  assert.equal(aaa.pinned, true);
  assert.equal(aaa.queuedCount, 1);
  assert.equal(aaa.updatedAt, 1_000_500);

  const bbb = tasks.find(t => t.id === 'thread-bbb')!;
  assert.equal(bbb.project, 'lib');
  // p2 无 projects 行：projectId 取自 JOIN 结果，为 null（与参考实现一致）
  assert.equal(bbb.projectId, null);
  assert.deepEqual(bbb.goal, {
    id: 'goal-1',
    objective: '完成重构',
    status: { state: 'active', label: '执行中', tone: 'blue' },
    elapsedSeconds: 90,
    elapsed: '1 分钟',
  });
});

test('listTasks: 状态映射 running/done/paused/failed', async () => {
  const m = makeManager(seedFullDir());
  const { tasks } = await m.listTasks();
  const byId = new Map(tasks.map(t => [t.id, t]));
  assert.deepEqual(byId.get('thread-aaa')?.progress, { state: 'running', label: '进行中', tone: 'blue' });
  assert.deepEqual(byId.get('thread-bbb')?.progress, { state: 'done', label: '已完成', tone: 'green' });
  assert.deepEqual(byId.get('thread-ccc')?.progress, { state: 'paused', label: '已暂停', tone: 'amber' });
  assert.deepEqual(byId.get('thread-ddd')?.progress, { state: 'failed', label: '需处理', tone: 'red' });
});

// ---------------------------------------------------------------- getTask

test('getTask: thread_items 消息抽取 + 排队消息', async () => {
  const m = makeManager(seedFullDir());
  const detail = await m.getTask('thread-aaa');
  assert.ok(detail !== null);
  assert.equal(detail.task.id, 'thread-aaa');
  assert.deepEqual(
    detail.messages.map(msg => ({ id: msg.id, role: msg.role, text: msg.text, pending: msg.pending })),
    [
      { id: 'msg-u1', role: 'user', text: '第一条消息', pending: false },
      { id: 'msg-a1', role: 'assistant', text: '好的，已处理', pending: false },
    ],
  );
  assert.equal(detail.queuedTasks.length, 1);
  assert.equal(detail.queuedTasks[0]?.text, '排队消息');
  assert.equal(detail.queuedTasks[0]?.pending, true);
  assert.equal(detail.queuedTasks[0]?.queueOrder, 1);
  assert.equal(detail.queuedTasks[0]?.queueRevision, 3);

  assert.equal(await m.getTask('no-such-thread'), null);
});

test('getTask: history 库缺失时回退 rollout JSONL 解析', async () => {
  const dir = mkTmp();
  const rolloutPath = path.join(dir, 'rollout-t9.jsonl');
  fs.writeFileSync(
    rolloutPath,
    [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'r1', content: [{ type: 'input_text', text: 'rollout 用户消息' }] } }),
      JSON.stringify({ timestamp: '2026-01-01T00:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'r2', content: [{ type: 'output_text', text: 'rollout 回复' }] } }),
      JSON.stringify({ timestamp: '2026-01-01T00:02:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n',
    'utf8',
  );
  writeDb(path.join(dir, 'state_1.sqlite'), STATE_SCHEMA, db => {
    insertThread(db, {
      id: 'thread-t9', preview: '老任务', cwd: '/repo/t9', source: 'user',
      rolloutPath, updatedAtMs: 100, recencyAtMs: 100,
    });
  });

  const m = makeManager(dir);
  const { available, tasks } = await m.listTasks();
  assert.equal(available, true);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.queuedCount, 0);
  assert.equal(tasks[0]?.progress.state, 'idle');

  const detail = await m.getTask('thread-t9');
  assert.ok(detail !== null);
  assert.deepEqual(
    detail.messages.map(msg => ({ id: msg.id, role: msg.role, text: msg.text })),
    [
      { id: 'r1', role: 'user', text: 'rollout 用户消息' },
      { id: 'r2', role: 'assistant', text: 'rollout 回复' },
    ],
  );
  assert.deepEqual(detail.queuedTasks, []);
});

// ---------------------------------------------------------------- 降级

test('库完全缺失时 available=false 不抛错', async () => {
  const m = makeManager(path.join(mkTmp(), 'no-such-dir'));
  const list = await m.listTasks();
  assert.deepEqual(list, { available: false, tasks: [] });
  assert.equal(await m.getTask('whatever'), null);
  await m.refresh();
});

// ---------------------------------------------------------------- 轮询事件

test('refresh: 签名变化才发射 codex.task.state / codex.task.updated', async () => {
  const dir = seedFullDir();
  const events: WatchEvent[] = [];
  const m = makeManager(dir, events);

  await m.refresh();
  const stateEvents = events.filter(e => e.type === 'codex.task.state');
  const updatedEvents = events.filter(e => e.type === 'codex.task.updated');
  assert.equal(stateEvents.length, 1);
  assert.deepEqual(stateEvents[0]?.payload, { available: true, taskCount: 4 });
  assert.equal(updatedEvents.length, 4);

  await m.refresh();
  assert.equal(events.length, 5, '无变化不应重复发射');

  const db = new DatabaseSync(path.join(dir, 'thread_history_1.sqlite'));
  db.prepare('INSERT INTO thread_turns (thread_id, turn_id, status, started_at, duration_ms, rollout_ordinal) VALUES (?, ?, ?, ?, ?, ?)')
    .run('thread-ccc', 'turn-3b', 'completed', 1_100_000, 500, 2);
  db.close();

  await m.refresh();
  const newState = events.filter(e => e.type === 'codex.task.state');
  assert.equal(newState.length, 2);
  const newUpdated = events.filter(e => e.type === 'codex.task.updated');
  assert.equal(newUpdated.length, 5);
  const changed = newUpdated[4]?.payload.task as CodexTask;
  assert.equal(changed.id, 'thread-ccc');
  assert.equal(changed.progress.state, 'done');
});

// ---------------------------------------------------------------- API

const TOKEN = 'test-token-0123456789';

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
  manager: CodexWatchManager,
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
    extraRoutes: makeCodexWatchRoutes(manager),
    codexWatch: manager,
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

test('API: legacy token 200，无 token 401，详情 404', async (t) => {
  const m = makeManager(seedFullDir());
  const { base } = await setupApi(t, m);

  const noToken = await fetch(`${base}/v1/codex/tasks`);
  assert.equal(noToken.status, 401);

  const list = await fetch(`${base}/v1/codex/tasks`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(list.status, 200);
  const listJson = (await list.json()) as { available: boolean; tasks: CodexTask[] };
  assert.equal(listJson.available, true);
  assert.equal(listJson.tasks.length, 4);

  const detail = await fetch(`${base}/v1/codex/tasks/thread-aaa`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(detail.status, 200);
  const detailJson = (await detail.json()) as { available: boolean; task: CodexTask; messages: unknown[]; queuedTasks: unknown[] };
  assert.equal(detailJson.available, true);
  assert.equal(detailJson.task.id, 'thread-aaa');
  assert.equal(detailJson.messages.length, 2);
  assert.equal(detailJson.queuedTasks.length, 1);

  const missing = await fetch(`${base}/v1/codex/tasks/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(missing.status, 404);
});

test('API: 库缺失时列表仍 200 且 available=false', async (t) => {
  const m = makeManager(path.join(mkTmp(), 'no-such-dir'));
  const { base } = await setupApi(t, m);
  const res = await fetch(`${base}/v1/codex/tasks`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { available: boolean; tasks: unknown[] };
  assert.equal(json.available, false);
  assert.deepEqual(json.tasks, []);
});

// ---------------------------------------------------------------- 项目维度路径匹配

test('路径归一化与归属判断：\\?\\ 前缀、大小写、子目录、尾部斜杠', () => {
  assert.equal(normalizeCodexPath('\\\\?\\E:\\GRSL\\P1.2\\'), 'e:/grsl/p1.2');
  assert.equal(normalizeCodexPath('E:/GRSL/'), 'e:/grsl');
  assert.equal(normalizeCodexPath('\\\\?\\UNC\\nas\\share\\x'), '//nas/share/x');

  assert.equal(codexPathInProject('E:\\GRSL', 'e:/grsl'), true);
  assert.equal(codexPathInProject('\\\\?\\E:\\GRSL\\P1.2', 'E:\\GRSL'), true);
  assert.equal(codexPathInProject('E:\\GRSL2', 'E:\\GRSL'), false, '前缀相同但不是子目录');
  assert.equal(codexPathInProject('E:\\GRSL', 'E:\\GRSL\\P1.2'), false, '父目录不属于子项目');
  assert.equal(codexPathInProject('', 'E:\\GRSL'), false);
});

test('listTasksForProject: 按项目路径过滤（大小写不敏感、含子目录）', async () => {
  const m = makeManager(seedFullDir());
  const demo = await m.listTasksForProject('/Repo/Demo/');
  assert.deepEqual(demo.available, true);
  assert.deepEqual(demo.tasks.map(t => t.id).sort(), ['thread-aaa', 'thread-ccc', 'thread-ddd']);

  const lib = await m.listTasksForProject('/repo/lib');
  assert.deepEqual(lib.tasks.map(t => t.id), ['thread-bbb']);

  const none = await m.listTasksForProject('/repo/other');
  assert.deepEqual(none.tasks, []);
});

// ---------------------------------------------------------------- 事件 projectId

test('refresh: codex.task.updated 按 cwd 打项目 ID，全局摘要保持 null', async () => {
  const dir = seedFullDir();
  const events: WatchEvent[] = [];
  const m = new CodexWatchManager({
    codexDir: dir,
    appendEvent: (projectId, type, payload) => events.push({ projectId, type, payload }),
    resolveProjectId: cwd => (cwd.startsWith('/repo/demo') ? 'proj-a' : null),
  });

  await m.refresh();
  const state = events.find(e => e.type === 'codex.task.state');
  assert.equal(state?.projectId, null);
  const updated = events.filter(e => e.type === 'codex.task.updated');
  assert.equal(updated.length, 4);
  const byId = new Map(updated.map(e => [(e.payload.task as CodexTask).id, e.projectId]));
  assert.equal(byId.get('thread-aaa'), 'proj-a');
  assert.equal(byId.get('thread-ccc'), 'proj-a');
  assert.equal(byId.get('thread-ddd'), 'proj-a');
  assert.equal(byId.get('thread-bbb'), null, '未命中项目路径的线程事件 projectId 为 null');
});

// ---------------------------------------------------------------- 项目作用域路由

test('API: 项目维度路由——viewer 可读、非成员 403、跨项目 threadId 404、无 token 401', async (t) => {
  const m = makeManager(seedFullDir());
  const { base, repo, authService } = await setupApi(t, m);
  const projA = repo.projects.create({ name: 'A', path: '/repo/demo', isGit: false });
  const projB = repo.projects.create({ name: 'B', path: '/repo/lib', isGit: false });

  const noToken = await fetch(`${base}/v1/projects/${projA.id}/codex/tasks`);
  assert.equal(noToken.status, 401);

  const legacyList = await fetch(`${base}/v1/projects/${projA.id}/codex/tasks`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(legacyList.status, 200);
  const legacyJson = (await legacyList.json()) as { available: boolean; tasks: CodexTask[] };
  assert.equal(legacyJson.available, true);
  assert.deepEqual(legacyJson.tasks.map(t => t.id).sort(), ['thread-aaa', 'thread-ccc', 'thread-ddd']);

  const legacyDetail = await fetch(`${base}/v1/projects/${projA.id}/codex/tasks/thread-aaa`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(legacyDetail.status, 200);

  // thread-bbb 的 cwd 属于 projB，跨项目读取拒绝
  const crossProject = await fetch(`${base}/v1/projects/${projA.id}/codex/tasks/thread-bbb`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(crossProject.status, 404);

  const missingProject = await fetch(`${base}/v1/projects/no-such/codex/tasks`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(missingProject.status, 404);

  // 设备会话：viewer 成员可读，非成员 403
  const viewer = authService.createDevice('viewer-phone');
  repo.projectMembers.setRole(projA.id, viewer.id, 'viewer');
  const viewerToken = authService.issueSession(viewer.id).accessToken;

  const viewerList = await fetch(`${base}/v1/projects/${projA.id}/codex/tasks`, {
    headers: { authorization: `Bearer ${viewerToken}` },
  });
  assert.equal(viewerList.status, 200);
  assert.equal(((await viewerList.json()) as { tasks: unknown[] }).tasks.length, 3);

  const stranger = authService.createDevice('stranger-phone');
  const strangerToken = authService.issueSession(stranger.id).accessToken;
  const forbiddenList = await fetch(`${base}/v1/projects/${projA.id}/codex/tasks`, {
    headers: { authorization: `Bearer ${strangerToken}` },
  });
  assert.equal(forbiddenList.status, 403);
  const forbiddenDetail = await fetch(`${base}/v1/projects/${projA.id}/codex/tasks/thread-aaa`, {
    headers: { authorization: `Bearer ${strangerToken}` },
  });
  assert.equal(forbiddenDetail.status, 403);
});
