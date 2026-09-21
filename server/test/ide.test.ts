import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { ApiDeps, ExtraRoute, ExtraRouteCtx } from '../src/api/server.ts';
import { SecretsStore } from '../src/ai/secrets.ts';
import { IdeManager } from '../src/ide/ideManager.ts';
import type { ExecFn } from '../src/ide/ideManager.ts';
import { makeIdeRoutes } from '../src/ide/ideRoutes.ts';

const tmpDirs: string[] = [];

after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-ide-'));
  tmpDirs.push(d);
  return d;
}

type FakeResult = { code: number; stdout?: string; stderr?: string };

/** 记录调用序列的假 execFn */
function makeExec(handler: (cmd: string, args: string[]) => FakeResult) {
  const calls: string[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const r = handler(cmd, args);
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { exec, calls };
}

function makeManager(exec: ExecFn, homeDir: string, secrets?: SecretsStore) {
  return new IdeManager({ exec, secrets: secrets ?? new SecretsStore(mkTmp()), homeDir, hostPlatform: 'linux' });
}

// ---------------------------------------------------------------- detect

test('detect: 未安装未运行 → source none', async () => {
  const { exec } = makeExec(() => ({ code: 1 }));
  const m = makeManager(exec, mkTmp());
  const s = await m.detect();
  assert.deepEqual(s, { installed: false, version: null, running: false, port: 8080, source: 'none' });
});

test('detect: systemd 管理实例运行中 → source systemd', async () => {
  const { exec, calls } = makeExec((cmd, args) => {
    if (cmd === 'systemctl') return { code: 0, stdout: 'active\n' };
    if (cmd.includes('code-server-current') && args[0] === '--version') {
      return { code: 0, stdout: '4.106.3 deadbeef with Code 1.95.3\n' };
    }
    return { code: 1 };
  });
  const m = makeManager(exec, mkTmp());
  const s = await m.detect();
  assert.deepEqual(s, { installed: true, version: '4.106.3', running: true, port: 8080, source: 'systemd' });
  assert.equal(calls[0], 'systemctl --user is-active code-server');
});

test('detect: 仅 PATH 中有 code-server → source path 且不运行', async () => {
  const { exec } = makeExec((cmd, args) => {
    if (cmd === 'systemctl') return { code: 3, stdout: 'inactive\n' };
    if (cmd === 'code-server' && args[0] === '--version') return { code: 0, stdout: '4.106.3 abc\n' };
    return { code: 1 };
  });
  const m = makeManager(exec, mkTmp());
  const s = await m.detect();
  assert.deepEqual(s, { installed: true, version: '4.106.3', running: false, port: 8080, source: 'path' });
});

// ---------------------------------------------------------------- install

test('install: 调用序列正确（curl 带 -x → tar → ln → --version 验证）', async () => {
  const home = mkTmp();
  const { exec, calls } = makeExec((cmd, args) => {
    if (cmd === 'uname') return { code: 0, stdout: 'x86_64\n' };
    if (cmd === 'curl') {
      fs.writeFileSync(args[args.indexOf('-o') + 1]!, Buffer.alloc(2 * 1024 * 1024));
      return { code: 0 };
    }
    if (cmd === 'tar' || cmd === 'ln') return { code: 0 };
    if (args[0] === '--version') return { code: 0, stdout: '4.106.3 abc with Code 1.95.3\n' };
    return { code: 1 };
  });
  const m = makeManager(exec, home);
  const r = await m.install({ proxy: 'http://127.0.0.1:7890' });
  assert.deepEqual(r, { version: '4.106.3' });

  const curlIdx = calls.findIndex(c => c.startsWith('curl '));
  const tarIdx = calls.findIndex(c => c.startsWith('tar '));
  const lnIdx = calls.findIndex(c => c.startsWith('ln '));
  const verifyIdx = calls.findIndex(c => c.includes('code-server-current') && c.endsWith('--version'));
  assert.ok(curlIdx >= 0 && tarIdx > curlIdx && lnIdx > tarIdx && verifyIdx > lnIdx, `调用顺序错误: ${calls.join(' | ')}`);

  const curl = calls[curlIdx]!;
  assert.ok(curl.includes('-x http://127.0.0.1:7890'), 'curl 应带代理参数');
  assert.ok(curl.includes('code-server-4.106.3-linux-amd64.tar.gz'), '应下载 amd64 包');
  assert.ok(calls[lnIdx]!.includes('-sfn') && calls[lnIdx]!.includes('code-server-current'), '应创建 current 符号链接');
});

test('install: 未传 proxy 时回落 env https_proxy；都没有则不带 -x', async () => {
  const home = mkTmp();
  const { exec, calls } = makeExec((cmd, args) => {
    if (cmd === 'uname') return { code: 0, stdout: 'aarch64\n' };
    if (cmd === 'curl') {
      fs.writeFileSync(args[args.indexOf('-o') + 1]!, Buffer.alloc(2 * 1024 * 1024));
      return { code: 0 };
    }
    if (args[0] === '--version') return { code: 0, stdout: '4.106.3 abc\n' };
    return { code: 0 };
  });
  const m = makeManager(exec, home);

  const savedProxy = process.env.https_proxy;
  process.env.https_proxy = 'http://env-proxy:8888';
  try {
    await m.install();
    const curl1 = calls.find(c => c.startsWith('curl '))!;
    assert.ok(curl1.includes('-x http://env-proxy:8888'), '应使用 env 代理');
    assert.ok(curl1.includes('linux-arm64.tar.gz'), 'aarch64 应映射 arm64 包');
  } finally {
    if (savedProxy === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = savedProxy;
  }
  delete process.env.https_proxy;
  delete process.env.HTTPS_PROXY;

  calls.length = 0;
  await m.install();
  const curl2 = calls.find(c => c.startsWith('curl '))!;
  assert.ok(!curl2.includes(' -x '), '无代理时不应带 -x');
});

test('install: 下载失败抛带阶段的错误', async () => {
  const { exec } = makeExec(cmd =>
    cmd === 'uname' ? { code: 0, stdout: 'x86_64\n' } : { code: 22, stderr: 'HTTP 404' },
  );
  const m = makeManager(exec, mkTmp());
  await assert.rejects(() => m.install(), /stage download/);
});

// ---------------------------------------------------------------- start / stop / accessInfo

test('start: 生成密码入 SecretsStore、写 config/unit、systemd 启动并轮询健康检查', async () => {
  const home = mkTmp();
  const secrets = new SecretsStore(mkTmp());
  let healthCalls = 0;
  const { exec, calls } = makeExec(cmd => {
    if (cmd === 'curl') {
      healthCalls++;
      return healthCalls === 1 ? { code: 7, stderr: 'connection refused' } : { code: 0, stdout: 'ok' };
    }
    return { code: 0 };
  });
  const m = new IdeManager({ exec, secrets, homeDir: home, hostPlatform: 'linux' });
  const r = await m.start();
  assert.deepEqual(r, { port: 8080, reused: false });

  const password = secrets.get('code-server');
  assert.ok(password !== null && password.length >= 32, '密码应生成并存入 SecretsStore');

  const cfg = fs.readFileSync(path.join(home, '.config', 'code-server', 'config.yaml'), 'utf8');
  assert.match(cfg, /bind-addr: 127\.0\.0\.1:8080/);
  assert.match(cfg, /auth: password/);
  assert.match(cfg, /cert: false/);
  assert.ok(cfg.includes(`password: ${password}`), 'config.yaml 应含密码（code-server 自身机制）');

  const unit = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'code-server.service'), 'utf8');
  assert.ok(unit.includes(`ExecStart=${path.join(home, '.local', 'opt', 'code-server-current', 'bin', 'code-server')}`));
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);

  assert.ok(calls.includes('systemctl --user daemon-reload'));
  assert.ok(calls.includes('systemctl --user enable --now code-server'));
  assert.ok(healthCalls >= 2, '应有预检 + 至少一次轮询');

  // 幂等：重复 start 不换密码、仍成功
  const r2 = await m.start();
  assert.deepEqual(r2, { port: 8080, reused: false });
  assert.equal(secrets.get('code-server'), password);
});

