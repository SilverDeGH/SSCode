import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAiCompatAdapter } from '../src/ai/openaiCompat.ts';
import { TOOL_SPECS } from '../src/ai/toolspec.ts';

test('GPT-6 Responses preserves encrypted reasoning and call IDs across tool turns', async t => {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/v1/responses');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'completed', output: requests.length === 1 ? [
      { type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: '先读取文件' }] },
      { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'read_file', arguments: '{"path":"a.txt"}' },
    ] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1/responses`;
  const adapter = new OpenAiCompatAdapter({ baseUrl, model: 'gpt-6', apiKey: 'test' });
  const first = await adapter.chat([{ role: 'user', content: '读取中文文件' }], TOOL_SPECS, new AbortController().signal);
  assert.equal(first.reasoningSummary, '先读取文件');
  assert.equal(first.toolCalls[0]?.id, 'call1');
  const second = await adapter.chat([
    { role: 'user', content: '读取中文文件' },
    { role: 'assistant', content: first.text, responseItems: first.responseItems! },
    { role: 'tool', toolCallId: 'call1', content: '中文内容' },
  ], TOOL_SPECS, new AbortController().signal);
  assert.equal(second.text, '完成');
  assert.equal(requests[1].input[1].encrypted_content, 'opaque');
  assert.equal(requests[1].input[3].call_id, 'call1');
  assert.equal(requests[0].store, false);
});

test('explicit Chat Completions endpoint overrides GPT-6 routing and rejects malformed success', async t => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const adapter = new OpenAiCompatAdapter({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1/chat/completions`, model: 'gpt-6', apiKey: 'test' });
  await assert.rejects(adapter.chat([], [], new AbortController().signal), /Missing choices/);
});
