// Optional deterministic HTTP model fixture. This tests the real task engine and
// Windows tools; it is NOT a real-model capability/credential acceptance test.
// Run with node scripts/windows-acceptance-provider.mjs; use printed modelId in
// WindowsAcceptanceTest#aiSurvivesDisconnect with -e providerKind scripted.
// Ctrl+C removes only the model configuration created by this process.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const token = fs.readFileSync(path.join(os.homedir(), '.sscode', 'auth-token'), 'utf8').trim();
const api = async (route, method = 'GET', body) => {
  const res = await fetch(`http://127.0.0.1:7823/v1${route}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Acceptance API status ${res.status}`);
  return res.json();
};
const server = http.createServer(async (req, res) => {
  try {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages.find(m => m.role === 'user')?.content ?? '';
    const filename = /create (ai-[a-f0-9]+\.txt)/.exec(prompt)?.[1];
    const content = /content (WINDOWS_AI_OK_[a-f0-9]+ 中文)/.exec(prompt)?.[1];
    if (!filename || !content) { res.writeHead(400).end('Unsupported acceptance prompt'); return; }
    const count = body.messages.filter(m => m.role === 'tool').length;
    const steps = [
      ['write_file', { path: filename, content }],
      ['read_file', { path: filename }],
      ['run_command', { command: `type ${filename}` }],
      ['finish', { summary: 'Scripted provider: Windows tools completed; not a real model test.' }],
    ];
    const [name, args] = steps[Math.min(count, steps.length - 1)];
    // Ensure the first actual tool executes while the Android SSH client is offline.
    if (count === 0) await new Promise(resolve => setTimeout(resolve, 3000));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
      id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) },
    }] } }] }));
  } catch { res.writeHead(500).end('Acceptance fixture error'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const model = await api('/models', 'POST', {
  name: 'Windows acceptance scripted fixture (not a real model)',
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  model: 'windows-acceptance-scripted', apiKey: 'synthetic-test-key', isDefault: false,
});
console.log(`SCRIPTED_PROVIDER_MODEL_ID=${model.id}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await api(`/models/${model.id}`, 'DELETE'); } finally { server.close(); }
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
