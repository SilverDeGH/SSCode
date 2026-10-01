import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Repo } from '../db/repo.ts';
import type {
  ApiError,
  Approval,
  AuthContext,
  EngineFacade,
  EventRecord,
  ModelConfig,
  Project,
  ProjectRole,
} from '../types.ts';
import { ERR, PROJECT_ROLES } from '../types.ts';
import { MODEL_PRESETS } from '../ai/presets.ts';
import { redactText } from '../util/redact.ts';
import { discoverModels } from '../ai/catalog.ts';
import { AuthService } from './auth.ts';
import { codexPathInProject } from '../codexwatch/codexWatchManager.ts';
import { RateLimiter } from './rateLimit.ts';
import {
  APPROVE_ROLES,
  OWNER_ONLY,
  VIEW_ROLES,
  WRITE_ROLES,
  audit,
  forbidden,
  requireManageServer,
  requireProjectRole,
} from './policy.ts';

export interface ExtraRouteCtx {
  deps: ApiDeps;
  req: http.IncomingMessage;
  url: URL;
  parts: string[];
  params: Record<string, string>;
  readBody: () => Promise<unknown>;
}

export type ExtraRouteHandler = (ctx: ExtraRouteCtx) => Promise<RouteResult>;

export interface ExtraRoute {
  method: string;
  /** 匹配路径段（已去除 /v1 前缀），返回路径参数或 null */
  match: (parts: string[]) => Record<string, string> | null;
  handle: ExtraRouteHandler;
}

/** WebSocket 升级处理：返回 true 表示已接管 socket */
export type UpgradeHandler = (
  req: http.IncomingMessage,
  socket: import('node:net').Socket,
  head: Buffer,
  url: URL,
) => boolean;

export interface RateLimiters {
  link: RateLimiter;
  refresh: RateLimiter;
  authFailures: RateLimiter;
}

export interface ApiDeps {
  repo: Repo;
  engine: EngineFacade;
  authToken: string;
  testModel: (configId: string) => Promise<{ ok: boolean; detail: string }>;
  /** 写入/更新模型 Key（存受保护存储，永不落库或出现在响应中） */
  setModelKey: (ref: string, key: string) => void;
  deleteModelKey: (ref: string) => void;
  getModelKey?: (ref: string) => string | null;
  version: string;
  /** 终端后端类型（host-platform 能力的一部分，App 据此显示限制提示） */
  terminalBackend?: string;
  extraRoutes?: ExtraRoute[];
  /** 本机 Codex Desktop/CLI 任务只读监视（项目维度路由 /v1/projects/:id/codex/...） */
  codexWatch?: import('../codexwatch/codexWatchManager.ts').CodexWatchManager;
  /** 向 Codex 线程继续发消息（POST /v1/projects/:id/codex/tasks/:threadId/messages） */
  codexResume?: import('../codexwatch/codexResumeManager.ts').CodexResumeManager;
  upgradeHandler?: UpgradeHandler;
  /** 设备会话服务；缺省时仅支持旧静态 Token（测试兼容） */
  authService?: AuthService;
  /** 首次绑定时验证未落库的 API Key（计划文档 4.1） */
  testModelKey?: (input: { baseUrl: string; model: string; apiKey: string }) => Promise<{ ok: boolean; detail: string }>;
  rateLimiters?: RateLimiters;
  /** SSE 轮询/心跳间隔（测试可注入缩短；缺省 1s / 15s） */
  sse?: { pollIntervalMs?: number; heartbeatIntervalMs?: number };
}

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1000;
const SSE_POLL_INTERVAL_MS = 1000;
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
const SSE_MAX_CONNECTIONS_PER_DEVICE = 5;

class HttpError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(400, ERR.VALIDATION, 'request body too large');
    }
    chunks.push(buf);
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim(); }
  catch { throw new HttpError(400, ERR.VALIDATION, 'JSON body must be valid UTF-8'); }
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, ERR.VALIDATION, 'invalid JSON body');
  }
}

export function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

export function httpError(status: number, code: string, message: string): HttpError {
  return new HttpError(status, code, message);
}

export function validationError(message: string): HttpError {
  return new HttpError(400, ERR.VALIDATION, message);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, ERR.NOT_FOUND, message);
}

export function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function reqString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw validationError(`missing or invalid field: ${key}`);
  }
  return v;
}

export function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw validationError(`invalid field: ${key}`);
  return v;
}

export function optBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw validationError(`invalid field: ${key}`);
  return v;
}

