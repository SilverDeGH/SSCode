/**
 * 终端会话管理（P5-07 服务端）：每项目一个持久终端会话。
 *
 * tmux 后端架构（Linux 实测可用）：不走 tmux client attach（经 script PTY 管道
 * 按键只回显不执行，已知不可靠），改为：
 *   输入：tmux send-keys（-l 送字面文本，控制字符映射命名键）
 *   输出：tmux pipe-pane → 临时文件 → tail -F 广播给所有 attach 的客户端
 *   重连：tmux 会话在服务端持续存在；新客户端先收 capture-pane 屏幕快照再接实时流
 * tmux 缺失退化 script + shell；script 也缺失退化 spawn bash -i。
 *
 * persist 后端（Windows）：无 tmux/script，spawn PowerShell（缺则 cmd）并保持进程
 * 存活于服务进程内，输出写入环形缓冲；新客户端 attach 先回放缓冲再接实时流——
 * 断线可接回（服务进程存活期间；服务重启即丢失，与 tmux 的差异如实告知用户）。
 * 无 PTY：resize 忽略、全屏交互程序（vim 等）不可用。
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killProcessTree } from '../util/prockill.ts';

export type TerminalBackend = 'tmux' | 'script' | 'spawn' | 'persist';

export interface TerminalHandle {
  readonly backend: TerminalBackend;
  write(data: string | Buffer): void;
  /** 尽力而为：tmux 后端 exec resize-window，失败静默；其余后端忽略 */
  resize(cols: number, rows: number): void;
  onData(cb: (data: Buffer) => void): void;
  onExit(cb: () => void): void;
  /** 断开本客户端（tmux 会话保留；销毁走 TerminalManager.destroy） */
  kill(): void;
}

export interface TerminalStatus {
  exists: boolean;
  backend?: TerminalBackend;
}