test('start: 已有外部实例占用 8080 且无本服务配置 → 复用不覆盖', async () => {
  const home = mkTmp();
  const secrets = new SecretsStore(mkTmp());
  const { exec, calls } = makeExec(() => ({ code: 0, stdout: 'ok' }));
  const m = new IdeManager({ exec, secrets, homeDir: home, hostPlatform: 'linux' });
  const r = await m.start();
  assert.deepEqual(r, { port: 8080, reused: true });
  assert.ok(!fs.existsSync(path.join(home, '.config', 'code-server', 'config.yaml')), '不得覆盖外部实例配置');
  assert.ok(!calls.some(c => c.includes('enable --now')), '不得重启外部实例');
  assert.equal(secrets.get('code-server'), null, '复用场景不生成密码');
});

test('stop: 调用 systemctl --user stop', async () => {
  const { exec, calls } = makeExec(() => ({ code: 0 }));
  const m = makeManager(exec, mkTmp());
  await m.stop();
  assert.ok(calls.includes('systemctl --user stop code-server'));
});

test('accessInfo: 无密码返回 null，有密码返回 port+password', () => {
  const secrets = new SecretsStore(mkTmp());
  const m = makeManager(async () => ({ code: 0, stdout: '', stderr: '' }), mkTmp(), secrets);
  assert.equal(m.accessInfo(), null);
  secrets.set('code-server', 'pw-123');
  assert.deepEqual(m.accessInfo(), { port: 8080, password: 'pw-123' });
});

// ---------------------------------------------------------------- routes

function routeCtx(body: unknown = null): ExtraRouteCtx {
  return {
    deps: {} as ApiDeps,
    req: {} as IncomingMessage,
    url: new URL('http://127.0.0.1/v1/ide/status'),
    parts: [],
    params: {},
    readBody: () => Promise.resolve(body),
  };
}

function findRoute(routes: ExtraRoute[], method: string, ...parts: string[]): ExtraRoute {
  const r = routes.find(x => x.method === method && x.match(parts) !== null);
  assert.ok(r, `route not found: ${method} ${parts.join('/')}`);
  return r;
}