function mapError(err: unknown): { status: number; body: ApiError } {
  if (err instanceof HttpError) {
    const body: ApiError = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    return { status: err.status, body };
  }
  const code =
    err !== null && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : null;
  const message = err instanceof Error ? err.message : String(err);
  if (code === ERR.UNAUTHORIZED) {
    return { status: 401, body: { error: { code, message: redactText(message) } } };
  }
  if (code === ERR.FORBIDDEN) {
    return { status: 403, body: { error: { code, message: redactText(message) } } };
  }
  if (code === ERR.RATE_LIMITED) {
    return { status: 429, body: { error: { code, message: redactText(message) } } };
  }
  if (code === ERR.NOT_FOUND) {
    return { status: 404, body: { error: { code, message: redactText(message) } } };
  }
  if (code === ERR.INVALID_STATE || code === ERR.CONFLICT) {
    return { status: 409, body: { error: { code, message: redactText(message) } } };
  }
  if (code === ERR.VALIDATION) {
    return { status: 400, body: { error: { code, message: redactText(message) } } };
  }
  return { status: 500, body: { error: { code: ERR.INTERNAL, message: redactText(message) } } };
}

interface RouteResult {
  status: number;
  body: unknown;
}

export type { RouteResult };

function requireAuth(auth: AuthContext | null): AuthContext {
  if (auth === null) {
    throw new HttpError(401, ERR.UNAUTHORIZED, 'authentication required');
  }
  return auth;
}

function ensureProject(deps: ApiDeps, id: string): Project {
  const project = deps.repo.projects.getById(id);
  if (project === null) throw notFound(`project not found: ${id}`);
  return project;
}

/**
 * 审批 JSON 附带发起设备信息（计划文档 6.3：审批卡片展示发起设备）。
 * requesterDeviceId 为 null 表示任务由旧本地管理员 Token 提交或属迁移前数据；
 * 设备行已删除时 requesterDeviceName 为 null（仍返回 id），已撤销设备保留其名字。
 */
function serializeApproval(
  deps: ApiDeps,
  approval: Approval,
): Approval & { requesterDeviceName: string | null } {
  const requesterDeviceName =
    approval.requesterDeviceId !== null
      ? deps.repo.devices.getById(approval.requesterDeviceId)?.name ?? null
      : null;
  return { ...approval, requesterDeviceName };
}

function clientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------- /v1/auth

async function handleLink(deps: ApiDeps, req: http.IncomingMessage): Promise<RouteResult> {
  if (deps.authService === undefined || deps.testModelKey === undefined) {
    throw new HttpError(500, ERR.INTERNAL, 'session auth is not configured');
  }
  if (deps.rateLimiters !== undefined && !deps.rateLimiters.link.check(clientIp(req))) {
    throw new HttpError(429, ERR.RATE_LIMITED, 'too many link attempts; try again later');
  }
  const body = asObject(await readJsonBody(req));
  const deviceName = reqString(body, 'deviceName').trim();
  if (deviceName.length === 0 || deviceName.length > 100) throw validationError('invalid deviceName');
  const name = reqString(body, 'name').trim();
  if (name.length === 0 || name.length > 100) throw validationError('invalid name');
  const baseUrl = reqString(body, 'baseUrl').trim();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw validationError('invalid baseUrl');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw validationError('baseUrl must use http(s)');
  }
  const model = reqString(body, 'model').trim();
  if (model.length === 0 || model.length > 255) throw validationError('invalid model');
  const apiKey = reqString(body, 'apiKey');
  if (apiKey.length < 8 || apiKey.length > 512) throw validationError('invalid apiKey length');

  // 先验证 Key 与工具调用能力，成功后才落库（计划文档 4.1）
  const test = await deps.testModelKey({ baseUrl, model, apiKey });
  if (!test.ok) {
    throw new HttpError(
      400,
      ERR.VALIDATION,
      `model connection test failed: ${redactText(test.detail).slice(0, 300)}`,
    );
  }

  const apiKeyRef = `key-${crypto.randomUUID()}`;
  deps.setModelKey(apiKeyRef, apiKey);
  let config: ModelConfig;
  try {
    config = deps.repo.modelConfigs.create({
      name,
      baseUrl,
      model,
      apiKeyRef,
      isDefault: deps.repo.modelConfigs.getDefault() === null,
    });
  } catch (err) {
    deps.deleteModelKey(apiKeyRef);
    throw err;
  }

  const device = deps.authService.createDevice(deviceName);
  // 首台绑定设备成为所有现有项目的 owner；后续设备默认为 viewer，由 owner 在成员管理中调整
  const firstDevice = deps.repo.devices.list().length === 1;
  const role: ProjectRole = firstDevice ? 'owner' : 'viewer';
  for (const project of deps.repo.projects.list()) {
    deps.repo.projectMembers.setRole(project.id, device.id, role);
  }
  const issued = deps.authService.issueSession(device.id);
  audit(
    deps.repo,
    { kind: 'session', deviceId: device.id, sessionId: issued.session.id },
    null,
    'auth.link',
    { deviceName, modelConfigId: config.id },
  );
  return {
    status: 201,
    body: {
      deviceId: device.id,
      accessToken: issued.accessToken,
      accessTokenExpiresAt: issued.accessTokenExpiresAt,
      refreshToken: issued.refreshToken,
      refreshTokenExpiresAt: issued.session.expiresAt,
      role,
      modelConfig: config,
      projects: deps.repo.projects.list().map((p) => ({ id: p.id, name: p.name, path: p.path })),
    },
  };
}