function commandWorks(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** 会话名：sscode-<projectId 前 8 位字母数字>（需求 9.2 断线重连的识别依据） */
export function sessionName(projectId: string): string {
  const short = projectId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'default';
  return `sscode-${short}`;
}

// ---------------------------------------------------------------- tmux 后端

/** 控制字符 → tmux 命名键 */
const NAMED_CONTROL_KEYS: Record<string, string> = {
  '\r': 'Enter',
  '\n': 'Enter',
  '\t': 'Tab',
  '\x03': 'C-c',
  '\x04': 'C-d',
  '\x1a': 'C-z',
  '\x7f': 'BSpace',
};

const ARROW_KEYS: Record<string, string> = {
  A: 'Up',
  B: 'Down',
  C: 'Right',
  D: 'Left',
};

/** 方向键等转义序列跨 write 拆分时暂存，超时按独立 Escape 冲刷 */
const ESCAPE_FLUSH_MS = 50;

interface TmuxSession {
  projectId: string;
  name: string;
  outFile: string;
  handles: Set<TmuxHandle>;
  tail: ChildProcess | null;
  streaming: boolean;
  /** send-keys 调用串行化，保证输入顺序 */
  inputQueue: Promise<void>;
  pendingInput: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

class TmuxHandle implements TerminalHandle {
  readonly backend = 'tmux' as const;
  #session: TmuxSession;
  #manager: TerminalManager;
  #dataCbs: ((data: Buffer) => void)[] = [];
  #exitCbs: (() => void)[] = [];
  #exited = false;

  constructor(session: TmuxSession, manager: TerminalManager) {
    this.#session = session;
    this.#manager = manager;
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** 会话级广播入口（tail 输出 / capture-pane 快照） */
  emitData(data: Buffer): void {
    if (this.#exited) return;
    for (const cb of this.#dataCbs) cb(data);
  }

  write(data: string | Buffer): void {
    if (this.#exited) return;
    const text = typeof data === 'string' ? data : data.toString('utf8');
    this.#manager.tmuxInput(this.#session, text);
  }

  resize(cols: number, rows: number): void {
    if (!validSize(cols, rows)) return;
    this.#manager.tmuxResize(this.#session, cols, rows);
  }

  onData(cb: (data: Buffer) => void): void {
    this.#dataCbs.push(cb);
  }

  onExit(cb: () => void): void {
    if (this.#exited) cb();
    else this.#exitCbs.push(cb);
  }

  kill(): void {
    this.disconnect();
  }

  /** 断开本客户端；最后一个客户端断开时由 manager 停止输出流（不杀 tmux 会话） */
  disconnect(): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#manager.detachTmux(this.#session, this);
    for (const cb of this.#exitCbs) cb();
  }
}

// ---------------------------------------------------------------- script/spawn 后端

interface PtySessionRecord {
  projectId: string;
  name: string;
  backend: 'script' | 'spawn';
  handles: Set<PtyHandle>;
}

class PtyHandle implements TerminalHandle {
  readonly backend: 'script' | 'spawn';
  #proc: ChildProcess;
  #dataCbs: ((data: Buffer) => void)[] = [];
  #exitCbs: (() => void)[] = [];
  #exited = false;

  constructor(
    proc: ChildProcess,
    backend: 'script' | 'spawn',
    onFinalExit: () => void,
  ) {
    this.#proc = proc;
    this.backend = backend;
    const emitData = (d: Buffer): void => {
      for (const cb of this.#dataCbs) cb(d);
    };
    proc.stdout?.on('data', emitData);
    proc.stderr?.on('data', emitData);
    const emitExit = (): void => {
      if (this.#exited) return;
      this.#exited = true;
      onFinalExit();
      for (const cb of this.#exitCbs) cb();
    };
    proc.on('close', emitExit);
    proc.on('error', emitExit);
  }

  get exited(): boolean {
    return this.#exited;
  }

  write(data: string | Buffer): void {
    if (this.#exited) return;
    try {
      this.#proc.stdin?.write(data);
    } catch {
      // 进程已退出
    }
  }

  resize(cols: number, rows: number): void {
    // script 的 PTY 无可靠 ioctl 通道，忽略
    void cols;
    void rows;
  }

  onData(cb: (data: Buffer) => void): void {
    this.#dataCbs.push(cb);
  }

  onExit(cb: () => void): void {
    if (this.#exited) cb();
    else this.#exitCbs.push(cb);
  }

  kill(): void {
    if (this.#exited) return;
    try {
      this.#proc.kill('SIGTERM');
    } catch {
      // 进程已退出
    }
  }
}

function validSize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    rows >= 1 &&
    cols <= 1000 &&
    rows <= 1000
  );
}

// ---------------------------------------------------------------- persist 后端（Windows）

/** 回放缓冲上限：超出后丢弃最旧数据（128KB 尾部） */
const PERSIST_RING_MAX = 128 * 1024;

/** shell 候选：优先 PowerShell（输出强制 UTF-8），缺则 cmd（chcp 65001） */
const PERSIST_SHELLS: { cmd: string; args: string[] }[] = [
  {
    cmd: 'powershell.exe',
    args: [
      '-NoLogo', '-NoProfile', '-NoExit', '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; try { [Console]::InputEncoding=[System.Text.Encoding]::UTF8 } catch {}',
    ],
  },
  { cmd: 'cmd.exe', args: ['/d', '/k', 'chcp 65001 >nul'] },
];

interface PersistSession {
  projectId: string;
  proc: ChildProcess;
  handles: Set<PersistHandle>;
  /** 环形输出缓冲：重连客户端回放用（尾部 PERSIST_RING_MAX 字节） */
  ring: Buffer[];
  ringBytes: number;
  exited: boolean;
}

function ringPush(session: PersistSession, data: Buffer): void {
  session.ring.push(data);
  session.ringBytes += data.length;
  while (session.ringBytes > PERSIST_RING_MAX && session.ring.length > 0) {
    const head = session.ring[0]!;
    session.ringBytes -= head.length;
    session.ring.shift();
  }
}

class PersistHandle implements TerminalHandle {
  readonly backend = 'persist' as const;
  #session: PersistSession;
  #manager: TerminalManager;
  #dataCbs: ((data: Buffer) => void)[] = [];
  #exitCbs: (() => void)[] = [];
  #exited = false;

  constructor(session: PersistSession, manager: TerminalManager) {
    this.#session = session;
    this.#manager = manager;
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** 会话级广播入口（shell 输出 / 缓冲回放） */
  emitData(data: Buffer): void {
    if (this.#exited) return;
    for (const cb of this.#dataCbs) cb(data);
  }

  /** shell 进程退出：通知所有 attach 的客户端（不经过 disconnect 清理路径） */
  processExited(): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const cb of this.#exitCbs) cb();
  }

  write(data: string | Buffer): void {
    if (this.#exited) return;
    try {
      this.#session.proc.stdin?.write(data);
    } catch {
      // 进程已退出
    }
  }

  resize(cols: number, rows: number): void {
    // 无 PTY，忽略
    void cols;
    void rows;
  }

  onData(cb: (data: Buffer) => void): void {
    this.#dataCbs.push(cb);
  }

  onExit(cb: () => void): void {
    if (this.#exited) cb();
    else this.#exitCbs.push(cb);
  }

  kill(): void {
    this.disconnect();
  }

  /** 断开本客户端；shell 进程与缓冲保留（重连接回，销毁走 TerminalManager.destroy） */
  disconnect(): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#manager.detachPersist(this.#session, this);
    for (const cb of this.#exitCbs) cb();
  }
}

// ---------------------------------------------------------------- Manager

export class TerminalManager {
  #tmuxSessions = new Map<string, TmuxSession>();
  #ptySessions = new Map<string, PtySessionRecord>();
  #persistSessions = new Map<string, PersistSession>();
  #hasTmux: boolean;
  #hasScript: boolean;
  #hasPowerShell: boolean;

  constructor() {
    this.#hasTmux = commandWorks('tmux', ['-V']);
    this.#hasScript = commandWorks('script', ['--version']);
    this.#hasPowerShell =
      process.platform === 'win32' &&
      commandWorks('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']);
  }

  #pickBackend(): TerminalBackend {
    if (process.platform === 'win32') return 'persist';
    if (this.#hasTmux) return 'tmux';
    if (this.#hasScript) return 'script';
    return 'spawn';
  }

  /** health 能力上报用 */
  preferredBackend(): TerminalBackend {
    return this.#pickBackend();
  }

  attach(projectId: string, projectPath: string): TerminalHandle {
    const backend = this.#pickBackend();
    if (backend === 'tmux') return this.#attachTmux(projectId, projectPath);
    if (backend === 'persist') return this.#attachPersist(projectId, projectPath);
    return this.#attachPty(projectId, projectPath, backend);
  }

  // ------------------------------------------------------------ tmux 路径

  #tmuxHasSession(name: string): boolean {
    return commandWorks('tmux', ['has-session', '-t', name]);
  }

  /** 尽力而为的 tmux 调用：失败静默 */
  #tmux(args: string[]): Promise<void> {
    return new Promise((resolve) => {
      execFile('tmux', args, () => resolve());
    });
  }

  #attachTmux(projectId: string, projectPath: string): TmuxHandle {
    const name = sessionName(projectId);
    if (!this.#tmuxHasSession(name)) {
      execFileSync(
        'tmux',
        ['new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-c', projectPath],
        { stdio: 'ignore' },
      );
    }
    let session = this.#tmuxSessions.get(projectId);
    if (session === undefined) {
      const dir = path.join(os.tmpdir(), 'sscode-term');
      fs.mkdirSync(dir, { recursive: true });
      session = {
        projectId,
        name,
        outFile: path.join(dir, `${name}.out`),
        handles: new Set(),
        tail: null,
        streaming: false,
        inputQueue: Promise.resolve(),
        pendingInput: '',
        flushTimer: null,
      };
      this.#tmuxSessions.set(projectId, session);
    }
    const handle = new TmuxHandle(session, this);
    session.handles.add(handle);
    if (!session.streaming) this.#startStream(session);
    // 重连初始画面：当前屏幕快照（含转义序列）
    execFile('tmux', ['capture-pane', '-p', '-e', '-t', name], (err, stdout) => {
      if (err === null && stdout.length > 0) handle.emitData(Buffer.from(stdout, 'utf8'));
    });
    return handle;
  }

  #startStream(session: TmuxSession): void {
    session.streaming = true;
    // 截断旧文件，避免向重连客户端重放历史输出
    try {
      fs.writeFileSync(session.outFile, '');
    } catch {
      // 目录不可写时输出流不可用，输入仍可用
    }
    const tail = spawn('tail', ['-n', '+1', '-F', session.outFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    session.tail = tail;
    tail.stdout?.on('data', (d: Buffer) => {
      for (const h of session.handles) h.emitData(d);
    });
    tail.stderr?.on('data', () => {});
    tail.on('error', () => {});
    // 经 inputQueue 串行化，保证与 stopStream 的关管道、后续输入的先后顺序
    session.inputQueue = session.inputQueue.then(() =>
      this.#tmux(['pipe-pane', '-o', '-t', session.name, `cat >> "${session.outFile}"`]),
    );
  }

  #stopStream(session: TmuxSession): void {
    if (!session.streaming) return;
    session.streaming = false;
    // pipe-pane 不带命令参数 = 关闭管道；经 inputQueue 保持与重连时重开的顺序
    session.inputQueue = session.inputQueue.then(() =>
      this.#tmux(['pipe-pane', '-t', session.name]),
    );
    session.tail?.kill('SIGTERM');
    session.tail = null;
    fs.promises.rm(session.outFile, { force: true }).catch(() => {});
  }

  /** TmuxHandle 回调：编码输入并经队列串行 send-keys */
  tmuxInput(session: TmuxSession, data: string): void {
    const queue = (args: string[]): void => {
      session.inputQueue = session.inputQueue.then(() => this.#tmux(args));
    };
    let text = '';
    const flushText = (): void => {
      if (text.length === 0) return;
      queue(['send-keys', '-t', session.name, '-l', '--', text]);
      text = '';
    };
    const sendKey = (key: string): void => {
      flushText();
      queue(['send-keys', '-t', session.name, key]);
    };

    const input = session.pendingInput + data;
    session.pendingInput = '';
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }

    let i = 0;
    while (i < input.length) {
      const ch = input[i]!;
      if (ch === '\x1b') {
        const rest = input.slice(i);
        if (rest === '\x1b' || rest === '\x1b[') {
          // 转义序列可能跨 write 拆分，暂存等后续数据或超时
          session.pendingInput = rest;
          break;
        }
        const arrow = rest.length >= 3 && rest[1] === '[' ? ARROW_KEYS[rest[2]!] : undefined;
        if (arrow !== undefined) {
          sendKey(arrow);
          i += 3;
          continue;
        }
        sendKey('Escape');
        i += 1;
        continue;
      }
      const named = NAMED_CONTROL_KEYS[ch];
      if (named !== undefined) {
        sendKey(named);
        i += 1;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code === 0) {
        i += 1;
        continue;
      }
      if (code < 0x20) {
        sendKey(`C-${String.fromCharCode(code + 96)}`);
        i += 1;
        continue;
      }
      text += ch;
      i += 1;
    }
    flushText();

    if (session.pendingInput.length > 0 && session.flushTimer === null) {
      session.flushTimer = setTimeout(() => {
        session.flushTimer = null;
        const pending = session.pendingInput;
        session.pendingInput = '';
        if (pending.length === 0) return;
        sendKey('Escape');
        if (pending === '\x1b[') {
          text += '[';
          flushText();
        }
      }, ESCAPE_FLUSH_MS);
      session.flushTimer.unref();
    }
  }

  /** TmuxHandle 回调 */
  tmuxResize(session: TmuxSession, cols: number, rows: number): void {
    void this.#tmux([
      'resize-window', '-t', session.name, '-x', String(cols), '-y', String(rows),
    ]);
  }

  /** TmuxHandle 回调：摘除客户端；最后一个断开时停止输出流（不杀 tmux 会话） */
  detachTmux(session: TmuxSession, handle: TmuxHandle): void {
    session.handles.delete(handle);
    if (session.handles.size === 0) this.#stopStream(session);
  }

  // ------------------------------------------------------------ persist（Windows）路径

  #attachPersist(projectId: string, projectPath: string): PersistHandle {
    let session = this.#persistSessions.get(projectId);
    if (session !== undefined && session.exited) {
      this.#persistSessions.delete(projectId);
      session = undefined;
    }
    if (session === undefined) {
      const env = { ...process.env, TERM: process.env.TERM ?? 'xterm-256color' };
      const shell = this.#hasPowerShell ? PERSIST_SHELLS[0]! : PERSIST_SHELLS[1]!;
      const proc = spawn(shell.cmd, shell.args, { cwd: projectPath, env, windowsHide: true });
      const rec: PersistSession = {
        projectId,
        proc,
        handles: new Set(),
        ring: [],
        ringBytes: 0,
        exited: false,
      };
      proc.stdout?.on('data', (d: Buffer) => this.#persistBroadcast(rec, d));
      proc.stderr?.on('data', (d: Buffer) => this.#persistBroadcast(rec, d));
      proc.on('close', () => this.#persistProcessExit(rec));
      proc.on('error', () => this.#persistProcessExit(rec));
      this.#persistSessions.set(projectId, rec);
      session = rec;
    }
    const handle = new PersistHandle(session, this);
    session.handles.add(handle);
    // Wait until attach()'s caller has subscribed; synchronous replay is lost.
    if (session.ringBytes > 0) {
      const replay = Buffer.concat(session.ring);
      queueMicrotask(() => handle.emitData(replay));
    }
    return handle;
  }

  #persistBroadcast(session: PersistSession, data: Buffer): void {
    if (session.exited) return;
    ringPush(session, data);
    for (const h of session.handles) h.emitData(data);
  }

  #persistProcessExit(session: PersistSession): void {
    if (session.exited) return;
    session.exited = true;
    this.#persistSessions.delete(session.projectId);
    for (const h of [...session.handles]) h.processExited();
  }

  /** PersistHandle 回调：摘除客户端；shell 进程与缓冲保留，重连接回 */
  detachPersist(session: PersistSession, handle: PersistHandle): void {
    session.handles.delete(handle);
  }

  // ------------------------------------------------------------ script/spawn 路径

  #attachPty(
    projectId: string,
    projectPath: string,
    backend: 'script' | 'spawn',
  ): PtyHandle {
    const env = { ...process.env, TERM: process.env.TERM ?? 'xterm-256color' };
    let proc: ChildProcess;
    if (backend === 'script') {
      const shell = process.env.SHELL ?? 'bash';
      proc = spawn('script', ['-qfc', shell, '/dev/null'], { cwd: projectPath, env });
    } else {
      proc = spawn('bash', ['-i'], { cwd: projectPath, env });
    }
    let rec = this.#ptySessions.get(projectId);
    if (rec === undefined) {
      rec = { projectId, name: sessionName(projectId), backend, handles: new Set() };
      this.#ptySessions.set(projectId, rec);
    }
    const record = rec;
    const handle = new PtyHandle(proc, backend, () => {
      record.handles.delete(handle);
      // 无服务端持久会话，最后一个 attach 退出即清理
      if (record.handles.size === 0) this.#ptySessions.delete(projectId);
    });
    record.handles.add(handle);
    return handle;
  }

  // ------------------------------------------------------------ 公共操作

  status(projectId: string): TerminalStatus {
    const ts = this.#tmuxSessions.get(projectId);
    if (ts !== undefined) return { exists: true, backend: 'tmux' };
    const ps = this.#ptySessions.get(projectId);
    if (ps !== undefined) return { exists: true, backend: ps.backend };
    const ws = this.#persistSessions.get(projectId);
    if (ws !== undefined) return { exists: true, backend: 'persist' };
    // 服务重启后内存表丢失，但 tmux 会话可能仍在
    if (this.#hasTmux && this.#tmuxHasSession(sessionName(projectId))) {
      return { exists: true, backend: 'tmux' };
    }
    return { exists: false };
  }

  /** 显式销毁：断开所有客户端、关管道、杀 tmux 会话、删临时文件 */
  destroy(projectId: string): void {
    const ts = this.#tmuxSessions.get(projectId);
    if (ts !== undefined) {
      if (ts.flushTimer !== null) clearTimeout(ts.flushTimer);
      for (const h of [...ts.handles]) h.disconnect();
      this.#stopStream(ts);
      this.#tmuxSessions.delete(projectId);
      void this.#tmux(['kill-session', '-t', ts.name]);
    } else if (this.#hasTmux) {
      void this.#tmux(['kill-session', '-t', sessionName(projectId)]);
      fs.promises
        .rm(path.join(os.tmpdir(), 'sscode-term', `${sessionName(projectId)}.out`), { force: true })
        .catch(() => {});
    }
    const ps = this.#ptySessions.get(projectId);
    if (ps !== undefined) {
      for (const h of [...ps.handles]) h.kill();
      this.#ptySessions.delete(projectId);
    }
    const ws = this.#persistSessions.get(projectId);
    if (ws !== undefined) {
      this.#persistSessions.delete(projectId);
      for (const h of [...ws.handles]) h.disconnect();
      killProcessTree(ws.proc);
    }
  }

  killAll(): void {
    const ids = new Set([
      ...this.#tmuxSessions.keys(),
      ...this.#ptySessions.keys(),
      ...this.#persistSessions.keys(),
    ]);
    for (const id of ids) this.destroy(id);
  }
}
