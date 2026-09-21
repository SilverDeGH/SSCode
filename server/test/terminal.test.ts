import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import { createApiServer } from '../src/api/server.ts';
import type { ApiDeps } from '../src/api/server.ts';
import type { EngineFacade } from '../src/types.ts';
import { acceptWebSocket, WS_OPCODE } from '../src/terminal/ws.ts';
import type { WsConn } from '../src/terminal/ws.ts';
import { TerminalManager } from '../src/terminal/terminalManager.ts';
import { terminalRoutes, makeTerminalUpgradeHandler } from '../src/terminal/terminalRoutes.ts';

const TOKEN = 'terminal-test-token';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const posixOnly = process.platform === 'win32' ? 'requires tmux/script on POSIX' : false;

// ---------------------------------------------------------------- 工具

interface ParsedFrame {
  opcode: number;
  payload: Buffer;
}

/** 构造客户端帧（按 RFC6455 客户端必须 mask） */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}

/** 测试客户端侧的服务端帧解析器（服务端帧不 mask） */
class ServerFrameReader {
  #buf: Buffer = Buffer.alloc(0);
  #frames: ParsedFrame[] = [];
  #waiters: ((f: ParsedFrame) => void)[] = [];

  push(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    for (;;) {
      if (this.#buf.length < 2) return;
      const b0 = this.#buf[0]!;
      const b1 = this.#buf[1]!;
      assert.equal(b1 & 0x80, 0, 'server frames must not be masked');
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.#buf.length < 4) return;
        len = this.#buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.#buf.length < 10) return;
        len = Number(this.#buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.#buf.length < offset + len) return;
      const payload = Buffer.from(this.#buf.subarray(offset, offset + len));
      this.#buf = this.#buf.subarray(offset + len);
      const frame: ParsedFrame = { opcode: b0 & 0x0f, payload };
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter(frame);
      else this.#frames.push(frame);
    }
  }

  next(): Promise<ParsedFrame> {
    const f = this.#frames.shift();
    if (f !== undefined) return Promise.resolve(f);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

interface WsTestClient {
  socket: net.Socket;
  reader: ServerFrameReader;
}

async function wsClientConnect(
  t: import('node:test').TestContext,
  port: number,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<WsTestClient> {
  const socket = net.connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const key = crypto.randomBytes(16).toString('base64');
  const expectedAccept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  const headers = Object.entries(extraHeaders)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  socket.write(
    `GET ${path} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      headers +
      '\r\n',
  );
  const reader = new ServerFrameReader();
  let handshake = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      handshake = Buffer.concat([handshake, chunk]);
      const idx = handshake.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.off('data', onData);
      const headText = handshake.subarray(0, idx).toString('latin1');
      assert.match(headText, /^HTTP\/1\.1 101 /, 'handshake status line');
      assert.ok(
        headText.includes(`Sec-WebSocket-Accept: ${expectedAccept}`),
        'Sec-WebSocket-Accept matches sha1(key+GUID)',
      );
      const rest = handshake.subarray(idx + 4);
      socket.on('data', (c: Buffer) => reader.push(c));
      if (rest.length > 0) reader.push(rest);
      resolve();
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  return { socket, reader };
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

function unusedEngine(): EngineFacade {
  const fail = async (): Promise<never> => {
    throw new Error('engine not used in terminal tests');
  };
  return {
    submitTask: fail,
    setApprovalMode: fail,
    appendMessage: fail,
    answerTask: fail,
    stopTask: fail,
    cancelQueued: fail,
    decideApproval: fail,
    undoTask: fail,
    resumeInterrupted: fail,
  };
}

// ---------------------------------------------------------------- WS 编解码

async function startEchoServer(
  t: import('node:test').TestContext,
): Promise<{ port: number; conns: WsConn[] }> {
  const conns: WsConn[] = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const conn = acceptWebSocket(req, socket as net.Socket, head);
    conns.push(conn);
    conn.onMessage((opcode, payload) => {
      if (opcode === WS_OPCODE.TEXT) conn.sendText(`echo:${payload.toString('utf8')}`);
      else if (opcode === WS_OPCODE.BINARY) conn.sendBinary(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { port: (server.address() as AddressInfo).port, conns };
}

test('ws: handshake + masked text roundtrip', async (t) => {
  const { port } = await startEchoServer(t);
  const { socket, reader } = await wsClientConnect(t, port, '/ws');
  socket.write(clientFrame(WS_OPCODE.TEXT, Buffer.from('hello')));
  const f = await reader.next();
  assert.equal(f.opcode, WS_OPCODE.TEXT);
  assert.equal(f.payload.toString('utf8'), 'echo:hello');
});

test('ws: masked binary payload unmasked correctly', async (t) => {
  const { port } = await startEchoServer(t);
  const { socket, reader } = await wsClientConnect(t, port, '/ws');
  const bin = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x55]);
  socket.write(clientFrame(WS_OPCODE.BINARY, bin));
  const f = await reader.next();
  assert.equal(f.opcode, WS_OPCODE.BINARY);
  assert.deepEqual(f.payload, bin);
});

test('ws: fragmented message reassembled', async (t) => {
  const { port } = await startEchoServer(t);
  const { socket, reader } = await wsClientConnect(t, port, '/ws');
  socket.write(clientFrame(WS_OPCODE.TEXT, Buffer.from('he'), false));
  socket.write(clientFrame(WS_OPCODE.CONTINUATION, Buffer.from('ll'), false));
  socket.write(clientFrame(WS_OPCODE.CONTINUATION, Buffer.from('o'), true));
  const f = await reader.next();
  assert.equal(f.opcode, WS_OPCODE.TEXT);
  assert.equal(f.payload.toString('utf8'), 'echo:hello');
});

test('ws: ping gets automatic pong; server can ping', async (t) => {
  const { port, conns } = await startEchoServer(t);
  const { socket, reader } = await wsClientConnect(t, port, '/ws');
  socket.write(clientFrame(WS_OPCODE.PING, Buffer.from('xy')));
  const pong = await reader.next();
  assert.equal(pong.opcode, WS_OPCODE.PONG);
  assert.equal(pong.payload.toString('utf8'), 'xy');
  await waitFor(() => conns.length === 1, 3000, 'server conn registered');
  conns[0]!.ping();
  const ping = await reader.next();
  assert.equal(ping.opcode, WS_OPCODE.PING);
});

test('ws: extended length frame survives TCP split writes', async (t) => {
  const { port } = await startEchoServer(t);
  const { socket, reader } = await wsClientConnect(t, port, '/ws');
  const text = 'a'.repeat(200);
  const frame = clientFrame(WS_OPCODE.TEXT, Buffer.from(text));
  // 模拟 TCP 拆包：分三段写入
  socket.write(frame.subarray(0, 3));
  await new Promise((r) => setTimeout(r, 30));
  socket.write(frame.subarray(3, frame.length - 50));
  await new Promise((r) => setTimeout(r, 30));
  socket.write(frame.subarray(frame.length - 50));
  const f = await reader.next();
  assert.equal(f.payload.toString('utf8'), `echo:${text}`);
});

test('ws: close frame echoed back', async (t) => {
  const { port } = await startEchoServer(t);
  const { socket, reader } = await wsClientConnect(t, port, '/ws');
  const code = Buffer.alloc(2);
  code.writeUInt16BE(1000, 0);
  socket.write(clientFrame(WS_OPCODE.CLOSE, code));
  const f = await reader.next();
  assert.equal(f.opcode, WS_OPCODE.CLOSE);
  assert.equal(f.payload.readUInt16BE(0), 1000);
});

// ---------------------------------------------------------------- TerminalManager 集成

test(
  'terminal manager: attach → write → output → reattach keeps tmux session',
  { skip: posixOnly },
  async (t) => {
    const manager = new TerminalManager();
    t.after(() => manager.killAll());
    const projectId = crypto.randomUUID();
    const projectPath = os.tmpdir();

    const marker = `TERM_OK_${crypto.randomBytes(4).toString('hex')}`;
    const h1 = manager.attach(projectId, projectPath);
    let out1 = '';
    h1.onData((d) => {
      out1 += d.toString('utf8');
    });
    h1.write(`echo ${marker}\n`);
    await waitFor(() => out1.includes(marker), 10000, 'echo output received');

    const st = manager.status(projectId);
    assert.equal(st.exists, true);
    assert.equal(st.backend, h1.backend);

    if (h1.backend === 'tmux') {
      // send-keys 输入 + pipe-pane 输出架构：在会话内设置环境变量，
      // 断开本客户端（kill）后重连验证 tmux 会话仍在
      const secret = `TM${crypto.randomBytes(6).toString('hex')}`;
      h1.write(`export TMARK=${secret}\n`);
      await waitFor(() => out1.includes('TMARK='), 5000, 'export echoed');
      await new Promise((r) => setTimeout(r, 300)); // 等 shell 真正执行
      h1.kill(); // 断开本客户端：停止输出流、删临时文件，不杀 tmux 会话
      await new Promise<void>((r) => h1.onExit(r));
      assert.equal(manager.status(projectId).exists, true, 'tmux session survives detach');

      const h2 = manager.attach(projectId, projectPath);
      let out2 = '';
      h2.onData((d) => {
        out2 += d.toString('utf8');
      });
      h2.write('echo GOT_$TMARK\n');
      // 屏幕回显输入是字面量 'GOT_$TMARK'，只有真实展开才含 secret
      await waitFor(() => out2.includes(`GOT_${secret}`), 10000, 'env var persisted in session');
      h2.kill();
    } else {
      h1.kill();
      t.diagnostic(`backend=${h1.backend}: tmux persistence assertion skipped`);
    }
  },
);

// ---------------------------------------------------------------- 路由与升级处理器

interface ApiCtx {
  db: DatabaseSync;
  repo: Repo;
  manager: TerminalManager;
  base: string;
  port: number;
  projectId: string;
}

async function setupApi(t: import('node:test').TestContext): Promise<ApiCtx> {
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new Repo(db);
  const manager = new TerminalManager();
  const deps: ApiDeps = {
    repo,
    engine: unusedEngine(),
    authToken: TOKEN,
    testModel: async () => ({ ok: true, detail: 'stub' }),
    setModelKey: () => {},
    deleteModelKey: () => {},
    version: 'test',
    extraRoutes: terminalRoutes(manager),
    upgradeHandler: makeTerminalUpgradeHandler(repo, manager),
  };
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  t.after(() => {
    server.close();
    db.close();
    manager.killAll();
  });
  const project = repo.projects.create({ name: 'term-proj', path: os.tmpdir(), isGit: false });
  return { db, repo, manager, base: `http://127.0.0.1:${port}`, port, projectId: project.id };
}

test('terminal/status route: exists/backend/校验', async (t) => {
  const ctx = await setupApi(t);
  const auth = { authorization: `Bearer ${TOKEN}` };

  const res = await fetch(`${ctx.base}/v1/terminal/status?projectId=${ctx.projectId}`, {
    headers: auth,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { exists: boolean };
  assert.equal(body.exists, false);

  const missing = await fetch(`${ctx.base}/v1/terminal/status`, { headers: auth });
  assert.equal(missing.status, 400);

  const unknown = await fetch(`${ctx.base}/v1/terminal/status?projectId=nope`, { headers: auth });
  assert.equal(unknown.status, 404);
});

/** 发起原始 upgrade 请求，收集到 socket 关闭为止的全部响应字节 */
function rawUpgradeResponse(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const hs = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('');
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          hs +
          '\r\n',
      );
    });
    let out = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(out.toString('latin1'));
    }, 3000);
    socket.on('data', (c: Buffer) => {
      out = Buffer.concat([out, c]);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(out.toString('latin1'));
    });
    socket.on('error', reject);
  });
}

test('upgrade handler returns false for non-terminal path (framework writes 401)', async (t) => {
  const ctx = await setupApi(t);
  const resp = await rawUpgradeResponse(ctx.port, '/v1/other-ws', {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.ok(resp.includes('401'), `expected 401 from framework, got: ${resp}`);
});

test('upgrade handler rejects bad params before handshake', async (t) => {
  const db = openDatabase(':memory:');
  migrate(db);
  t.after(() => db.close());
  const repo = new Repo(db);
  const manager = new TerminalManager();
  t.after(() => manager.killAll());
  const handler = makeTerminalUpgradeHandler(repo, manager);

  const makeFakeSocket = (): { sock: net.Socket; text: () => string } => {
    const chunks: Buffer[] = [];
    const sock = {
      write: (b: string | Buffer): boolean => {
        chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(b));
        return true;
      },
      destroy: (): void => {},
    } as unknown as net.Socket;
    return { sock, text: () => Buffer.concat(chunks).toString('latin1') };
  };

  // 非本路径 → false，不写任何字节
  const s0 = makeFakeSocket();
  const r0 = handler(
    {} as http.IncomingMessage,
    s0.sock,
    Buffer.alloc(0),
    new URL('http://127.0.0.1/v1/not-terminal'),
  );
  assert.equal(r0, false);
  assert.equal(s0.text(), '');

  // 缺 projectId → 400
  const s1 = makeFakeSocket();
  const r1 = handler(
    {} as http.IncomingMessage,
    s1.sock,
    Buffer.alloc(0),
    new URL('http://127.0.0.1/v1/terminal/ws'),
  );
  assert.equal(r1, true);
  assert.ok(s1.text().includes('400'), s1.text());

  // 项目不存在 → 404
  const s2 = makeFakeSocket();
  const r2 = handler(
    {} as http.IncomingMessage,
    s2.sock,
    Buffer.alloc(0),
    new URL('http://127.0.0.1/v1/terminal/ws?projectId=nope'),
  );
  assert.equal(r2, true);
  assert.ok(s2.text().includes('404'), s2.text());
});

test(
  'terminal ws end-to-end: ready → input → output',
  { skip: posixOnly },
  async (t) => {
    const ctx = await setupApi(t);
    const { socket, reader } = await wsClientConnect(
      t,
      ctx.port,
      `/v1/terminal/ws?projectId=${ctx.projectId}`,
      { authorization: `Bearer ${TOKEN}` },
    );

    const ready = await reader.next();
    assert.equal(ready.opcode, WS_OPCODE.TEXT);
    const readyMsg = JSON.parse(ready.payload.toString('utf8')) as {
      type: string;
      backend: string;
    };
    assert.equal(readyMsg.type, 'ready');
    assert.ok(['tmux', 'script', 'spawn'].includes(readyMsg.backend));

    const marker = `WS_OK_${crypto.randomBytes(4).toString('hex')}`;
    socket.write(
      clientFrame(
        WS_OPCODE.TEXT,
        Buffer.from(JSON.stringify({ type: 'input', data: `echo ${marker}\n` })),
      ),
    );
    // resize 尽力而为，不应造成断连
    socket.write(
      clientFrame(WS_OPCODE.TEXT, Buffer.from(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }))),
    );

    let output = '';
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !output.includes(marker)) {
      const f = await Promise.race([
        reader.next(),
        new Promise<null>((r) => setTimeout(() => r(null), 500)),
      ]);
      if (f === null) continue;
      assert.equal(f.opcode, WS_OPCODE.TEXT);
      const msg = JSON.parse(f.payload.toString('utf8')) as { type: string; data?: string };
      if (msg.type === 'output') output += msg.data ?? '';
    }
    assert.ok(output.includes(marker), `expected terminal output containing ${marker}`);
    socket.destroy();
  },
);