async function handleRefresh(deps: ApiDeps, req: http.IncomingMessage): Promise<RouteResult> {
  if (deps.authService === undefined) {
    throw new HttpError(500, ERR.INTERNAL, 'session auth is not configured');
  }
  if (deps.rateLimiters !== undefined && !deps.rateLimiters.refresh.check(clientIp(req))) {
    throw new HttpError(429, ERR.RATE_LIMITED, 'too many refresh attempts; try again later');
  }
  const body = asObject(await readJsonBody(req));
  const refreshToken = reqString(body, 'refreshToken');
  const issued = deps.authService.refresh(refreshToken);
  if (issued === null) {
    throw new HttpError(401, ERR.UNAUTHORIZED, 'invalid or expired refresh token');
  }
  return {
    status: 200,
    body: {
      deviceId: issued.session.deviceId,
      accessToken: issued.accessToken,
      accessTokenExpiresAt: issued.accessTokenExpiresAt,
      refreshToken: issued.refreshToken,
      refreshTokenExpiresAt: issued.session.expiresAt,
    },
  };
}

// ---------------------------------------------------------------- 路由

async function route(
  deps: ApiDeps,
  req: http.IncomingMessage,
  url: URL,
  parts: string[],
  auth: AuthContext | null,
): Promise<RouteResult> {
  const method = req.method ?? 'GET';
  const [resource, id, sub] = parts;

  if (resource === 'health' && parts.length === 1 && method === 'GET') {
    return {
      status: 200,
      body: {
        version: deps.version,
        name: 'sscode-server',
        platform: process.platform,
        terminalBackend: deps.terminalBackend ?? null,
        capabilities: ['task-approval-modes', 'task-progress', 'responses', 'host-platform', 'session-auth', 'event-stream'],
      },
    };
  }

  if (resource === 'auth') {
    if (parts.length === 2 && id === 'link' && method === 'POST') return handleLink(deps, req);
    if (parts.length === 2 && id === 'refresh' && method === 'POST') return handleRefresh(deps, req);
    const authed = requireAuth(auth);
    if (parts.length === 2 && id === 'revoke' && method === 'POST') {
      if (authed.kind !== 'session' || deps.authService === undefined) {
        throw validationError('revoke requires a session access token');
      }
      deps.authService.revokeSession(authed.sessionId);
      audit(deps.repo, authed, null, 'auth.revoke');
      return { status: 200, body: { revoked: true } };
    }
    if (parts.length === 2 && id === 'me' && method === 'GET') {
      if (authed.kind === 'legacy') {
        return { status: 200, body: { legacy: true, devices: deps.repo.devices.list() } };
      }
      const device = deps.repo.devices.getById(authed.deviceId);
      if (device === null) throw notFound('device not found');
      const memberships = deps.repo.projectMembers.listByDevice(authed.deviceId).map((m) => ({
        projectId: m.projectId,
        role: m.role,
        projectName: deps.repo.projects.getById(m.projectId)?.name ?? null,
      }));
      return { status: 200, body: { device, sessionId: authed.sessionId, memberships } };
    }
    if (parts.length === 2 && id === 'devices' && method === 'GET') {
      return { status: 200, body: { devices: deps.repo.devices.list() } };
    }
    if (parts.length === 3 && id === 'devices' && sub !== undefined && method === 'DELETE') {
      const target = deps.repo.devices.getById(sub);
      if (target === null) throw notFound(`device not found: ${sub}`);
      const isSelf = authed.kind === 'session' && authed.deviceId === sub;
      if (!isSelf && authed.kind !== 'legacy') {
        throw forbidden('only the local admin token can revoke other devices');
      }
      if (deps.authService === undefined) {
        throw new HttpError(500, ERR.INTERNAL, 'session auth is not configured');
      }
      deps.authService.revokeDevice(sub);
      audit(deps.repo, authed, null, 'auth.device_revoke', { targetDeviceId: sub });
      return { status: 200, body: { revoked: true, id: sub } };
    }
    throw notFound(`route not found: ${method} ${url.pathname}`);
  }

  if (resource === 'projects') {
    const authed = requireAuth(auth);
    if (parts.length === 1 && method === 'POST') {
      const body = asObject(await readJsonBody(req));
      const name = reqString(body, 'name');
      const rawPath = reqString(body, 'path');
      const normalized = path.resolve(rawPath);
      if (deps.repo.projects.getByPath(normalized) !== null) {
        throw new HttpError(409, ERR.CONFLICT, `project already exists for path: ${normalized}`);
      }
      const isGit = fs.existsSync(path.join(normalized, '.git'));
      const project = deps.repo.projects.create({ name, path: normalized, isGit });
      if (authed.kind === 'session') {
        deps.repo.projectMembers.setRole(project.id, authed.deviceId, 'owner');
      }
      audit(deps.repo, authed, project.id, 'project.create', { name: project.name });
      return { status: 201, body: project };
    }
    if (parts.length === 1 && method === 'GET') {
      const all = deps.repo.projects.list();
      const visible: { project: Project; role: ProjectRole }[] =
        authed.kind === 'legacy'
          ? all.map((project) => ({ project, role: 'owner' as ProjectRole }))
          : all.flatMap((project) => {
              const role = deps.repo.projectMembers.roleOf(project.id, authed.deviceId);
              return role === null ? [] : [{ project, role }];
            });
      const projects = visible.map(({ project, role }) => {
        const tasks = deps.repo.tasks.listByProject(project.id);
        return {
          ...project,
          role,
          tasks: {
            running: tasks.filter((t) => t.state === 'running').length,
            queued: tasks.filter((t) => t.state === 'queued').length,
          },
        };
      });
      return { status: 200, body: { projects } };
    }
    if (parts.length >= 2 && id !== undefined) {
      const project = ensureProject(deps, id);
      if (parts.length === 2 && method === 'GET') {
        const role = requireProjectRole(deps.repo, authed, id, VIEW_ROLES);
        const sessionCount = deps.repo.sessions.listByProject(id).length;
        return { status: 200, body: { ...project, sessionCount, role } };
      }
      if (parts.length === 2 && method === 'DELETE') {
        requireProjectRole(deps.repo, authed, id, OWNER_ONLY);
        const activeStates = new Set(['queued', 'running', 'awaiting_input', 'awaiting_approval', 'stopping']);
        const active = deps.repo.tasks.listByProject(id).filter((t) => activeStates.has(t.state));
        if (active.length > 0) {
          throw new HttpError(409, ERR.CONFLICT, `project has ${active.length} active task(s); stop them before deleting`);
        }
        deps.repo.projects.delete(id);
        audit(deps.repo, authed, null, 'project.delete', { projectId: id, name: project.name });
        return { status: 200, body: { deleted: true, id } };
      }
      if (parts.length === 3 && sub === 'sessions') {
        if (method === 'POST') {
          requireProjectRole(deps.repo, authed, id, WRITE_ROLES);
          const body = asObject(await readJsonBody(req));
          const title = reqString(body, 'title');
          const session = deps.repo.sessions.create({ projectId: id, title });
          return { status: 201, body: session };
        }
        if (method === 'GET') {
          requireProjectRole(deps.repo, authed, id, VIEW_ROLES);
          return { status: 200, body: { sessions: deps.repo.sessions.listByProject(id) } };
        }
      }
      if (parts.length === 3 && sub === 'members' && method === 'GET') {
        requireProjectRole(deps.repo, authed, id, VIEW_ROLES);
        const members = deps.repo.projectMembers.listByProject(id).map((m) => ({
          ...m,
          deviceName: deps.repo.devices.getById(m.deviceId)?.name ?? null,
        }));
        return { status: 200, body: { members } };
      }
      if (parts.length === 3 && sub === 'members' && method === 'POST') {
        requireProjectRole(deps.repo, authed, id, OWNER_ONLY);
        const body = asObject(await readJsonBody(req));
        const deviceId = reqString(body, 'deviceId');
        const role = reqString(body, 'role');
        if (!(PROJECT_ROLES as readonly string[]).includes(role)) {
          throw validationError(`role must be one of: ${PROJECT_ROLES.join(', ')}`);
        }
        if (deps.repo.devices.getById(deviceId) === null) {
          throw notFound(`device not found: ${deviceId}`);
        }
        const member = deps.repo.projectMembers.setRole(id, deviceId, role as ProjectRole);
        audit(deps.repo, authed, id, 'project.member_set', { targetDeviceId: deviceId, role });
        return { status: 200, body: member };
      }
      if (parts.length === 4 && sub === 'members' && method === 'DELETE') {
        requireProjectRole(deps.repo, authed, id, OWNER_ONLY);
        const deviceId = parts[3]!;
        const removed = deps.repo.projectMembers.remove(id, deviceId);
        audit(deps.repo, authed, id, 'project.member_remove', { targetDeviceId: deviceId, removed });
        return { status: 200, body: { removed, deviceId } };
      }
      // 本机 Codex Desktop/CLI 任务（只读）：thread.cwd 落在项目路径内（含子目录）才可见
      if (parts.length === 4 && sub === 'codex' && parts[3] === 'tasks' && method === 'GET') {
        requireProjectRole(deps.repo, authed, id, VIEW_ROLES);
        const result = deps.codexWatch !== undefined
          ? await deps.codexWatch.listTasksForProject(project.path)
          : { available: false, tasks: [] };
        return { status: 200, body: result };
      }
      if (parts.length === 5 && sub === 'codex' && parts[3] === 'tasks' && method === 'GET') {
        requireProjectRole(deps.repo, authed, id, VIEW_ROLES);
        const detail = deps.codexWatch !== undefined ? await deps.codexWatch.getTask(parts[4]!) : null;
        if (detail === null || !codexPathInProject(detail.task.cwd, project.path)) {
          throw notFound('codex task not found');
        }
        return {
          status: 200,
          body: { available: true, task: detail.task, messages: detail.messages, queuedTasks: detail.queuedTasks },
        };
      }
      // 向 Codex 线程继续发消息（写通道）：spawn codex exec resume，归属校验与 GET 详情同一规则
      if (parts.length === 6 && sub === 'codex' && parts[3] === 'tasks' && parts[5] === 'messages' && method === 'POST') {
        requireProjectRole(deps.repo, authed, id, WRITE_ROLES);
        const body = asObject(await readJsonBody(req));
        const text = reqString(body, 'text');
        const threadId = parts[4]!;
        const detail = deps.codexWatch !== undefined ? await deps.codexWatch.getTask(threadId) : null;
        if (detail === null || !codexPathInProject(detail.task.cwd, project.path)) {
          throw notFound('codex task not found');
        }
        if (deps.codexResume === undefined) {
          throw new HttpError(503, ERR.INVALID_STATE, 'codex resume is not configured');
        }
        await deps.codexResume.sendMessage(threadId, text, detail.task.cwd);
        audit(deps.repo, authed, id, 'codex.message_send', { threadId });
        return { status: 202, body: { accepted: true, threadId } };
      }
    }
  }

  if (resource === 'tasks') {
    const authed = requireAuth(auth);
    if (parts.length === 1 && method === 'POST') {
      const clientRequestId = req.headers['x-client-request-id'];
      if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) {
        throw validationError('missing required header: X-Client-Request-Id');
      }
      const body = asObject(await readJsonBody(req));
      const projectId = reqString(body, 'projectId');
      const sessionId = reqString(body, 'sessionId');
      ensureProject(deps, projectId);
      requireProjectRole(deps.repo, authed, projectId, WRITE_ROLES);
      // 不允许用客户端提交的 sessionId 跨项目挂靠任务（计划文档 5.2）
      const session = deps.repo.sessions.getById(sessionId);
      if (session === null || session.projectId !== projectId) {
        throw validationError('sessionId does not belong to projectId');
      }
      const scopeKey = `task:${clientRequestId}`;
      const cached = deps.repo.idempotency.get(scopeKey);
      if (cached !== null) {
        const stored = JSON.parse(cached) as Record<string, unknown>;
        return { status: 200, body: { ...stored, deduplicated: true } };
      }
      const input = reqString(body, 'input');
      const modelConfigId = optString(body, 'modelConfigId');
      const approvalMode = optString(body, 'approvalMode') ?? 'manual';
      if (!['manual', 'auto', 'full'].includes(approvalMode)) throw validationError('Invalid approvalMode');
      const result = await deps.engine.submitTask({
        projectId,
        sessionId,
        input,
        clientRequestId,
        approvalMode: approvalMode as import('../types.ts').ApprovalMode,
        requesterDeviceId: authed.kind === 'session' ? authed.deviceId : null,
        ...(modelConfigId !== undefined ? { modelConfigId } : {}),
      });
      deps.repo.idempotency.set(scopeKey, JSON.stringify({ task: result.task }));
      audit(deps.repo, authed, projectId, 'task.submit', { taskId: result.task.id });
      // 并发下第二个请求可能绕过 idempotency 缓存、由引擎内 clientRequestId 去重命中
      return result.deduplicated
        ? { status: 200, body: { task: result.task, deduplicated: true } }
        : { status: 201, body: { task: result.task, deduplicated: false } };
    }
    if (parts.length === 1 && method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      if (projectId === null || projectId === '') {
        throw validationError('missing required query: projectId');
      }
      ensureProject(deps, projectId);
      requireProjectRole(deps.repo, authed, projectId, VIEW_ROLES);
      return { status: 200, body: { tasks: deps.repo.tasks.listByProject(projectId) } };
    }
    if (parts.length >= 2 && id !== undefined) {
      const task = deps.repo.tasks.getById(id);
      if (task === null) throw notFound(`task not found: ${id}`);
      if (parts.length === 2 && method === 'GET') {
        requireProjectRole(deps.repo, authed, task.projectId, VIEW_ROLES);
        return {
          status: 200,
          body: {
            ...task,
            events: deps.repo.events.listByTask(id).filter(e => e.type === 'task.message'),
            toolCalls: deps.repo.toolCalls.listByTask(id),
            pendingApprovals: deps.repo.approvals.pendingByTask(id).map((a) => serializeApproval(deps, a)),
          },
        };
      }
      if (parts.length === 3 && sub === 'changes' && method === 'GET') {
        requireProjectRole(deps.repo, authed, task.projectId, VIEW_ROLES);
        const snapshot = deps.repo.snapshots.getByTask(id);
        const files = snapshot
          ? deps.repo.snapshots
              .listFiles(snapshot.id)
              .map((f) => ({ path: f.path, changeKind: f.changeKind }))
          : [];
        return { status: 200, body: { taskId: id, files } };
      }
      if (parts.length === 3 && method === 'POST') {
        requireProjectRole(deps.repo, authed, task.projectId, WRITE_ROLES);
        if (sub === 'approval-mode') {
          const body = asObject(await readJsonBody(req));
          const mode = reqString(body, 'approvalMode');
          if (!['manual', 'auto', 'full'].includes(mode)) throw validationError('Invalid approvalMode');
          audit(deps.repo, authed, task.projectId, 'task.approval_mode', { taskId: id, mode });
          return { status: 200, body: await deps.engine.setApprovalMode(id, mode as import('../types.ts').ApprovalMode) };
        }
        if (sub === 'messages') {
          const body = asObject(await readJsonBody(req));
          const updated = await deps.engine.appendMessage(id, reqString(body, 'text'));
          return { status: 200, body: updated };
        }
        if (sub === 'answer') {
          const body = asObject(await readJsonBody(req));
          const updated = await deps.engine.answerTask(id, reqString(body, 'text'));
          return { status: 200, body: updated };
        }
        if (sub === 'stop') {
          const stopped = await deps.engine.stopTask(id);
          audit(deps.repo, authed, task.projectId, 'task.stop', { taskId: id });
          return { status: 200, body: stopped };
        }
        if (sub === 'cancel') return { status: 200, body: await deps.engine.cancelQueued(id) };
        if (sub === 'resume') return { status: 200, body: await deps.engine.resumeInterrupted(id) };
        if (sub === 'undo') {
          const report = await deps.engine.undoTask(id);
          audit(deps.repo, authed, task.projectId, 'task.undo', { taskId: id, hasConflict: report.hasConflict });
          return { status: 200, body: report };
        }
      }
    }
  }

  if (resource === 'approvals' && parts.length === 3 && id !== undefined && sub === 'decision') {
    const authed = requireAuth(auth);
    if (method === 'POST') {
      const approval = deps.repo.approvals.getById(id);
      if (approval === null) throw notFound(`approval not found: ${id}`);
      const task = deps.repo.tasks.getById(approval.taskId);
      if (task === null) throw notFound(`task not found: ${approval.taskId}`);
      requireProjectRole(deps.repo, authed, task.projectId, APPROVE_ROLES);
      const body = asObject(await readJsonBody(req));
      const decisionRaw = reqString(body, 'decision');
      if (decisionRaw !== 'approve' && decisionRaw !== 'reject') {
        throw validationError("field 'decision' must be 'approve' or 'reject'");
      }
      const note = optString(body, 'note');
      const decided = await deps.engine.decideApproval(id, decisionRaw, note);
      audit(deps.repo, authed, task.projectId, 'approval.decide', { approvalId: id, decision: decisionRaw });
      return { status: 200, body: serializeApproval(deps, decided) };
    }
  }

  if (resource === 'events' && parts.length === 1 && method === 'GET') {
    const authed = requireAuth(auth);
    const afterRaw = url.searchParams.get('after');
    const after = afterRaw === null ? 0 : Number(afterRaw);
    if (!Number.isInteger(after) || after < 0) {
      throw validationError('query parameter after must be a non-negative integer');
    }
    const limitRaw = url.searchParams.get('limit');
    let limit = DEFAULT_EVENT_LIMIT;
    if (limitRaw !== null) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1) {
        throw validationError('query parameter limit must be a positive integer');
      }
      limit = Math.min(limit, MAX_EVENT_LIMIT);
    }
    const projectId = url.searchParams.get('projectId');
    let events: EventRecord[];
    if (authed.kind === 'legacy') {
      events = deps.repo.events.listAfter(after, projectId, limit);
    } else if (projectId !== null && projectId !== '') {
      ensureProject(deps, projectId);
      requireProjectRole(deps.repo, authed, projectId, VIEW_ROLES);
      events = deps.repo.events.listAfter(after, projectId, limit);
    } else {
      // 未指定项目时只返回授权项目的事件（计划文档 5.2：事件流按项目过滤）
      const memberProjectIds = deps.repo.projectMembers.listByDevice(authed.deviceId).map((m) => m.projectId);
      events = memberProjectIds
        .flatMap((pid) => deps.repo.events.listAfter(after, pid, limit))
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
    }
    const last = events[events.length - 1];
    const cursor = last !== undefined ? last.id : after;
    return { status: 200, body: { events, cursor } };
  }

  if (resource === 'models') {
    const authed = requireAuth(auth);
    if (parts.length === 3 && id !== undefined && (sub === 'catalog' || sub === 'variant')) {
      const config = deps.repo.modelConfigs.getById(id);
      if (!config) throw notFound('model config not found');
      const key = deps.getModelKey?.(config.apiKeyRef);
      if (!key) throw validationError('Saved API key unavailable');
      if (sub === 'catalog' && method === 'GET') {
        try {
          return { status: 200, body: { models: await discoverModels(config.baseUrl, key) } };
        } catch {
          throw new HttpError(502, 'catalog_unavailable', 'Provider model list unavailable; enter a model ID manually');
        }
      }
      if (sub === 'variant' && method === 'POST') {
        requireManageServer(deps.repo, authed);
        const body = asObject(await readJsonBody(req));
        const model = reqString(body, 'model').trim();
        if (!model || model.length > 255) throw validationError('Invalid model ID');
        if (model === config.model) return { status: 200, body: config };
        const ref = `key-${crypto.randomUUID()}`;
        // Independent credential reference preserves other configurations on deletion/key rotation.
        deps.setModelKey(ref, key);
        try {
          return { status: 201, body: deps.repo.modelConfigs.create({ name: model, baseUrl: config.baseUrl, model, apiKeyRef: ref }) };
        } catch (error) { deps.deleteModelKey(ref); throw error; }
      }
    }
    if (parts.length === 1 && method === 'GET') {
      return { status: 200, body: { models: deps.repo.modelConfigs.list() } };
    }
    if (parts.length === 2 && id === 'presets' && method === 'GET') {
      return { status: 200, body: { presets: MODEL_PRESETS } };
    }
    if (parts.length === 1 && method === 'POST') {
      requireManageServer(deps.repo, authed);
      const body = asObject(await readJsonBody(req));
      const apiKey = optString(body, 'apiKey');
      // apiKey 与 apiKeyRef 二选一：给 apiKey 则生成新引用并存入受保护存储
      const apiKeyRef = apiKey !== undefined ? `key-${crypto.randomUUID()}` : reqString(body, 'apiKeyRef');
      const config = deps.repo.modelConfigs.create({
        name: reqString(body, 'name'),
        baseUrl: reqString(body, 'baseUrl'),
        model: reqString(body, 'model'),
        apiKeyRef,
        ...(optBoolean(body, 'isDefault') !== undefined
          ? { isDefault: optBoolean(body, 'isDefault') as boolean }
          : {}),
      });
      if (apiKey !== undefined) deps.setModelKey(apiKeyRef, apiKey);
      audit(deps.repo, authed, null, 'model.create', { modelConfigId: config.id, name: config.name });
      return { status: 201, body: config };
    }
    if (parts.length === 2 && id !== undefined && method === 'DELETE') {
      requireManageServer(deps.repo, authed);
      const config = deps.repo.modelConfigs.getById(id);
      if (config === null) throw notFound(`model config not found: ${id}`);
      deps.repo.modelConfigs.delete(id);
      deps.deleteModelKey(config.apiKeyRef);
      audit(deps.repo, authed, null, 'model.delete', { modelConfigId: id, name: config.name });
      return { status: 200, body: { deleted: true, id } };
    }
    if (parts.length === 3 && id !== undefined && sub === 'key' && method === 'POST') {
      requireManageServer(deps.repo, authed);
      const config = deps.repo.modelConfigs.getById(id);
      if (config === null) throw notFound(`model config not found: ${id}`);
      const body = asObject(await readJsonBody(req));
      deps.setModelKey(config.apiKeyRef, reqString(body, 'apiKey'));
      audit(deps.repo, authed, null, 'model.key_update', { modelConfigId: id });
      return { status: 200, body: { updated: true, id } };
    }
    if (parts.length === 3 && id !== undefined && sub === 'default' && method === 'POST') {
      requireManageServer(deps.repo, authed);
      const config = deps.repo.modelConfigs.setDefault(id);
      return { status: 200, body: config };
    }
    if (parts.length === 3 && id !== undefined && sub === 'test' && method === 'POST') {
      if (deps.repo.modelConfigs.getById(id) === null) {
        throw notFound(`model config not found: ${id}`);
      }
      const result = await deps.testModel(id);
      return { status: 200, body: result };
    }
  }

  if (deps.extraRoutes !== undefined) {
    // 文件/git/终端/IDE 等宿主能力在迁移窗口内仍只开放给本地管理员 Token
    if (auth === null || auth.kind !== 'legacy') {
      throw forbidden('this endpoint requires the local admin token during the migration window');
    }
    for (const r of deps.extraRoutes) {
      if (r.method !== method) continue;
      const params = r.match(parts);
      if (params !== null) {
        return r.handle({
          deps, req, url, parts, params,
          readBody: () => readJsonBody(req),
        });
      }
    }
  }

  throw notFound(`route not found: ${method} ${url.pathname}`);
}

