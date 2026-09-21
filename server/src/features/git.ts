import { spawn } from 'node:child_process';
import type { ExtraRoute, ExtraRouteCtx, RouteResult } from '../api/server.ts';
import { asObject, httpError, reqString } from '../api/server.ts';
import { ERR } from '../types.ts';
import { redactText } from '../util/redact.ts';

const GIT_TIMEOUT_MS = 30_000;
const MAX_DIFF_BYTES = 256 * 1024;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(httpError(500, ERR.INTERNAL, `git 命令超时（30s）: git ${args.join(' ')}`));
    }, GIT_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(httpError(500, ERR.INTERNAL, `git 执行失败: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function matchExact(...segs: string[]): (parts: string[]) => Record<string, string> | null {
  return (parts) =>
    parts.length === segs.length && segs.every((s, i) => parts[i] === s) ? {} : null;
}

function queryProjectId(ctx: ExtraRouteCtx): string {
  const id = ctx.url.searchParams.get('projectId');
  if (id === null || id === '') {
    throw httpError(400, ERR.VALIDATION, 'missing required query: projectId');
  }
  return id;
}

async function projectRoot(ctx: ExtraRouteCtx, projectId: string): Promise<string> {
  const project = ctx.deps.repo.projects.getById(projectId);
  if (project === null) throw httpError(404, ERR.NOT_FOUND, `project not found: ${projectId}`);
  const probe = await runGit(project.path, ['rev-parse', '--is-inside-work-tree']);
  if (probe.code !== 0) {
    throw httpError(409, ERR.INVALID_STATE, `目录不是 git 仓库: ${project.path}`);
  }
  return project.path;
}

function failFromStderr(res: GitResult): never {
  const detail = redactText((res.stderr || res.stdout).trim());
  throw httpError(409, ERR.INVALID_STATE, detail === '' ? 'git 命令失败' : detail);
}

interface StatusFile {
  path: string;
  index: string;
  worktree: string;
}

function parseStatusPorcelain(out: string): {
  branch: string | null;
  ahead: number;
  behind: number;
  files: StatusFile[];
} {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: StatusFile[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m !== null) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), index: '?', worktree: '?' });
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const fields = line.split(' ');
      const xy = fields[1] ?? '..';
      const pathStart = line.startsWith('u ') ? 11 : line.startsWith('2 ') ? 10 : 9;
      const rest = fields.slice(pathStart - 1).join(' ');
      const filePath = line.startsWith('2 ') ? (rest.split('\t')[0] ?? rest) : rest;
      files.push({ path: filePath, index: xy[0] ?? '.', worktree: xy[1] ?? '.' });
    }
  }
  return { branch, ahead, behind, files };
}

async function handleStatus(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const id = queryProjectId(ctx);
  const project = ctx.deps.repo.projects.getById(id);
  if (project === null) throw httpError(404, ERR.NOT_FOUND, `project not found: ${id}`);
  const probe = await runGit(project.path, ['rev-parse', '--is-inside-work-tree']);
  if (probe.code !== 0) {
    return { status: 200, body: { ok: true, isRepo: false } };
  }
  const res = await runGit(project.path, ['status', '--porcelain=v2', '--branch']);
  if (res.code !== 0) failFromStderr(res);
  const parsed = parseStatusPorcelain(res.stdout);
  return {
    status: 200,
    body: { ok: true, isRepo: true, ...parsed },
  };
}

async function handleDiff(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const root = await projectRoot(ctx, queryProjectId(ctx));
  const rel = ctx.url.searchParams.get('path');
  const staged = ctx.url.searchParams.get('staged');
  const args = ['diff'];
  if (staged === '1' || staged === 'true') args.push('--cached');
  if (rel !== null && rel !== '') args.push('--', rel);
  const res = await runGit(root, args);
  if (res.code !== 0) failFromStderr(res);
  const buf = Buffer.from(res.stdout, 'utf8');
  const truncated = buf.length > MAX_DIFF_BYTES;
  const diff = buf.subarray(0, MAX_DIFF_BYTES).toString('utf8');
  return { status: 200, body: { ok: true, diff, truncated } };
}

function reqPathList(body: Record<string, unknown>): string[] {
  const v = body['paths'];
  if (!Array.isArray(v) || v.length === 0 || v.some((p) => typeof p !== 'string' || p === '')) {
    throw httpError(400, ERR.VALIDATION, "field 'paths' must be a non-empty string array");
  }
  return v as string[];
}

async function handleStage(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const body = asObject(await ctx.readBody());
  const root = await projectRoot(ctx, reqString(body, 'projectId'));
  const paths = reqPathList(body);
  const res = await runGit(root, ['add', '--', ...paths]);
  if (res.code !== 0) failFromStderr(res);
  return { status: 200, body: { ok: true, staged: paths } };
}

async function handleUnstage(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const body = asObject(await ctx.readBody());
  const root = await projectRoot(ctx, reqString(body, 'projectId'));
  const paths = reqPathList(body);
  let res = await runGit(root, ['restore', '--staged', '--', ...paths]);
  if (res.code !== 0) {
    // 老版本 git 无 restore，退回 reset
    res = await runGit(root, ['reset', '-q', '--', ...paths]);
  }
  if (res.code !== 0) failFromStderr(res);
  return { status: 200, body: { ok: true, unstaged: paths } };
}

async function handleCommit(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const body = asObject(await ctx.readBody());
  const root = await projectRoot(ctx, reqString(body, 'projectId'));
  const message = reqString(body, 'message');
  const res = await runGit(root, ['commit', '-m', message]);
  if (res.code !== 0) {
    const out = res.stderr + res.stdout;
    if (out.includes('Please tell me who you are')) {
      throw httpError(
        400,
        ERR.VALIDATION,
        'git 未配置提交身份，请先在项目内执行: git config user.name / user.email',
      );
    }
    failFromStderr(res);
  }
  return { status: 200, body: { ok: true, output: redactText(res.stdout.trim()) } };
}

const AUTH_FAIL_RE = /Permission denied|Authentication failed|could not read Username/i;
const CONFLICT_RE = /merge conflict|CONFLICT/i;

async function handlePullPush(ctx: ExtraRouteCtx, op: 'pull' | 'push'): Promise<RouteResult> {
  const body = asObject(await ctx.readBody());
  const root = await projectRoot(ctx, reqString(body, 'projectId'));
  const res = await runGit(root, [op]);
  const out = res.stderr + res.stdout;
  if (res.code !== 0) {
    if (AUTH_FAIL_RE.test(out)) {
      throw httpError(
        400,
        'git_auth_failed',
        `git ${op} 认证失败，请在完整 IDE 中配置凭据后重试`,
      );
    }
    if (CONFLICT_RE.test(out)) {
      throw httpError(
        409,
        ERR.CONFLICT,
        `git ${op} 出现合并冲突，请在完整 IDE 中解决冲突: ${redactText(out.trim())}`,
      );
    }
    failFromStderr(res);
  }
  return { status: 200, body: { ok: true, output: redactText(out.trim()) } };
}

async function handleBranch(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const body = asObject(await ctx.readBody());
  const root = await projectRoot(ctx, reqString(body, 'projectId'));
  const name = reqString(body, 'name');
  const res = await runGit(root, ['branch', name]);
  if (res.code !== 0) failFromStderr(res);
  return { status: 200, body: { ok: true, branch: name } };
}

async function handleCheckout(ctx: ExtraRouteCtx): Promise<RouteResult> {
  const body = asObject(await ctx.readBody());
  const root = await projectRoot(ctx, reqString(body, 'projectId'));
  const name = reqString(body, 'name');
  const res = await runGit(root, ['checkout', name]);
  if (res.code !== 0) failFromStderr(res);
  return { status: 200, body: { ok: true, branch: name } };
}

export const gitRoutes: ExtraRoute[] = [
  { method: 'GET', match: matchExact('git', 'status'), handle: handleStatus },
  { method: 'GET', match: matchExact('git', 'diff'), handle: handleDiff },
  { method: 'POST', match: matchExact('git', 'stage'), handle: handleStage },
  { method: 'POST', match: matchExact('git', 'unstage'), handle: handleUnstage },
  { method: 'POST', match: matchExact('git', 'commit'), handle: handleCommit },
  { method: 'POST', match: matchExact('git', 'pull'), handle: (ctx) => handlePullPush(ctx, 'pull') },
  { method: 'POST', match: matchExact('git', 'push'), handle: (ctx) => handlePullPush(ctx, 'push') },
  { method: 'POST', match: matchExact('git', 'branch'), handle: handleBranch },
  { method: 'POST', match: matchExact('git', 'checkout'), handle: handleCheckout },
];
