import type { Repo } from '../db/repo.ts';
import type { AuthContext, ProjectRole } from '../types.ts';
import { ERR } from '../types.ts';

/** 角色矩阵（计划文档 4.3）：viewer 只读；reviewer 额外可审批；operator 可写；owner 还可管理 */
export const VIEW_ROLES: readonly ProjectRole[] = ['owner', 'operator', 'reviewer', 'viewer'];
export const WRITE_ROLES: readonly ProjectRole[] = ['owner', 'operator'];
export const APPROVE_ROLES: readonly ProjectRole[] = ['owner', 'operator', 'reviewer'];
export const OWNER_ONLY: readonly ProjectRole[] = ['owner'];

export function forbidden(message = 'insufficient project role'): Error {
  const err = new Error(message);
  (err as { code?: string }).code = ERR.FORBIDDEN;
  return err;
}

/** 旧静态 Token 视为本地管理员，迁移窗口内拥有全部权限 */
export function roleOn(repo: Repo, auth: AuthContext, projectId: string): ProjectRole | null {
  if (auth.kind === 'legacy') return 'owner';
  return repo.projectMembers.roleOf(projectId, auth.deviceId);
}

export function requireProjectRole(
  repo: Repo,
  auth: AuthContext,
  projectId: string,
  allowed: readonly ProjectRole[],
): ProjectRole {
  const role = roleOn(repo, auth, projectId);
  if (role === null || !allowed.includes(role)) {
    throw forbidden(`role required: ${allowed.join('|')}`);
  }
  return role;
}

/** 模型 Key、成员等服务器级管理操作：本地管理员或任一项目的 owner */
export function canManageServer(repo: Repo, auth: AuthContext): boolean {
  if (auth.kind === 'legacy') return true;
  return repo.projectMembers.listByDevice(auth.deviceId).some((m) => m.role === 'owner');
}

export function requireManageServer(repo: Repo, auth: AuthContext): void {
  if (!canManageServer(repo, auth)) {
    throw forbidden('owner role required for key/member management');
  }
}

/** 写操作审计：记录设备与角色，绝不记录 API Key 或请求体敏感内容 */
export function audit(
  repo: Repo,
  auth: AuthContext,
  projectId: string | null,
  action: string,
  details: Record<string, unknown> = {},
): void {
  repo.events.append(projectId, null, 'audit', {
    action,
    deviceId: auth.kind === 'session' ? auth.deviceId : null,
    via: auth.kind,
    ...details,
  });
}
