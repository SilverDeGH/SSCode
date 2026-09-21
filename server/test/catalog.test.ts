import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.ts';
import { SecretsStore } from '../src/ai/secrets.ts';

test('catalog uses stored key; selecting creates independent config without mutating original', async () => {
  let authorization = '';
  const provider = http.createServer((req,res) => {
    authorization = req.headers.authorization ?? '';
    assert.equal(req.url, '/v1/models');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }));
  });
  await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  const app = createApp({ dataDir: dir });
  try {
    await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
    const port = (app.server.address() as import('node:net').AddressInfo).port;
    const upstreamPort = (provider.address() as import('node:net').AddressInfo).port;
    const config = app.repo.modelConfigs.create({ name: 'original', model: 'model-a', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKeyRef: 'original-key' });
    const secrets = new SecretsStore(dir);
    secrets.set('original-key', 'synthetic-secret');
    const url = `http://127.0.0.1:${port}/v1/models/${config.id}`;
    const headers = { authorization: `Bearer ${app.authToken}`, 'content-type': 'application/json' };
    assert.equal((await fetch(url + '/catalog')).status, 401);
    const catalog = await fetch(url + '/catalog', { headers });
    assert.deepEqual(await catalog.json(), { models: ['model-a','model-b'] });
    assert.equal(authorization, 'Bearer synthetic-secret');
    const response = await fetch(url + '/variant', { method: 'POST', headers, body: JSON.stringify({ model: 'model-b' }) });
    assert.equal(response.status, 201);
    const text = await response.text();
    assert.ok(!text.includes('synthetic-secret'));
    const chosen = JSON.parse(text);
    assert.equal(chosen.model, 'model-b');
    assert.equal(app.repo.modelConfigs.getById(config.id)?.model, 'model-a');
    assert.notEqual(chosen.apiKeyRef, 'original-key');
    assert.equal(secrets.get(chosen.apiKeyRef), 'synthetic-secret');
    secrets.delete(chosen.apiKeyRef);
    assert.equal(secrets.get('original-key'), 'synthetic-secret');
  } finally {
    await new Promise<void>(r => app.server.close(() => r()));
    await new Promise<void>(r => provider.close(() => r()));
    app.db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
