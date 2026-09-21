import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SecretsStore } from '../ai/secrets.ts';
import { killProcessTree } from '../util/prockill.ts';

/** 可注入的命令执行器：实现类构造接收，测试注入假实现 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface IdeStatus {
  installed: boolean;
  version: string | null;
  running: boolean;
  port: number;
  source: 'systemd' | 'path' | 'none' | 'wsl';
  /** Windows 原生宿主不支持 code-server：安装/启动由用户在 WSL 内自行完成 */
  hostUnsupported?: boolean;
}

export const IDE_PORT = 8080;
export const IDE_SECRET_REF = 'code-server';

const CODE_SERVER_VERSION = '4.106.3';
const MIN_TARBALL_BYTES = 1024 * 1024;
const HEALTH_URL = `http://127.0.0.1:${IDE_PORT}/healthz`;
const HEALTH_TIMEOUT_MS = 30000;

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    const timeoutMs = opts?.timeoutMs ?? 120000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ code: 124, stdout, stderr: `${stderr}\ncommand timed out after ${timeoutMs}ms` });
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** TCP 探测端口是否有监听（Windows 宿主探测 WSL 转发的 code-server 用） */
function portListening(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

function parseVersion(stdout: string): string | null {
  return stdout.trim().split(/\s+/)[0] ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * code-server 生命周期管理：检测 / 安装（standalone tarball）/ systemd 用户级启动 / 访问信息。
 * 安全约束（需求 3.2/10）：固定 127.0.0.1:8080 + auth password，密码只进 SecretsStore，
 * 日志与错误信息不落密码；检测到非本服务管理的已有实例时不覆盖配置，直接复用。
 * 所有方法幂等，可重复调用。
 */
export class IdeManager {
  #exec: ExecFn;
  #secrets: SecretsStore;
  #homeDir: string;
  #platform: NodeJS.Platform;
  #portProbe: (port: number) => Promise<boolean>;

  constructor(opts: {
    exec?: ExecFn;
    secrets: SecretsStore;
    homeDir?: string;
    hostPlatform?: NodeJS.Platform;
    portProbe?: (port: number) => Promise<boolean>;
  }) {
    this.#exec = opts.exec ?? defaultExec;
    this.#secrets = opts.secrets;
    // Windows 上 HOME 可能被类 Unix 环境设成 POSIX 风格路径，优先 os.homedir()
    this.#homeDir = opts.homeDir ?? os.homedir();
    // 可注入宿主平台：测试在 Windows 机器上也能验证 Linux 路径
    this.#platform = opts.hostPlatform ?? process.platform;
    this.#portProbe = opts.portProbe ?? portListening;
  }

  get isWindowsHost(): boolean {
    return this.#platform === 'win32';
  }

  get #binPath(): string {
    return path.join(this.#homeDir, '.local', 'opt', 'code-server-current', 'bin', 'code-server');
  }

  get #configPath(): string {
    return path.join(this.#homeDir, '.config', 'code-server', 'config.yaml');
  }

  /** 命令不存在等异常统一归为 code 127，探测类逻辑不抛错 */
  async #tryExec(cmd: string, args: string[], timeoutMs = 15000) {
    try {
      return await this.#exec(cmd, args, { timeoutMs });
    } catch (err) {
      return { code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
  }

  async #healthz(timeoutMs = 5000): Promise<boolean> {
    const r = await this.#tryExec('curl', ['-s', '-o', '/dev/null', HEALTH_URL], timeoutMs);
    return r.code === 0;
  }

  /** 探测优先级：systemd 用户服务 → ~/.local/opt 安装 → PATH；Windows 走 WSL 探测 */
  async detect(): Promise<IdeStatus> {
    if (this.isWindowsHost) {
      // code-server 不支持 Windows 原生：仅探测 8080 是否有 WSL 内实例（WSL2 会转发到宿主回环）
      const running = await this.#portProbe(IDE_PORT);
      if (running) {
        return { installed: true, version: null, running: true, port: IDE_PORT, source: 'wsl' };
      }
      return { installed: false, version: null, running: false, port: IDE_PORT, source: 'none', hostUnsupported: true };
    }

    const active = await this.#tryExec('systemctl', ['--user', 'is-active', 'code-server']);
    const running = active.code === 0 && active.stdout.trim() === 'active';

    const local = await this.#tryExec(this.#binPath, ['--version']);
    if (local.code === 0) {
      return { installed: true, version: parseVersion(local.stdout), running, port: IDE_PORT, source: 'systemd' };
    }
    const onPath = await this.#tryExec('code-server', ['--version']);
    if (onPath.code === 0) {
      return { installed: true, version: parseVersion(onPath.stdout), running, port: IDE_PORT, source: 'path' };
    }
    return { installed: false, version: null, running, port: IDE_PORT, source: 'none' };
  }

  async install(opts?: { proxy?: string; arch?: string }): Promise<{ version: string }> {
    if (this.isWindowsHost) {
      throw new Error('code-server 不支持 Windows 原生安装：请在 WSL 内安装并在其中启动（监听 127.0.0.1:8080 即可被手机访问）');
    }
    const proxy = opts?.proxy ?? process.env.https_proxy ?? process.env.HTTPS_PROXY;
    let arch = opts?.arch;
    if (arch === undefined) {
      const uname = await this.#tryExec('uname', ['-m']);
      const machine = uname.code === 0 ? uname.stdout.trim() : '';
      if (machine === 'x86_64') arch = 'amd64';
      else if (machine === 'aarch64' || machine === 'arm64') arch = 'arm64';
      else throw new Error(`install failed at stage arch: unsupported machine '${machine}'`);
    }

    const pkg = `code-server-${CODE_SERVER_VERSION}-linux-${arch}`;
    const url = `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${pkg}.tar.gz`;
    const optDir = path.join(this.#homeDir, '.local', 'opt');
    fs.mkdirSync(optDir, { recursive: true });
    const tarball = path.join(optDir, `${pkg}.tar.gz`);

    const curlArgs = ['-fSL', '--retry', '3', '-o', tarball];
    if (proxy !== undefined && proxy !== '') curlArgs.push('-x', proxy);
    curlArgs.push(url);
    const dl = await this.#tryExec('curl', curlArgs, 600000);
    if (dl.code !== 0) {
      throw new Error(`install failed at stage download: ${dl.stderr.trim() || `curl exit ${dl.code}`}`);
    }
    let size = 0;
    try {
      size = fs.statSync(tarball).size;
    } catch {
      // 文件缺失按大小 0 处理
    }
    if (size <= MIN_TARBALL_BYTES) {
      fs.rmSync(tarball, { force: true });
      throw new Error(`install failed at stage verify-size: tarball too small (${size} bytes)`);
    }

    const untar = await this.#tryExec('tar', ['-xzf', tarball, '-C', optDir], 300000);
    fs.rmSync(tarball, { force: true });
    if (untar.code !== 0) {
      throw new Error(`install failed at stage extract: ${untar.stderr.trim() || `tar exit ${untar.code}`}`);
    }

    const link = await this.#tryExec('ln', ['-sfn', path.join(optDir, pkg), path.join(optDir, 'code-server-current')]);
    if (link.code !== 0) {
      throw new Error(`install failed at stage link: ${link.stderr.trim() || `ln exit ${link.code}`}`);
    }

    const verify = await this.#tryExec(this.#binPath, ['--version']);
    if (verify.code !== 0) {
      throw new Error(`install failed at stage verify: code-server --version exit ${verify.code}`);
    }
    return { version: parseVersion(verify.stdout) ?? CODE_SERVER_VERSION };
  }

  async start(): Promise<{ port: number; reused: boolean }> {
    if (this.isWindowsHost) {
      // 不代管 WSL 内进程：仅探测并复用已运行的实例
      if (await this.#portProbe(IDE_PORT)) return { port: IDE_PORT, reused: true };
      throw new Error('Windows 宿主不启动 code-server：请在 WSL 内启动并监听 127.0.0.1:8080（WSL2 自动转发到宿主回环）');
    }
    if (!fs.existsSync(this.#configPath) && (await this.#healthz())) {
      // 8080 已有响应但无本服务配置：外部实例，不重启不覆盖，报告复用
      return { port: IDE_PORT, reused: true };
    }

    let password = this.#secrets.get(IDE_SECRET_REF);
    if (password === null) {
      password = crypto.randomBytes(24).toString('base64url');
      this.#secrets.set(IDE_SECRET_REF, password);
    }

    fs.mkdirSync(path.dirname(this.#configPath), { recursive: true });
    fs.writeFileSync(
      this.#configPath,
      ['bind-addr: 127.0.0.1:8080', 'auth: password', `password: ${password}`, 'cert: false', ''].join('\n'),
      'utf8',
    );
    try {
      fs.chmodSync(this.#configPath, 0o600);
    } catch {
      // Windows 上 chmod 可能无效，忽略
    }

    const unitDir = path.join(this.#homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'code-server.service'),
      [
        '[Unit]',
        'Description=code-server (managed by sscode-server)',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${this.#binPath}`,
        'Restart=on-failure',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
      'utf8',
    );

    const reload = await this.#tryExec('systemctl', ['--user', 'daemon-reload']);
    if (reload.code !== 0) {
      throw new Error(`start failed at stage daemon-reload: ${reload.stderr.trim() || `exit ${reload.code}`}`);
    }
    const enable = await this.#tryExec('systemctl', ['--user', 'enable', '--now', 'code-server']);
    if (enable.code !== 0) {
      throw new Error(`start failed at stage enable: ${enable.stderr.trim() || `exit ${enable.code}`}`);
    }

    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      if (await this.#healthz()) return { port: IDE_PORT, reused: false };
      if (Date.now() >= deadline) {
        throw new Error('start failed at stage health-check: code-server did not become ready within 30s');
      }
      await delay(1000);
    }
  }

  async stop(): Promise<void> {
    if (this.isWindowsHost) {
      throw new Error('Windows 宿主不管理 WSL 内的 code-server 进程：请在 WSL 内自行停止');
    }
    const r = await this.#tryExec('systemctl', ['--user', 'stop', 'code-server']);
    if (r.code !== 0) {
      throw new Error(`stop failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
  }

  /** 访问信息（密码来自 SecretsStore）；未生成密码时返回 null */
  accessInfo(): { port: number; password: string } | null {
    if (this.isWindowsHost) {
      // WSL 内 code-server 的密码由用户在其 WSL 中查看，本服务无从得知
      return null;
    }
    const password = this.#secrets.get(IDE_SECRET_REF);
    if (password === null) return null;
    return { port: IDE_PORT, password };
  }
}