/**
 * GET /v1/events/stream：SSE 实时事件流（P3 实时任务共享）。
 * 先回放游标之后的事件（EventsRepo.listAfter），随后每秒轮询推送新事件；
 * 每 15s 发送 `: heartbeat` 注释防止代理断连。游标 = 事件 id，
 * 可用 ?after= 或 Last-Event-ID 头（断线重连）指定。
 */
function handleEventStream(
  deps: ApiDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  auth: AuthContext,
  connections: Map<string, number>,
): void {
  try {
    const projectIdRaw = url.searchParams.get('projectId');
    const projectId = projectIdRaw === null || projectIdRaw === '' ? null : projectIdRaw;
    const afterRaw = url.searchParams.get('after');
    const lastEventId = req.headers['last-event-id'];
    const cursorRaw =
      afterRaw ?? (typeof lastEventId === 'string' && lastEventId !== '' ? lastEventId : null);
    let cursor = 0;
    if (cursorRaw !== null) {
      cursor = Number(cursorRaw);
      if (!Number.isInteger(cursor) || cursor < 0) {
        throw validationError('cursor (after / Last-Event-ID) must be a non-negative integer');
      }
    }
    // 与 GET /v1/events 一致的项目过滤逻辑
    let projectIds: string[] | null;
    if (auth.kind === 'legacy') {
      if (projectId !== null) ensureProject(deps, projectId);
      projectIds = projectId !== null ? [projectId] : null;
    } else if (projectId !== null) {
      ensureProject(deps, projectId);
      requireProjectRole(deps.repo, auth, projectId, VIEW_ROLES);
      projectIds = [projectId];
    } else {
      projectIds = deps.repo.projectMembers.listByDevice(auth.deviceId).map((m) => m.projectId);
    }

    const connKey = auth.kind === 'session' ? `device:${auth.deviceId}` : 'legacy';
    const openCount = connections.get(connKey) ?? 0;
    if (openCount >= SSE_MAX_CONNECTIONS_PER_DEVICE) {
      throw new HttpError(429, ERR.RATE_LIMITED, 'too many open event streams for this device');
    }
    connections.set(connKey, openCount + 1);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    const fetchNew = (): EventRecord[] => {
      if (projectIds === null) return deps.repo.events.listAfter(cursor, null, MAX_EVENT_LIMIT);
      return projectIds
        .flatMap((pid) => deps.repo.events.listAfter(cursor, pid, MAX_EVENT_LIMIT))
        .sort((a, b) => a.id - b.id)
        .slice(0, MAX_EVENT_LIMIT);
    };
    const send = (event: EventRecord): void => {
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      cursor = event.id;
    };
    for (const event of fetchNew()) send(event);

    const pollIntervalMs = deps.sse?.pollIntervalMs ?? SSE_POLL_INTERVAL_MS;
    const heartbeatIntervalMs = deps.sse?.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
    const poll = setInterval(() => {
      for (const event of fetchNew()) send(event);
    }, pollIntervalMs);
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, heartbeatIntervalMs);
    res.on('close', () => {
      clearInterval(poll);
      clearInterval(heartbeat);
      connections.set(connKey, Math.max(0, (connections.get(connKey) ?? 1) - 1));
    });
  } catch (err) {
    const mapped = mapError(err);
    sendJson(res, mapped.status, mapped.body);
  }
}