function okManager() {
  const secrets = new SecretsStore(mkTmp());
  const exec: ExecFn = async (cmd, args) => {
    if (cmd === 'uname') return { code: 0, stdout: 'x86_64\n', stderr: '' };
    if (cmd === 'curl' && args.some(a => a.endsWith('.tar.gz'))) {
      fs.writeFileSync(args[args.indexOf('-o') + 1]!, Buffer.alloc(2 * 1024 * 1024));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === '--version') return { code: 0, stdout: '4.106.3 abc\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { manager: new IdeManager({ exec, secrets, homeDir: mkTmp(), hostPlatform: 'linux' }), secrets };
}

test('routes: GET ide/status 返回检测状态与 hasPassword，不含密码', async () => {
  const { manager, secrets } = okManager();
  const route = findRoute(makeIdeRoutes(manager), 'GET', 'ide', 'status');

  let res = await route.handle(routeCtx());
  assert.equal(res.status, 200);
  let body = res.body as Record<string, unknown>;
  assert.equal(body.hasPassword, false);
  assert.ok(!('password' in body));

  secrets.set('code-server', 'top-secret-pw');
  res = await route.handle(routeCtx());
  body = res.body as Record<string, unknown>;
  assert.equal(body.hasPassword, true);
  assert.ok(!JSON.stringify(body).includes('top-secret-pw'), 'status 不得泄露密码');
});

test('routes: POST ide/install 透传 proxy 并返回版本；非法 proxy 报 400', async () => {
  const { manager } = okManager();
  const route = findRoute(makeIdeRoutes(manager), 'POST', 'ide', 'install');

  const res = await route.handle(routeCtx({ proxy: 'http://127.0.0.1:7890' }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { version: '4.106.3' });

  await assert.rejects(
    () => route.handle(routeCtx({ proxy: 123 })),
    (err: unknown) => (err as { status?: number }).status === 400,
  );
  await assert.rejects(
    () => route.handle(routeCtx('not-an-object')),
    (err: unknown) => (err as { status?: number }).status === 400,
  );
});

test('routes: POST ide/start 与 ide/stop', async () => {
  const { manager } = okManager();
  const routes = makeIdeRoutes(manager);
  const start = findRoute(routes, 'POST', 'ide', 'start');
  const stop = findRoute(routes, 'POST', 'ide', 'stop');

  const started = await start.handle(routeCtx());
  assert.equal(started.status, 200);
  assert.equal((started.body as { port: number }).port, 8080);

  const stopped = await stop.handle(routeCtx());
  assert.deepEqual(stopped.body, { stopped: true });
});

test('routes: GET ide/access 无密码 404，有密码返回 port/password/url', async () => {
  const { manager, secrets } = okManager();
  const route = findRoute(makeIdeRoutes(manager), 'GET', 'ide', 'access');

  await assert.rejects(
    () => route.handle(routeCtx()),
    (err: unknown) => (err as { status?: number }).status === 404,
  );

  secrets.set('code-server', 'pw-abc');
  const res = await route.handle(routeCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { port: 8080, password: 'pw-abc', url: 'http://127.0.0.1:8080' });
});

// ---------------------------------------------------------------- Windows 宿主（WSL 引导）

function makeWinManager(portUp: boolean) {
  const secrets = new SecretsStore(mkTmp());
  return new IdeManager({
    secrets,
    homeDir: mkTmp(),
    hostPlatform: 'win32',
    portProbe: async () => portUp,
  });
}

test('win32 detect: 8080 无监听 → hostUnsupported + none', async () => {
  const m = makeWinManager(false);
  const s = await m.detect();
  assert.deepEqual(s, {
    installed: false, version: null, running: false, port: 8080,
    source: 'none', hostUnsupported: true,
  });
});

test('win32 detect: 8080 有监听 → source wsl 且运行中', async () => {
  const m = makeWinManager(true);
  const s = await m.detect();
  assert.deepEqual(s, { installed: true, version: null, running: true, port: 8080, source: 'wsl' });
});

test('win32 install: 抛 WSL 指引错误，不执行任何安装命令', async () => {
  const m = makeWinManager(false);
  await assert.rejects(() => m.install(), /WSL/);
});

test('win32 start: 8080 有监听 → 复用；无监听 → 抛指引错误', async () => {
  const up = makeWinManager(true);
  assert.deepEqual(await up.start(), { port: 8080, reused: true });
  const down = makeWinManager(false);
  await assert.rejects(() => down.start(), /WSL/);
});

test('win32 accessInfo: 恒为 null（WSL 内密码无从得知）', () => {
  const m = makeWinManager(true);
  assert.equal(m.accessInfo(), null);
});

test('win32 routes: GET ide/access 返回 wsl 指引（password null）', async () => {
  const m = makeWinManager(true);
  const route = findRoute(makeIdeRoutes(m), 'GET', 'ide', 'access');
  const res = await route.handle(routeCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { port: 8080, password: null, url: 'http://127.0.0.1:8080', wsl: true });
});
