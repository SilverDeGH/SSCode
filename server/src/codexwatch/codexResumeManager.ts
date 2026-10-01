import path from 'node:path';
import { spawn } from 'node:child_process';
import { httpError } from '../api/server.ts';
import { ERR } from '../types.ts';

/** 可注入的 spawn（测试用假实现替换，类型同 node:child_process.spawn） */
export type SpawnFn = typeof spawn;

/** stderr 摘要截断，避免错误信息过长 */
function truncate(value: string, length = 300): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

type ExecResult =
  | { running: false; code: number; stderr: string }
  | { running: true; done: Promise<{ code: number; stderr: string }> };

/**
 * 向 Codex 线程继续发消息（写通道）：spawn `codex exec resume <threadId> <text>` 一次性子进程。
 * 新 turn 由 codex 自己写回 ~/.codex sqlite，CodexWatchManager 轮询会把更新推给客户端。
 * 只传位置参数，不加 -s/-C 等 flag（部分 codex 版本的 exec resume 拒绝）。
 * 同一线程互斥（409）；CLI 可用性懒检测一次并缓存（失败缓存为 503）。
 * 一轮 turn 可能跑很久，不等进程结束：宽限期（graceMs）内退出即按退出码判定成败
 * （线程不存在等错误会立刻失败），过了宽限期仍在运行视为已受理，turn 在后台继续，
 * 互斥锁保留到进程真正退出。
 * codexBin 带路径时（如 /home/x/.local/node/bin/codex）把其目录前置到子进程 PATH：
 * codex 是 `#!/usr/bin/env node` 脚本，systemd 环境的 PATH 里未必有 node。
 */
export class CodexResumeManager {
  #codexBin: string;
  #spawnFn: SpawnFn;
  #graceMs: number;
  #inFlight = new Set<string>();
  #cliReady: Promise<void> | null = null;

  constructor(opts: { codexBin?: string; spawnFn?: SpawnFn; graceMs?: number } = {}) {
    this.#codexBin = opts.codexBin ?? process.env.SSCODE_CODEX_BIN ?? 'codex';
    this.#spawnFn = opts.spawnFn ?? spawn;
    this.#graceMs = opts.graceMs ?? 3_000;
  }

  async sendMessage(threadId: string, text: string, cwd: string): Promise<void> {
    if (this.#inFlight.has(threadId)) {
      throw httpError(409, ERR.CONFLICT, 'codex thread is busy');
    }
    this.#inFlight.add(threadId);
    let keepLocked = false;
    try {
      await this.#ensureCli();
      const result = await this.#exec(['exec', 'resume', threadId, text], cwd, this.#graceMs);
      if (result.running) {
        keepLocked = true;
        void result.done
          .catch(() => {})
          .finally(() => {
            this.#inFlight.delete(threadId);
          });
        return;
      }
      if (result.code !== 0) {
        throw httpError(502, ERR.INTERNAL, `codex exec resume failed (exit ${result.code}): ${truncate(result.stderr)}`);
      }
    } finally {
      if (!keepLocked) this.#inFlight.delete(threadId);
    }
  }

  /** 懒检测 codex CLI 可用（--version），只检测一次并缓存结果（含失败） */
  #ensureCli(): Promise<void> {
    this.#cliReady ??= this.#probeCli();
    return this.#cliReady;
  }

  async #probeCli(): Promise<void> {
    try {
      const result = await this.#exec(['--version']);
      if (result.running || result.code !== 0) throw new Error('probe failed');
    } catch {
      throw httpError(503, ERR.INVALID_STATE, 'codex cli unavailable');
    }
  }

  /**
   * spawn 子进程；收集 stderr（截断保留尾部 4KB）；spawn error（如 ENOENT）reject。
   * 未给 graceMs 时等待退出；给了 graceMs 且到时仍在运行则返回 running: true，
   * 进程在后台继续，退出码经 done 回传。
   */
  #exec(args: string[], cwd?: string, graceMs?: number): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = this.#spawnFn(this.#codexBin, args, { cwd, windowsHide: true, env: this.#childEnv() });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 4096) stderr = stderr.slice(-4096);
      });
      const done = new Promise<{ code: number; stderr: string }>((res, rej) => {
        child.on('error', rej);
        child.on('close', (code) => res({ code: code ?? 1, stderr }));
      });
      if (graceMs === undefined) {
        done.then(
          ({ code, stderr: err }) => resolve({ running: false, code, stderr: err }),
          reject,
        );
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ running: true, done });
      }, graceMs);
      timer.unref();
      done.then(
        ({ code, stderr: err }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ running: false, code, stderr: err });
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** 子进程环境：codexBin 含路径时把所在目录前置到 PATH（/usr/bin/env node 能找到 node） */
  #childEnv(): NodeJS.ProcessEnv {
    const dir = path.dirname(this.#codexBin);
    if (dir === '.' || dir === '') return process.env;
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const current = process.env[key] ?? '';
    return { ...process.env, [key]: current === '' ? dir : `${dir}${path.delimiter}${current}` };
  }
}
