import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { Repo } from '../src/db/repo.ts';
import { SecretsStore } from '../src/ai/secrets.ts';
import { createApiServer } from '../src/api/server.ts';
import type { ApiDeps } from '../src/api/server.ts';
import { MODEL_PRESETS } from '../src/ai/presets.ts';
import type { EngineFacade } from '../src/types.ts';

const TOKEN = 'modelkey-test-token';

const engineStub = {} as EngineFacade;

let dataDir: string;
let secrets: SecretsStore;
let repo: Repo;
let base: string;
let close: () => Promise<void>;

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-modelkey-'));
  secrets = new SecretsStore(dataDir);
  const db = openDatabase(':memory:');
  migrate(db);
  repo = new Repo(db);
  const deps: ApiDeps = {
    repo,
    engine: engineStub,
    authToken: TOKEN,
    testModel: async () => ({ ok: true, detail: 'stub' }),
    setModelKey: (ref, key) => secrets.set(ref, key),
    deleteModelKey: ref => {
      secrets.delete(ref);
    },
    version: 'test',
  };
  const server = createApiServer(deps);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
});

after(async () => {
  await close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('创建模型配置时写入 apiKey：存受保护存储，响应不含明文', async () => {
  const res = await api('POST', '/v1/models', {
    name: 'test', baseUrl: 'https://example.com/v1', model: 'm1', apiKey: 'sk-secret-123',
  });
  assert.equal(res.status, 201);
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes('sk-secret-123'), '响应不得包含 Key 明文');
  const ref = res.body.apiKeyRef as string;
  assert.ok(ref.startsWith('key-'));
  assert.equal(secrets.get(ref), 'sk-secret-123');
});

test('POST /v1/models/:id/key 更新 Key；DELETE 配置时删除对应 Key', async () => {
  const created = await api('POST', '/v1/models', {
    name: 't2', baseUrl: 'https://example.com/v1', model: 'm1', apiKey: 'sk-old',
  });
  const id = created.body.id as string;
  const ref = created.body.apiKeyRef as string;

  const upd = await api('POST', `/v1/models/${id}/key`, { apiKey: 'sk-new' });
  assert.equal(upd.status, 200);
  assert.equal(secrets.get(ref), 'sk-new');
  assert.ok(!JSON.stringify(upd.body).includes('sk-new'), '响应不得包含 Key 明文');

  const del = await api('DELETE', `/v1/models/${id}`);
  assert.equal(del.status, 200);
  assert.equal(secrets.get(ref), null, '删除配置后 Key 应一并删除');
});

test('GET /v1/models/presets 返回服务商预设，含 Base URL 配对指引', async () => {
  const res = await api('GET', '/v1/models/presets');
  assert.equal(res.status, 200);
  const presets = res.body.presets as { id: string; baseUrl: string; guide: string }[];
  assert.equal(presets.length, MODEL_PRESETS.length);
  const ids = presets.map(p => p.id);
  for (const required of ['kimi-cn', 'kimi-global', 'bailian', 'bailian-coding-plan', 'bailian-token-plan', 'custom']) {
    assert.ok(ids.includes(required), `缺少预设 ${required}`);
  }
  const bailian = presets.find(p => p.id === 'bailian');
  assert.ok(bailian?.guide.includes('sk-sp-'), '百炼通用预设必须提示 sk-sp- 隔离规则');
});

test('兼容旧用法：仅给 apiKeyRef 仍可创建', async () => {
  secrets.set('manual-ref', 'sk-manual');
  const res = await api('POST', '/v1/models', {
    name: 't3', baseUrl: 'https://example.com/v1', model: 'm1', apiKeyRef: 'manual-ref',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.apiKeyRef, 'manual-ref');
});
