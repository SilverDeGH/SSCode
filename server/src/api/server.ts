import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Repo } from '../db/repo.ts';
import type { ApiError, EngineFacade } from '../types.ts';
import { ERR } from '../types.ts';
import { MODEL_PRESETS } from '../ai/presets.ts';
import { redactText } from '../util/redact.ts';
import { discoverModels } from '../ai/catalog.ts';

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
  upgradeHandler?: UpgradeHandler;
}

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1000;

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

async function route(
  deps: ApiDeps,
  req: http.IncomingMessage,
  url: URL,
  parts: string[],
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
        capabilities: ['task-approval-modes', 'task-progress', 'responses', 'host-platform'],
      },
    };
  }

  if (resource === 'projects') {
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
      return { status: 201, body: project };
    }
    if (parts.length === 1 && method === 'GET') {
      const projects = deps.repo.projects.list().map((p) => {
        const tasks = deps.repo.tasks.listByProject(p.id);
        return {
          ...p,
          tasks: {
            running: tasks.filter((t) => t.state === 'running').length,
            queued: tasks.filter((t) => t.state === 'queued').length,
          },
        };
      });
      return { status: 200, body: { projects } };
    }
    if (parts.length === 2 && id !== undefined) {
      const project = deps.repo.projects.getById(id);
      if (project === null) throw notFound(`project not found: ${id}`);
      if (method === 'GET') {
        const sessionCount = deps.repo.sessions.listByProject(id).length;
        return { status: 200, body: { ...project, sessionCount } };
      }
      if (method === 'DELETE') {
        deps.repo.projects.delete(id);
        return { status: 200, body: { deleted: true, id } };
      }
    }
    if (parts.length === 3 && id !== undefined && sub === 'sessions') {
      const project = deps.repo.projects.getById(id);
      if (project === null) throw notFound(`project not found: ${id}`);
      if (method === 'POST') {
        const body = asObject(await readJsonBody(req));
        const title = reqString(body, 'title');
        const session = deps.repo.sessions.create({ projectId: id, title });
        return { status: 201, body: session };
      }
      if (method === 'GET') {
        return { status: 200, body: { sessions: deps.repo.sessions.listByProject(id) } };
      }
    }
  }

  if (resource === 'tasks') {
    if (parts.length === 1 && method === 'POST') {
      const clientRequestId = req.headers['x-client-request-id'];
      if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) {
        throw validationError('missing required header: X-Client-Request-Id');
      }
      const scopeKey = `task:${clientRequestId}`;
      const cached = deps.repo.idempotency.get(scopeKey);
      if (cached !== null) {
        const stored = JSON.parse(cached) as Record<string, unknown>;
        return { status: 200, body: { ...stored, deduplicated: true } };
      }
      const body = asObject(await readJsonBody(req));
      const projectId = reqString(body, 'projectId');
      const sessionId = reqString(body, 'sessionId');
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
        ...(modelConfigId !== undefined ? { modelConfigId } : {}),
      });
      deps.repo.idempotency.set(scopeKey, JSON.stringify({ task: result.task }));
      return { status: 201, body: { task: result.task, deduplicated: false } };
    }
    if (parts.length === 1 && method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      if (projectId === null || projectId === '') {
        throw validationError('missing required query: projectId');
      }
      return { status: 200, body: { tasks: deps.repo.tasks.listByProject(projectId) } };
    }
    if (parts.length >= 2 && id !== undefined) {
      if (parts.length === 2 && method === 'GET') {
        const task = deps.repo.tasks.getById(id);
        if (task === null) throw notFound(`task not found: ${id}`);
        return {
          status: 200,
          body: {
            ...task,
            events: deps.repo.events.listByTask(id).filter(e => e.type === 'task.message'),
            toolCalls: deps.repo.toolCalls.listByTask(id),
            pendingApprovals: deps.repo.approvals.pendingByTask(id),
          },
        };
      }
      if (parts.length === 3 && sub === 'changes' && method === 'GET') {
        const task = deps.repo.tasks.getById(id);
        if (task === null) throw notFound(`task not found: ${id}`);
        const snapshot = deps.repo.snapshots.getByTask(id);
        const files = snapshot
          ? deps.repo.snapshots
              .listFiles(snapshot.id)
              .map((f) => ({ path: f.path, changeKind: f.changeKind }))
          : [];
        return { status: 200, body: { taskId: id, files } };
      }
      if (parts.length === 3 && method === 'POST') {
        if (sub === 'approval-mode') {
          const body = asObject(await readJsonBody(req));
          const mode = reqString(body, 'approvalMode');
          if (!['manual', 'auto', 'full'].includes(mode)) throw validationError('Invalid approvalMode');
          return { status: 200, body: await deps.engine.setApprovalMode(id, mode as import('../types.ts').ApprovalMode) };
        }
        if (sub === 'messages') {
          const body = asObject(await readJsonBody(req));
          const task = await deps.engine.appendMessage(id, reqString(body, 'text'));
          return { status: 200, body: task };
        }
        if (sub === 'answer') {
          const body = asObject(await readJsonBody(req));
          const task = await deps.engine.answerTask(id, reqString(body, 'text'));
          return { status: 200, body: task };
        }
        if (sub === 'stop') return { status: 200, body: await deps.engine.stopTask(id) };
        if (sub === 'cancel') return { status: 200, body: await deps.engine.cancelQueued(id) };
        if (sub === 'resume') return { status: 200, body: await deps.engine.resumeInterrupted(id) };
        if (sub === 'undo') return { status: 200, body: await deps.engine.undoTask(id) };
      }
    }
  }

  if (resource === 'approvals' && parts.length === 3 && id !== undefined && sub === 'decision') {
    if (method === 'POST') {
      const body = asObject(await readJsonBody(req));
      const decisionRaw = reqString(body, 'decision');
      if (decisionRaw !== 'approve' && decisionRaw !== 'reject') {
        throw validationError("field 'decision' must be 'approve' or 'reject'");
      }
      const note = optString(body, 'note');
      const approval = await deps.engine.decideApproval(id, decisionRaw, note);
      return { status: 200, body: approval };
    }
  }

  if (resource === 'events' && parts.length === 1 && method === 'GET') {
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
    const events = deps.repo.events.listAfter(after, projectId, limit);
    const last = events[events.length - 1];
    const cursor = last !== undefined ? last.id : after;
    return { status: 200, body: { events, cursor } };
  }

  if (resource === 'models') {
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
      return { status: 201, body: config };
    }
    if (parts.length === 2 && id !== undefined && method === 'DELETE') {
      const config = deps.repo.modelConfigs.getById(id);
      if (config === null) throw notFound(`model config not found: ${id}`);
      deps.repo.modelConfigs.delete(id);
      deps.deleteModelKey(config.apiKeyRef);
      return { status: 200, body: { deleted: true, id } };
    }
    if (parts.length === 3 && id !== undefined && sub === 'key' && method === 'POST') {
      const config = deps.repo.modelConfigs.getById(id);
      if (config === null) throw notFound(`model config not found: ${id}`);
      const body = asObject(await readJsonBody(req));
      deps.setModelKey(config.apiKeyRef, reqString(body, 'apiKey'));
      return { status: 200, body: { updated: true, id } };
    }
    if (parts.length === 3 && id !== undefined && sub === 'default' && method === 'POST') {
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

export function createApiServer(deps: ApiDeps, port?: number): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter((s) => s.length > 0);
      if (parts[0] === 'v1') parts.shift();
      const isHealth = parts.length === 1 && parts[0] === 'health';
      if (!isHealth) {
        const expected = `Bearer ${deps.authToken}`;
        if (req.headers.authorization !== expected) {
          sendJson(res, 401, {
            error: { code: ERR.UNAUTHORIZED, message: 'missing or invalid bearer token' },
          });
          return;
        }
      }
      try {
        const result = await route(deps, req, url, parts);
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
