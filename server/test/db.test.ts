import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo, RepoError } from '../src/db/repo.ts';
import { MIGRATIONS } from '../src/db/schema.ts';
import { ERR } from '../src/types.ts';
import type { Project, Session, Task } from '../src/types.ts';

function setup(): { db: DatabaseSync; repo: Repo } {
  const db = openDatabase(':memory:');
  migrate(db);
  return { db, repo: new Repo(db) };
}

test('upgrade preserves existing task data and defaults its approval mode to manual', () => {
  const db = openDatabase(':memory:');
  db.exec(MIGRATIONS[1]!);
  db.prepare("INSERT INTO kv_meta VALUES ('schema_version', '1')").run();
  db.prepare("INSERT INTO projects VALUES ('p', 'demo', '/demo', 0, 1)").run();
  db.prepare("INSERT INTO sessions VALUES ('s', 'p', '测试会话', 1)").run();
  db.prepare("INSERT INTO tasks VALUES ('t', 'p', 's', 1, 'completed', '原始需求', '完成', NULL, 'r', 1, 1, 2)").run();
  migrate(db);
  const task = new Repo(db).tasks.getById('t');
  assert.equal(task?.input, '原始需求');
  assert.equal(task?.approvalMode, 'manual');
  db.close();
});

function makeTask(repo: Repo, clientRequestId = `cr-${Math.random()}`): {
  project: Project;
  session: Session;
  task: Task;
} {
  const project = repo.projects.create({ name: 'demo', path: `/p/${Math.random()}`, isGit: true });
  const session = repo.sessions.create({ projectId: project.id, title: 's1' });
  const task = repo.tasks.create({
    projectId: project.id,
    sessionId: session.id,
    input: 'do something',
    clientRequestId,
  });
  return { project, session, task };
}

test('migration: fresh db reaches schema_version 2 and re-migration is a no-op', () => {
  const { db, repo } = setup();
  assert.equal(repo.kv.get('schema_version'), '2');
  migrate(db);
  assert.equal(repo.kv.get('schema_version'), '2');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .all();
  assert.equal(tables.length, 1);
});

test('tasks: seq assignment, valid and invalid state transitions', () => {
  const { repo } = setup();
  const { task } = makeTask(repo);
  assert.equal(task.seq, 1);
  assert.equal(task.state, 'queued');

  const running = repo.tasks.updateState(task.id, 'running');
  assert.equal(running.state, 'running');
  assert.ok(running.startedAt !== null);

  const completed = repo.tasks.updateState(task.id, 'completed');
  assert.equal(completed.state, 'completed');
  assert.ok(completed.endedAt !== null);

  assert.throws(
    () => repo.tasks.updateState(task.id, 'running'),
    (err: unknown) => err instanceof RepoError && err.code === ERR.INVALID_STATE,
  );

  const { task: task2 } = makeTask(repo);
  assert.equal(task2.seq, 1);
  assert.throws(
    () => repo.tasks.updateState(task2.id, 'completed'),
    (err: unknown) => err instanceof RepoError && err.code === ERR.INVALID_STATE,
  );
});

test('tasks: state transition writes task.state event; nextQueued picks earliest seq', () => {
  const { repo } = setup();
  const { project, session, task } = makeTask(repo);
  repo.tasks.updateState(task.id, 'running');
  const events = repo.events.listAfter(0, project.id);
  const stateEvents = events.filter((e) => e.type === 'task.state');
  assert.equal(stateEvents.length, 1);
  assert.deepEqual(stateEvents[0]!.payload, { taskId: task.id, from: 'queued', to: 'running' });

  const t2 = repo.tasks.create({
    projectId: project.id,
    sessionId: session.id,
    input: 'second',
    clientRequestId: 'cr-second',
  });
  assert.equal(t2.seq, 2);
  const next = repo.tasks.nextQueued(project.id);
  assert.ok(next);
  assert.equal(next.id, t2.id);
});

test('tasks: duplicate (projectId, clientRequestId) violates unique constraint; findByClientRequestId dedupes', () => {
  const { repo } = setup();
  const { project, session, task } = makeTask(repo, 'cr-dup');
  assert.throws(() =>
    repo.tasks.create({
      projectId: project.id,
      sessionId: session.id,
      input: 'retry of same request',
      clientRequestId: 'cr-dup',
    }),
  );
  const found = repo.tasks.findByClientRequestId(project.id, 'cr-dup');
  assert.ok(found);
  assert.equal(found.id, task.id);
  assert.equal(repo.tasks.findByClientRequestId(project.id, 'cr-nope'), null);
});

test('approvals: decide is idempotent and syncs tool_call state', () => {
  const { repo } = setup();
  const { task } = makeTask(repo);
  const toolCall = repo.toolCalls.create({
    taskId: task.id,
    seq: 1,
    tool: 'write_file',
    args: { path: '/tmp/a.txt' },
    state: 'awaiting_approval',
  });
  const approval = repo.approvals.create({
    taskId: task.id,
    toolCallId: toolCall.id,
    operation: 'write /tmp/a.txt',
    params: { path: '/tmp/a.txt' },
    reason: 'write outside sandbox',
    riskSummary: 'medium',
  });
  assert.equal(approval.state, 'pending');
  assert.equal(repo.approvals.pendingByTask(task.id).length, 1);

  const first = repo.approvals.decide(approval.id, 'approve');
  assert.equal(first.state, 'approved');
  assert.ok(first.decidedAt !== null);

  const second = repo.approvals.decide(approval.id, 'approve');
  assert.equal(second.state, 'approved');
  assert.equal(second.decidedAt, first.decidedAt);

  const third = repo.approvals.decide(approval.id, 'reject');
  assert.equal(third.state, 'approved');
  assert.equal(third.decidedAt, first.decidedAt);

  const updatedCall = repo.toolCalls.getById(toolCall.id);
  assert.equal(updatedCall!.state, 'approved');
  assert.equal(repo.approvals.pendingByTask(task.id).length, 0);

  const decided = repo.events.listAfter(0).filter((e) => e.type === 'approval.decided');
  assert.equal(decided.length, 1);
});

