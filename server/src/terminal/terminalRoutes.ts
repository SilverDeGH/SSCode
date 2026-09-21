/**
 * 终端 API 扩展点（P5-07）：ExtraRoute 状态查询 + WebSocket 升级处理器。
 * 不修改 src/api/server.ts；由 app 装配到 ApiDeps.extraRoutes / upgradeHandler。
 */
import type { ExtraRoute, UpgradeHandler } from '../api/server.ts';
import { notFound, validationError } from '../api/server.ts';
import type { Repo } from '../db/repo.ts';
import type { TerminalManager } from './terminalManager.ts';
import { acceptWebSocket, WS_OPCODE } from './ws.ts';

/** GET /v1/terminal/status?projectId= → { exists, backend? } */
export function terminalRoutes(manager: TerminalManager): ExtraRoute[] {
  return [
    {
      method: 'GET',
      match: (parts) =>
        parts.length === 2 && parts[0] === 'terminal' && parts[1] === 'status' ? {} : null,
      handle: async (ctx) => {
        const projectId = ctx.url.searchParams.get('projectId');
        if (projectId === null || projectId === '') {
          throw validationError('missing required query: projectId');
        }
        if (ctx.deps.repo.projects.getById(projectId) === null) {
          throw notFound(`project not found: ${projectId}`);
        }
        return { status: 200, body: manager.status(projectId) };
      },
    },
  ];
}

/**
 * /v1/terminal/ws 升级处理。鉴权已由框架完成（Bearer 或 ?token=），
 * 这里只负责参数校验、握手与消息桥接。非本路径 return false 交还框架。
 *
 * 协议：客户端发 JSON 文本帧 {type:'input',data} / {type:'resize',cols,rows}；
 * 服务端发 {type:'ready',backend} / {type:'output',data} / {type:'exit'}。
 */
export function makeTerminalUpgradeHandler(repo: Repo, manager: TerminalManager): UpgradeHandler {
  return (req, socket, head, url) => {
    if (url.pathname !== '/v1/terminal/ws') return false;

    const reject = (statusLine: string): boolean => {
      try {
        socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
      } catch {
        // socket 已不可用
      }
      socket.destroy();
      return true;
    };

    const projectId = url.searchParams.get('projectId');
    if (projectId === null || projectId === '') return reject('400 Bad Request');
    const project = repo.projects.getById(projectId);
    if (project === null) return reject('404 Not Found');

    let conn: ReturnType<typeof acceptWebSocket>;
    try {
      conn = acceptWebSocket(req, socket, head);
    } catch {
      socket.destroy();
      return true;
    }

    const send = (obj: Record<string, unknown>): void => {
      conn.sendText(JSON.stringify(obj));
    };

    let handle: ReturnType<TerminalManager['attach']>;
    try {
      handle = manager.attach(projectId, project.path);
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      conn.close(1011);
      return true;
    }

    // 跨 chunk 拆分的多字节 UTF-8（中文）需流式解码，不能逐 chunk 独立 toString
    const decoder = new TextDecoder('utf-8');
    handle.onData((data) => {
      const text = decoder.decode(data, { stream: true });
      if (text.length > 0) send({ type: 'output', data: text });
    });
    handle.onExit(() => {
      const rest = decoder.decode();
      if (rest.length > 0) send({ type: 'output', data: rest });
      send({ type: 'exit' });
      conn.close(1000);
    });
    conn.onMessage((opcode, payload) => {
      if (opcode !== WS_OPCODE.TEXT) return;
      let msg: unknown;
      try {
        msg = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      if (msg === null || typeof msg !== 'object') return;
      const m = msg as Record<string, unknown>;
      if (m.type === 'input' && typeof m.data === 'string') {
        handle.write(m.data);
      } else if (
        m.type === 'resize' &&
        typeof m.cols === 'number' &&
        typeof m.rows === 'number'
      ) {
        handle.resize(m.cols, m.rows);
      }
    });
    // 断线只断开 attach（handle.kill），tmux 会话保留，重连后接回
    conn.onClose(() => handle.kill());

    send({ type: 'ready', backend: handle.backend });
    return true;
  };
}
