import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readJsonBody } from '../src/api/server.ts';

test('Chinese and emoji JSON survives byte-by-byte HTTP chunks', async () => {
  const bytes = Buffer.from(JSON.stringify({ title: '测试会话 🍎' }));
  const req = Readable.from([...bytes].map(b => Buffer.from([b]))) as IncomingMessage;
  assert.deepEqual(await readJsonBody(req), { title: '测试会话 🍎' });
});

test('invalid UTF-8 is rejected instead of storing replacement characters', async () => {
  const req = Readable.from([Buffer.from([0x22, 0xff, 0x22])]) as IncomingMessage;
  await assert.rejects(readJsonBody(req), /valid UTF-8/);
});
