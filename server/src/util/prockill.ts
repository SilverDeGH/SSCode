import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * 终止命令的子进程树。Windows 上 shell:true 的 child 只是 cmd.exe，
 * 真正的命令是其孙进程，kill 只杀 shell 会留下孤儿，需 taskkill /T /F。
 */
export function killProcessTree(proc: ChildProcess): void {
  if (proc.pid === undefined || proc.pid === 0) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => {
      // 失败时回退单进程 kill
      try {
        proc.kill();
      } catch {
        // 已退出
      }
    });
    return;
  }
  try {
    proc.kill('SIGTERM');
  } catch {
    // 已退出
  }
}