test('events: cursor-based listAfter with limit and project filter', () => {
  const { repo } = setup();
  const { project } = makeTask(repo);
  const other = repo.projects.create({ name: 'other', path: '/p/other', isGit: false });

  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(repo.events.append(project.id, null, 'log', { i }).id);
  }
  repo.events.append(other.id, null, 'log', { i: 99 });
  repo.events.append(null, null, 'log', { i: 100 });

  const page1 = repo.events.listAfter(0, project.id, 2);
  assert.equal(page1.length, 2);
  assert.deepEqual(
    page1.map((e) => e.id),
    [ids[0], ids[1]],
  );

  const page2 = repo.events.listAfter(page1[1]!.id, project.id, 2);
  assert.deepEqual(
    page2.map((e) => e.id),
    [ids[2], ids[3]],
  );

  const page3 = repo.events.listAfter(page2[1]!.id, project.id);
  assert.deepEqual(
    page3.map((e) => e.id),
    [ids[4]],
  );

  const all = repo.events.listAfter(0);
  assert.equal(all.length, 7);
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i]!.id > all[i - 1]!.id);
  }
});

test('snapshots: create, add files, getByTask, markUndone', () => {
  const { repo } = setup();
  const { project, task } = makeTask(repo);
  const snapshot = repo.snapshots.createSnapshot({ taskId: task.id, projectId: project.id });

  repo.snapshots.addFile({
    snapshotId: snapshot.id,
    path: '/abs/b.ts',
    changeKind: 'modified',
    existedBefore: true,
    beforeHash: 'aaa',
    afterHash: 'bbb',
    backupPath: 'b.ts.bak',
  });
  repo.snapshots.addFile({
    snapshotId: snapshot.id,
    path: '/abs/a.ts',
    changeKind: 'created',
    existedBefore: false,
  });

  const byTask = repo.snapshots.getByTask(task.id);
  assert.ok(byTask);
  assert.equal(byTask.id, snapshot.id);
  assert.equal(byTask.undoneAt, null);

  const files = repo.snapshots.listFiles(snapshot.id);
  assert.equal(files.length, 2);
  assert.equal(files[0]!.path, '/abs/a.ts');
  assert.equal(files[0]!.existedBefore, false);
  assert.equal(files[0]!.beforeHash, null);
  assert.equal(files[1]!.existedBefore, true);
  assert.equal(files[1]!.backupPath, 'b.ts.bak');

  const undone = repo.snapshots.markUndone(snapshot.id);
  assert.ok(undone.undoneAt !== null);
});

test('modelConfigs: setDefault keeps exactly one default', () => {
  const { repo } = setup();
  const a = repo.modelConfigs.create({
    name: 'Kimi',
    baseUrl: 'https://api.example.com/v1',
    model: 'kimi-k2',
    apiKeyRef: 'ref-a',
    isDefault: true,
  });
  const b = repo.modelConfigs.create({
    name: 'Other',
    baseUrl: 'https://api2.example.com/v1',
    model: 'other-model',
    apiKeyRef: 'ref-b',
  });

  assert.equal(repo.modelConfigs.getDefault()!.id, a.id);

  repo.modelConfigs.setDefault(b.id);
  assert.equal(repo.modelConfigs.getDefault()!.id, b.id);
  assert.equal(repo.modelConfigs.getById(a.id)!.isDefault, false);

  repo.modelConfigs.setDefault(a.id);
  assert.equal(repo.modelConfigs.getDefault()!.id, a.id);
  assert.equal(repo.modelConfigs.getById(b.id)!.isDefault, false);

  const defaults = repo.modelConfigs.list().filter((c) => c.isDefault);
  assert.equal(defaults.length, 1);

  assert.equal(repo.modelConfigs.delete(b.id), true);
  assert.equal(repo.modelConfigs.getById(b.id), null);
});

test('idempotency + kv basics; project delete cascades', () => {
  const { repo } = setup();
  repo.idempotency.set('scope:key1', '{"ok":true}');
  repo.idempotency.set('scope:key1', '{"ok":false}');
  assert.equal(repo.idempotency.get('scope:key1'), '{"ok":true}');
  assert.equal(repo.idempotency.get('scope:missing'), null);

  repo.kv.set('k', 'v1');
  repo.kv.set('k', 'v2');
  assert.equal(repo.kv.get('k'), 'v2');

  const { project, task } = makeTask(repo);
  const toolCall = repo.toolCalls.create({ taskId: task.id, seq: 1, tool: 'search', args: {} });
  repo.approvals.create({
    taskId: task.id,
    toolCallId: toolCall.id,
    operation: 'op',
    params: {},
    reason: 'r',
    riskSummary: 'low',
  });
  const snapshot = repo.snapshots.createSnapshot({ taskId: task.id, projectId: project.id });
  repo.snapshots.addFile({
    snapshotId: snapshot.id,
    path: '/abs/x',
    changeKind: 'deleted',
    existedBefore: true,
  });

  assert.equal(repo.projects.delete(project.id), true);
  assert.equal(repo.projects.getById(project.id), null);
  assert.equal(repo.tasks.getById(task.id), null);
  assert.equal(repo.toolCalls.getById(toolCall.id), null);
  assert.equal(repo.snapshots.getByTask(task.id), null);
  assert.equal(repo.events.listAfter(0, project.id).length, 0);
});
