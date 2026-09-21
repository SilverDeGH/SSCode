import fs from 'node:fs';
import path from 'node:path';

/** Node 24.9's native Windows rmSync can crash (0xC0000409) on Unicode names.
 * Use unlink/rmdir on Windows and never recurse through symlinks or junctions.
 * Callers remain responsible for project-boundary and permission checks.
 */
export function removePath(target: string, recursive = false): void {
  if (process.platform !== 'win32') {
    fs.rmSync(target, { force: true, recursive });
    return;
  }
  try {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (!recursive) {
        const error = new Error('Cannot remove a directory as a file') as NodeJS.ErrnoException;
        error.code = 'EISDIR';
        throw error;
      }
      for (const name of fs.readdirSync(target)) removePath(path.join(target, name), true);
      fs.rmdirSync(target);
    } else {
      fs.unlinkSync(target);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
