import type { ExtraRoute } from '../api/server.ts';
import { notFound } from '../api/server.ts';
import type { CodexWatchManager } from './codexWatchManager.ts';

/** 本机 Codex Desktop/CLI 任务只读监视路由（挂到 ApiDeps.extraRoutes，路径段不含 /v1 前缀） */
export function makeCodexWatchRoutes(manager: CodexWatchManager): ExtraRoute[] {
  return [
    {
      method: 'GET',
      match: parts => (parts.length === 2 && parts[0] === 'codex' && parts[1] === 'tasks' ? {} : null),
      handle: async () => {
        const { available, tasks } = await manager.listTasks();
        return { status: 200, body: { available, tasks } };
      },
    },
    {
      method: 'GET',
      match: parts =>
        parts.length === 3 && parts[0] === 'codex' && parts[1] === 'tasks' ? { id: parts[2] ?? '' } : null,
      handle: async ({ params }) => {
        const detail = await manager.getTask(params.id ?? '');
        if (detail === null) throw notFound('codex task not found');
        return {
          status: 200,
          body: { available: true, task: detail.task, messages: detail.messages, queuedTasks: detail.queuedTasks },
        };
      },
    },
  ];
}
