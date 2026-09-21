import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SnapshotStore } from '../src/snapshot/snapshot.ts';
import type { SnapshotRepoLike } from '../src/snapshot/snapshot.ts';
import type { FileChangeKind, SnapshotFile } from '../src/types.ts';

class MemRepo implements SnapshotRepoLike {
  private snaps = new Map<string, { id: string; taskId: string; projectId: string; undoneAt: number | null }>();
  private files = new Map<string, SnapshotFile>();
  private n = 0;

  createSnapshot(taskId: string, projectId: string): { id: string } {
    const id = `snap-${++this.n}`;
    this.snaps.set(id, { id, taskId, projectId, undoneAt: null });
    return { id };
  }
  getByTask(taskId: string): { id: string; undoneAt: number | null } | null {
    for (const s of this.snaps.values()) {
      if (s.taskId === taskId) return { id: s.id, undoneAt: s.undoneAt };
    }
    return null;
  }
  addFile(rec: SnapshotFile): void {
    this.files.set(rec.id, { ...rec });
  }
  listFiles(snapshotId: string): SnapshotFile[] {
    return [...this.files.values()].filter(f => f.snapshotId === snapshotId);
  }
  updateFileAfterHash(id: string, afterHash: string | null, changeKind: FileChangeKind): void {
    const f = this.files.get(id);
    if (f) {
      f.afterHash = afterHash;
      f.changeKind = changeKind;
    }
  }
  markUndone(snapshotId: string): void {
    const s = this.snaps.get(snapshotId);
    if (s) s.undoneAt = Date.now();
  }
}

function setup(): { store: SnapshotStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-snap-'));
  return { store: new SnapshotStore(new MemRepo(), path.join(dir, 'data')), dir };
}

test('修改文件后 undo 恢复原文', () => {
  const { store, dir } = setup();
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'v1');

  store.recordBeforeWrite('t1', 'p1', file);
  fs.writeFileSync(file, 'v2');
  store.recordAfterWrite('t1', file);

  const report = store.undo('t1');
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1');
  assert.equal(report.hasConflict, false);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]!.status, 'restored');
  assert.equal(report.results[0]!.changeKind, 'modified');
  assert.ok(report.caveats.length > 0);
});

test('任务新建文件 undo 后删除', () => {
  const { store, dir } = setup();
  const file = path.join(dir, 'new.txt');

  store.recordBeforeWrite('t1', 'p1', file);
  fs.writeFileSync(file, 'created by task');
  store.recordAfterWrite('t1', file);

  const report = store.undo('t1');
  assert.equal(fs.existsSync(file), false);
  assert.equal(report.results[0]!.status, 'deleted');
  assert.equal(report.results[0]!.changeKind, 'created');
});

test('任务删除的文件 undo 后重建', () => {
  const { store, dir } = setup();
  const file = path.join(dir, 'gone.txt');
  fs.writeFileSync(file, 'original');

  store.recordBeforeWrite('t1', 'p1', file);
  fs.rmSync(file);
  store.recordAfterWrite('t1', file, { deleted: true });

  const report = store.undo('t1');
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.equal(report.results[0]!.status, 'restored');
  assert.equal(report.results[0]!.changeKind, 'deleted');
});

test('同一路径重复 recordBeforeWrite 只记一次（以首次为准）', () => {
  const { store, dir } = setup();
  const file = path.join(dir, 'b.txt');
  fs.writeFileSync(file, 'first');

  store.recordBeforeWrite('t1', 'p1', file);
  fs.writeFileSync(file, 'second');
  store.recordBeforeWrite('t1', 'p1', file); // 应跳过
  fs.writeFileSync(file, 'third');
  store.recordAfterWrite('t1', file);

  store.undo('t1');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first');
});

test('undo 前人工再改该文件 → conflict 不覆盖', () => {
  const { store, dir } = setup();
  const file = path.join(dir, 'c.txt');
  fs.writeFileSync(file, 'v1');

  store.recordBeforeWrite('t1', 'p1', file);
  fs.writeFileSync(file, 'v2');
  store.recordAfterWrite('t1', file);
  fs.writeFileSync(file, 'human edit'); // 任务结束后人工修改

  const report = store.undo('t1');
  assert.equal(report.hasConflict, true);
  assert.equal(report.results[0]!.status, 'conflict');
  assert.equal(fs.readFileSync(file, 'utf8'), 'human edit');
});

test('重复 undo → 全部 skipped', () => {
  const { store, dir } = setup();
  const file = path.join(dir, 'd.txt');
  fs.writeFileSync(file, 'v1');

  store.recordBeforeWrite('t1', 'p1', file);
  fs.writeFileSync(file, 'v2');
  store.recordAfterWrite('t1', file);

  store.undo('t1');
  const second = store.undo('t1');
  assert.ok(second.results.length > 0);
  assert.ok(second.results.every(r => r.status === 'skipped'));
  assert.equal(second.hasConflict, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1'); // 不被二次撤销破坏
});

test('无快照的任务 undo 返回空报告', () => {
  const { store } = setup();
  const report = store.undo('no-such-task');
  assert.equal(report.snapshotId, null);
  assert.deepEqual(report.results, []);
});