// ---------------------------------------------------------------- Windows persist 后端集成

const win32Only = process.platform === 'win32' ? false : 'requires Windows persist backend';

test(
  'terminal manager (win32): persist 后端 attach → write → output → detach → reattach 回放',
  { skip: win32Only },
  async (t) => {
    const manager = new TerminalManager();
    t.after(() => manager.killAll());
    assert.equal(manager.preferredBackend(), 'persist');
    const projectId = crypto.randomUUID();
    const projectPath = os.tmpdir();

    const marker = `TERM_OK_${crypto.randomBytes(4).toString('hex')}`;
    const h1 = manager.attach(projectId, projectPath);
    assert.equal(h1.backend, 'persist');
    let out1 = '';
    h1.onData((d) => {
      out1 += d.toString('utf8');
    });
    // Match executed output, never the shell's echo of the input command.
    h1.write(`Write-Output ('TERM_OK_' + '${marker.slice('TERM_OK_'.length)}')\r\n`);
    await waitFor(() => out1.includes(marker), 15000, 'echo output received');

    h1.kill(); // 断开本客户端：shell 进程与缓冲保留
    await new Promise<void>((r) => h1.onExit(r));
    assert.equal(manager.status(projectId).exists, true, 'persist session survives detach');

    const h2 = manager.attach(projectId, projectPath);
    let out2 = '';
    h2.onData((d) => {
      out2 += d.toString('utf8');
    });
    // 环形缓冲回放应包含断开前的输出
    await waitFor(() => out2.includes(marker), 5000, 'replayed output contains marker');
    h2.kill();
  },
);

test(
  'terminal manager (win32): persist 后端中文输出 UTF-8 无乱码',
  { skip: win32Only },
  async (t) => {
    const manager = new TerminalManager();
    t.after(() => manager.killAll());
    const projectId = crypto.randomUUID();
    const h = manager.attach(projectId, os.tmpdir());
    let out = '';
    h.onData((d) => {
      out += d.toString('utf8');
    });
    h.write('echo 你好世界\r\n');
    await waitFor(() => out.includes('你好世界'), 15000, 'chinese output received');
    h.kill();
  },
);
