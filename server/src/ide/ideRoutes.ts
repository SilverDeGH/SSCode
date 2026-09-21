import type { ExtraRoute, ExtraRouteCtx } from '../api/server.ts';
import { asObject, httpError, optString } from '../api/server.ts';
import { ERR } from '../types.ts';
import { IDE_PORT } from './ideManager.ts';
import type { IdeManager } from './ideManager.ts';

function matchExact(parts: string[], ...expected: string[]): Record<string, string> | null {
  if (parts.length !== expected.length) return null;
  for (let i = 0; i < expected.length; i++) {
    if (parts[i] !== expected[i]) return null;
  }
  return {};
}

async function bodyObject(ctx: ExtraRouteCtx): Promise<Record<string, unknown>> {
  const raw = await ctx.readBody();
  return raw === null ? {} : asObject(raw);
}

/** code-server 管理路由（挂到 ApiDeps.extraRoutes，路径段不含 /v1 前缀） */
export function makeIdeRoutes(manager: IdeManager): ExtraRoute[] {
  return [
    {
      method: 'GET',
      match: parts => matchExact(parts, 'ide', 'status'),
      handle: async () => {
        const status = await manager.detect();
        // 只报告是否有密码，永不返回密码本身
        return { status: 200, body: { ...status, hasPassword: manager.accessInfo() !== null } };
      },
    },
    {
      method: 'POST',
      match: parts => matchExact(parts, 'ide', 'install'),
      handle: async ctx => {
        const body = await bodyObject(ctx);
        const proxy = optString(body, 'proxy');
        const result = await manager.install(proxy !== undefined ? { proxy } : {});
        return { status: 200, body: result };
      },
    },
    {
      method: 'POST',
      match: parts => matchExact(parts, 'ide', 'start'),
      handle: async () => ({ status: 200, body: await manager.start() }),
    },
    {
      method: 'POST',
      match: parts => matchExact(parts, 'ide', 'stop'),
      handle: async () => {
        await manager.stop();
        return { status: 200, body: { stopped: true } };
      },
    },
    {
      method: 'GET',
      match: parts => matchExact(parts, 'ide', 'access'),
      handle: async () => {
        const info = manager.accessInfo();
        if (info === null) {
          if (manager.isWindowsHost) {
            // WSL 内 code-server 的认证信息由用户在 WSL 内查看，服务端无从得知
            return {
              status: 200,
              body: { port: IDE_PORT, password: null, url: `http://127.0.0.1:${IDE_PORT}`, wsl: true },
            };
          }
          throw httpError(404, ERR.NOT_FOUND, 'code-server 访问密码尚未生成，请先启动 IDE');
        }
        return {
          status: 200,
          body: { port: info.port, password: info.password, url: `http://127.0.0.1:${info.port}` },
        };
      },
    },
  ];
}
