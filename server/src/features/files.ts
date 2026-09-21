import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ExtraRoute, ExtraRouteCtx, RouteResult } from '../api/server.ts';
import { asObject, httpError, optString, reqString } from '../api/server.ts';
import { ERR } from '../types.ts';
import { isSensitivePath, resolveWithin } from '../util/paths.ts';
import { removePath } from '../util/remove.ts';

const MAX_CONTENT_BYTES = 512 * 1024;

interface FileEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: number;
  sensitive: boolean;
}

function matchExact(...segs: string[]): (parts: string[]) => Record<string, string> | null {
  return (parts) =>
    parts.length === segs.length && segs.every((s, i) => parts[i] === s) ? {} : null;
}

function projectRoot(ctx: ExtraRouteCtx, projectId: string): string {
  const project = ctx.deps.repo.projects.getById(projectId);
  if (project === null) throw httpError(404, ERR.NOT_FOUND, `project not found: ${projectId}`);
  return project.path;
}

function queryProjectId(ctx: ExtraRouteCtx): string {
  const id = ctx.url.searchParams.get('projectId');
  if (id === null || id === '') {
    throw httpError(400, ERR.VALIDATION, 'missing required query: projectId');
  }
  return id;
}

/** resolveWithin 越界错误映射为 400；并返回项目根真实路径供根目录判断 */
function resolveInProject(root: string, rel: string): string {
  try {
    return resolveWithin(root, rel);
  } catch (err) {
    throw httpError(400, ERR.VALIDATION, err instanceof Error ? err.message : String(err));
  }
}

