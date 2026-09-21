import type { Repo } from '../db/repo.ts';
import type { SnapshotRepoLike } from './snapshot.ts';

/** 将 db 层 SnapshotsRepo 适配为 SnapshotStore 依赖的 SnapshotRepoLike 签名 */
export function snapshotRepoAdapter(repo: Repo): SnapshotRepoLike {
  const s = repo.snapshots;
  return {
    createSnapshot: (taskId, projectId) => ({ id: s.createSnapshot({ taskId, projectId }).id }),
    getByTask: taskId => {
      const snap = s.getByTask(taskId);
      return snap ? { id: snap.id, undoneAt: snap.undoneAt } : null;
    },
    addFile: rec => {
      s.addFile(rec);
    },
    listFiles: snapshotId => s.listFiles(snapshotId),
    updateFileAfterHash: (id, afterHash, changeKind) => s.updateFileAfterHash(id, afterHash, changeKind),
    markUndone: snapshotId => {
      s.markUndone(snapshotId);
    },
  };
}
