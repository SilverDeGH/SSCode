import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { removePath } from '../util/remove.ts';
import type { FileChangeKind, SnapshotFile, UndoFileResult, UndoReport } from '../types.ts';

/** 快照持久化依赖（由 db 层实现，本模块不写 SQL） */
export interface SnapshotRepoLike {
  createSnapshot(taskId: string, projectId: string): { id: string };
  getByTask(taskId: string): { id: string; undoneAt: number | null } | null;
  addFile(rec: {
    id: string;
    snapshotId: string;
    path: string;
    changeKind: FileChangeKind;
    existedBefore: boolean;
    beforeHash: string | null;
    afterHash: string | null;
    backupPath: string | null;
  }): void;
  listFiles(snapshotId: string): SnapshotFile[];
  updateFileAfterHash(id: string, afterHash: string | null, changeKind: FileChangeKind): void;
  markUndone(snapshotId: string): void;
}

const UNDO_CAVEAT = '命令副作用（数据库变更、外部写入、已推送的提交）不在撤销范围内';

function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export class SnapshotStore {
  private readonly repo: SnapshotRepoLike;
  private readonly dataDir: string;

  constructor(repo: SnapshotRepoLike, dataDir: string) {
    this.repo = repo;
    this.dataDir = dataDir;
  }

  /** 取或建任务快照记录 */
  ensureSnapshot(taskId: string, projectId: string): { id: string } {
    const existing = this.repo.getByTask(taskId);
    if (existing) return { id: existing.id };
    return this.repo.createSnapshot(taskId, projectId);
  }

  /** 任务首次触碰该文件时记录原始状态（同 snapshot 内同路径只记一次） */
  recordBeforeWrite(taskId: string, projectId: string, absPath: string): void {
    const snap = this.ensureSnapshot(taskId, projectId);
    if (this.repo.listFiles(snap.id).some(f => f.path === absPath)) return;

    if (fs.existsSync(absPath)) {
      const beforeHash = sha256File(absPath);
      const backupName = beforeHash.slice(0, 16);
      const backupAbs = path.join(this.dataDir, 'snapshots', snap.id, backupName);
      fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
      fs.copyFileSync(absPath, backupAbs);
      this.repo.addFile({
        id: crypto.randomUUID(),
        snapshotId: snap.id,
        path: absPath,
        changeKind: 'modified',
        existedBefore: true,
        beforeHash,
        afterHash: null,
        backupPath: backupName,
      });
    } else {
      this.repo.addFile({
        id: crypto.randomUUID(),
        snapshotId: snap.id,
        path: absPath,
        changeKind: 'created',
        existedBefore: false,
        beforeHash: null,
        afterHash: null,
        backupPath: null,
      });
    }
  }

  /** 任务写完/删除后更新 afterHash 与最终 changeKind */
  recordAfterWrite(taskId: string, absPath: string, opts: { deleted?: boolean } = {}): void {
    const snap = this.repo.getByTask(taskId);
    if (!snap) return;
    const rec = this.repo.listFiles(snap.id).find(f => f.path === absPath);
    if (!rec) return;
    const deleted = opts.deleted === true;
    const afterHash = deleted ? null : (fs.existsSync(absPath) ? sha256File(absPath) : null);
    const changeKind: FileChangeKind = deleted ? 'deleted' : (rec.existedBefore ? 'modified' : 'created');
    this.repo.updateFileAfterHash(rec.id, afterHash, changeKind);
  }

  undo(taskId: string): UndoReport {
    const snap = this.repo.getByTask(taskId);
    if (!snap) {
      return { taskId, snapshotId: null, results: [], hasConflict: false, caveats: [] };
    }
    const files = this.repo.listFiles(snap.id);

    if (snap.undoneAt !== null) {
      return {
        taskId,
        snapshotId: snap.id,
        results: files.map(f => ({
          path: f.path,
          changeKind: f.changeKind,
          status: 'skipped',
          detail: '快照已撤销过，不重复执行',
        })),
        hasConflict: false,
        caveats: [UNDO_CAVEAT],
      };
    }

    const results = files.map(f => this.undoFile(f));
    this.repo.markUndone(snap.id);
    return {
      taskId,
      snapshotId: snap.id,
      results,
      hasConflict: results.some(r => r.status === 'conflict'),
      caveats: [UNDO_CAVEAT],
    };
  }

  private undoFile(f: SnapshotFile): UndoFileResult {
    const exists = fs.existsSync(f.path);
    const currentHash = exists ? sha256File(f.path) : null;

    // 任务新建的文件已被（人工/后续）删除：无需处理
    if (f.changeKind === 'created' && !exists) {
      return { path: f.path, changeKind: f.changeKind, status: 'skipped', detail: '文件已不存在' };
    }
    // 冲突保护：当前内容与任务结束时记录不一致，不覆盖
    if (currentHash !== f.afterHash) {
      return {
        path: f.path,
        changeKind: f.changeKind,
        status: 'conflict',
        detail: '文件在任务结束后被修改，跳过覆盖',
      };
    }

    switch (f.changeKind) {
      case 'created':
        removePath(f.path);
        return { path: f.path, changeKind: f.changeKind, status: 'deleted', detail: '已删除任务新建的文件' };
      case 'modified':
        this.restoreBackup(f);
        return { path: f.path, changeKind: f.changeKind, status: 'restored', detail: '已恢复任务前内容' };
      case 'deleted':
        this.restoreBackup(f);
        return { path: f.path, changeKind: f.changeKind, status: 'restored', detail: '已重建任务删除的文件' };
    }
  }

  private restoreBackup(f: SnapshotFile): void {
    if (!f.backupPath) throw new Error(`缺少备份文件，无法恢复: ${f.path}`);
    const backupAbs = path.join(this.dataDir, 'snapshots', f.snapshotId, f.backupPath);
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.copyFileSync(backupAbs, f.path);
  }
}