function requireSensitive403(p: string): void {
  if (isSensitivePath(p)) {
    throw httpError(403, 'forbidden', `敏感文件禁止访问: ${p}`);
  }
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function handleList(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const root = projectRoot(ctx, queryProjectId(ctx));
  const rel = ctx.url.searchParams.get('path') ?? '.';
  const abs = resolveInProject(root, rel);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    throw httpError(404, ERR.NOT_FOUND, `directory not found: ${rel}`);
  }
  const entries: FileEntry[] = dirents.map((d) => {
    const full = path.join(abs, d.name);
    let size = 0;
    let mtime = 0;
    try {
      const st = fs.lstatSync(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      // 读取元数据失败（如悬空符号链接）时保留默认值
    }
    const kind: FileEntry['kind'] = d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : 'file';
    return { name: d.name, kind, size, mtime, sensitive: isSensitivePath(full) };
  });
  entries.sort((a, b) => {
    const rank = (e: FileEntry) => (e.kind === 'dir' ? 0 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return { status: 200, body: { path: rel, entries } };
}

async function handleContent(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const root = projectRoot(ctx, queryProjectId(ctx));
  const rel = ctx.url.searchParams.get('path');
  if (rel === null || rel === '') {
    throw httpError(400, ERR.VALIDATION, 'missing required query: path');
  }
  const abs = resolveInProject(root, rel);
  requireSensitive403(abs);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw httpError(404, ERR.NOT_FOUND, `file not found: ${rel}`);
  }
  if (!st.isFile()) throw httpError(400, ERR.VALIDATION, `not a regular file: ${rel}`);
  const buf = fs.readFileSync(abs);
  const probe = buf.subarray(0, Math.min(buf.length, MAX_CONTENT_BYTES));
  if (probe.includes(0)) {
    throw httpError(400, ERR.VALIDATION, `二进制文件不支持文本查看: ${rel}`);
  }
  const truncated = buf.length > MAX_CONTENT_BYTES;
  const content = buf.subarray(0, MAX_CONTENT_BYTES).toString('utf8');
  return {
    status: 200,
    body: { content, hash: sha256(buf), size: buf.length, truncated },
  };
}

async function handleWrite(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const body = asObject(await ctx.readBody());
  const root = projectRoot(ctx, reqString(body, 'projectId'));
  const rel = reqString(body, 'path');
  const content = reqString(body, 'content');
  const baseHash = optString(body, 'baseHash');
  const abs = resolveInProject(root, rel);
  requireSensitive403(abs);
  if (baseHash !== undefined) {
    if (!fs.existsSync(abs)) {
      throw httpError(409, ERR.CONFLICT, `文件不存在，无法按 baseHash 写入: ${rel}`);
    }
    const current = sha256(fs.readFileSync(abs));
    if (current !== baseHash) {
      throw httpError(409, ERR.CONFLICT, `文件已被外部修改（hash 不匹配）: ${rel}`);
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { status: 200, body: { hash: sha256(content) } };
}

async function handleCreate(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const body = asObject(await ctx.readBody());
  const root = projectRoot(ctx, reqString(body, 'projectId'));
  const rel = reqString(body, 'path');
  const kind = reqString(body, 'kind');
  if (kind !== 'file' && kind !== 'dir') {
    throw httpError(400, ERR.VALIDATION, "field 'kind' must be 'file' or 'dir'");
  }
  const abs = resolveInProject(root, rel);
  requireSensitive403(abs);
  if (fs.existsSync(abs)) {
    throw httpError(409, ERR.CONFLICT, `路径已存在: ${rel}`);
  }
  if (kind === 'dir') {
    try {
      fs.mkdirSync(abs);
    } catch {
      throw httpError(404, ERR.NOT_FOUND, `父目录不存在: ${path.dirname(rel)}`);
    }
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '', 'utf8');
  }
  return { status: 201, body: { created: true, path: rel, kind } };
}

async function handleRename(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const body = asObject(await ctx.readBody());
  const root = projectRoot(ctx, reqString(body, 'projectId'));
  const rel = reqString(body, 'path');
  const newName = reqString(body, 'newName');
  if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
    throw httpError(400, ERR.VALIDATION, `非法文件名: ${newName}`);
  }
  const abs = resolveInProject(root, rel);
  requireSensitive403(abs);
  if (!fs.existsSync(abs)) throw httpError(404, ERR.NOT_FOUND, `path not found: ${rel}`);
  const dest = path.join(path.dirname(abs), newName);
  requireSensitive403(dest);
  resolveInProject(root, path.relative(fs.realpathSync(root), dest));
  if (fs.existsSync(dest)) {
    throw httpError(409, ERR.CONFLICT, `目标已存在: ${newName}`);
  }
  fs.renameSync(abs, dest);
  return { status: 200, body: { renamed: true, path: rel, newName } };
}

async function handleMove(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const body = asObject(await ctx.readBody());
  const root = projectRoot(ctx, reqString(body, 'projectId'));
  const rel = reqString(body, 'path');
  // The Android directory picker represents the project root as an empty path.
  const destDir = body['destDir'] === '' ? '.' : reqString(body, 'destDir');
  const abs = resolveInProject(root, rel);
  requireSensitive403(abs);
  if (!fs.existsSync(abs)) throw httpError(404, ERR.NOT_FOUND, `path not found: ${rel}`);
  const destDirAbs = resolveInProject(root, destDir);
  if (!fs.existsSync(destDirAbs) || !fs.statSync(destDirAbs).isDirectory()) {
    throw httpError(404, ERR.NOT_FOUND, `目标目录不存在: ${destDir}`);
  }
  const dest = path.join(destDirAbs, path.basename(abs));
  requireSensitive403(dest);
  if (fs.existsSync(dest)) {
    throw httpError(409, ERR.CONFLICT, `目标已存在: ${path.basename(abs)}`);
  }
  fs.renameSync(abs, dest);
  return { status: 200, body: { moved: true, path: rel, destDir } };
}

async function handleDelete(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const body = asObject(await ctx.readBody());
  const root = projectRoot(ctx, reqString(body, 'projectId'));
  const rel = reqString(body, 'path');
  const abs = resolveInProject(root, rel);
  requireSensitive403(abs);
  if (abs === fs.realpathSync(root)) {
    throw httpError(400, ERR.VALIDATION, '禁止删除项目根目录');
  }
  if (!fs.existsSync(abs)) throw httpError(404, ERR.NOT_FOUND, `path not found: ${rel}`);
  removePath(abs, true);
  return { status: 200, body: { deleted: true, path: rel } };
}

export const fileRoutes: ExtraRoute[] = [
  { method: 'GET', match: matchExact('files', 'list'), handle: handleList },
  { method: 'GET', match: matchExact('files', 'content'), handle: handleContent },
  { method: 'POST', match: matchExact('files', 'write'), handle: handleWrite },
  { method: 'POST', match: matchExact('files', 'create'), handle: handleCreate },
  { method: 'POST', match: matchExact('files', 'rename'), handle: handleRename },
  { method: 'POST', match: matchExact('files', 'move'), handle: handleMove },
  { method: 'DELETE', match: matchExact('files'), handle: handleDelete },
];
