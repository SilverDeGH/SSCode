import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from './db/connection.ts';
import { Repo } from './db/repo.ts';
import { SecretsStore } from './ai/secrets.ts';
import { createAdapter } from './ai/openaiCompat.ts';
import type { ModelAdapter } from './types.ts';
import { SnapshotStore } from './snapshot/snapshot.ts';
import { snapshotRepoAdapter } from './snapshot/repoAdapter.ts';
import { TaskEngine } from './engine/engine.ts';
import { issueAuthToken } from './api/auth.ts';
import { createApiServer } from './api/server.ts';
import { fileRoutes } from './features/files.ts';
import { gitRoutes } from './features/git.ts';
import { TerminalManager } from './terminal/terminalManager.ts';
import { terminalRoutes, makeTerminalUpgradeHandler } from './terminal/terminalRoutes.ts';
import { IdeManager } from './ide/ideManager.ts';
import { makeIdeRoutes } from './ide/ideRoutes.ts';

export const SERVER_VERSION = '0.2.4';

export interface App {
  db: DatabaseSync;
  repo: Repo;
  engine: TaskEngine;
  server: Server;
  authToken: string;
  dataDir: string;
}

export interface AppOptions {
  dataDir: string;
  /** 测试注入用；缺省按模型配置创建 OpenAI 兼容适配器 */
  resolveAdapter?: (modelConfigId: string | null) => ModelAdapter;
}

/** 组合根：装配 db / 快照 / 引擎 / API，恢复上次中断状态 */
export function createApp(opts: AppOptions): App {
  const db = openDatabase(path.join(opts.dataDir, 'sscode.db'));
  migrate(db);
  const repo = new Repo(db);
  const secrets = new SecretsStore(opts.dataDir);
  const snapshots = new SnapshotStore(snapshotRepoAdapter(repo), opts.dataDir);

  const resolveAdapter = opts.resolveAdapter ?? ((modelConfigId: string | null): ModelAdapter => {
    const config = modelConfigId !== null
      ? repo.modelConfigs.getById(modelConfigId)
      : repo.modelConfigs.getDefault();
    if (!config) throw new Error('未配置模型，请先在设置中添加模型配置');
    return createAdapter(config, secrets);
  });

  const engine = new TaskEngine({ repo, snapshots, secrets, dataDir: opts.dataDir, resolveAdapter });
  engine.recoverOnBoot();

  const authToken = issueAuthToken(repo);
  // token 落盘供 App 经 SSH 读文件获取（Windows 无 journalctl；Linux 同样可用此路径）
  try {
    fs.writeFileSync(path.join(opts.dataDir, 'auth-token'), authToken, { mode: 0o600 });
  } catch {
    // 目录不可写时保留 stdout 输出一条获取途径
  }
  const terminalManager = new TerminalManager();
  const ideManager = new IdeManager({ secrets });
  const server = createApiServer({
    repo,
    engine,
    authToken,
    version: SERVER_VERSION,
    terminalBackend: terminalManager.preferredBackend(),
    setModelKey: (ref, key) => secrets.set(ref, key),
    getModelKey: ref => secrets.get(ref),
    deleteModelKey: ref => {
      secrets.delete(ref);
    },
    extraRoutes: [
      ...fileRoutes,
      ...gitRoutes,
      ...terminalRoutes(terminalManager),
      ...makeIdeRoutes(ideManager),
    ],
    upgradeHandler: makeTerminalUpgradeHandler(repo, terminalManager),
    testModel: async configId => {
      const config = repo.modelConfigs.getById(configId);
      if (!config) return { ok: false, detail: '模型配置不存在' };
      try {
        return await createAdapter(config, secrets).test();
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  return { db, repo, engine, server, authToken, dataDir: opts.dataDir };
}