function authenticate(deps: ApiDeps, req: http.IncomingMessage): AuthContext | null {
  const header = req.headers.authorization;
  if (header === `Bearer ${deps.authToken}`) return { kind: 'legacy' };
  if (deps.authService !== undefined && typeof header === 'string' && header.startsWith('Bearer ')) {
    return deps.authService.authenticateAccessToken(header.slice('Bearer '.length));
  }
  return null;
}

export function createApiServer(deps: ApiDeps, port?: number): http.Server {
  const rateLimiters: RateLimiters = deps.rateLimiters ?? {
    link: new RateLimiter(5, 10 * 60 * 1000),
    refresh: new RateLimiter(60, 10 * 60 * 1000),
    authFailures: new RateLimiter(30, 10 * 60 * 1000),
  };
  const fullDeps: ApiDeps = { ...deps, rateLimiters };
  const sseConnections = new Map<string, number>();
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter((s) => s.length > 0);
      if (parts[0] === 'v1') parts.shift();
      const isHealth = parts.length === 1 && parts[0] === 'health';
      const isPublicAuth =
        parts.length === 2 &&
        parts[0] === 'auth' &&
        (parts[1] === 'link' || parts[1] === 'refresh') &&
        req.method === 'POST';
      let auth: AuthContext | null = null;
      if (!isHealth && !isPublicAuth) {
        auth = authenticate(fullDeps, req);
        if (auth === null) {
          if (!rateLimiters.authFailures.check(clientIp(req))) {
            sendJson(res, 429, {
              error: { code: ERR.RATE_LIMITED, message: 'too many failed attempts; try again later' },
            });
            return;
          }
          sendJson(res, 401, {
            error: { code: ERR.UNAUTHORIZED, message: 'missing or invalid bearer token' },
          });
          return;
        }
      }
      if (
        req.method === 'GET' &&
        parts.length === 2 &&
        parts[0] === 'events' &&
        parts[1] === 'stream' &&
        auth !== null
      ) {
        handleEventStream(fullDeps, req, res, url, auth, sseConnections);
        return;
      }
      try {
        const result = await route(fullDeps, req, url, parts, auth);
        sendJson(res, result.status, result.body);
      } catch (err) {
        const mapped = mapError(err);
        sendJson(res, mapped.status, mapped.body);
      }
    })();
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const tokenOk =
      req.headers.authorization === `Bearer ${deps.authToken}` ||
      url.searchParams.get('token') === deps.authToken;
    const netSocket = socket as import('node:net').Socket;
    const handled = tokenOk && deps.upgradeHandler !== undefined
      ? deps.upgradeHandler(req, netSocket, head, url)
      : false;
    if (!handled) {
      netSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      netSocket.destroy();
    }
  });
  if (port !== undefined) {
    server.listen(port, '127.0.0.1');
  }
  return server;
}
