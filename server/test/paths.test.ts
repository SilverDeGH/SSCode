import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePath, resolveWithin, isSensitivePath, isSensitiveDirSegment } from '../src/util/paths.ts';
import { redactText, redactArgs } from '../src/util/redact.ts';

function makeFixture(): { root: string; proj: string; outside: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-paths-'));
  const proj = path.join(root, 'proj');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'a.ts'), 'export {}\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
  fs.symlinkSync(outside, path.join(proj, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  return { root, proj, outside };
}

test('resolveWithin: 项目内正常路径通过', () => {
  const { proj } = makeFixture();
  const resolved = resolveWithin(proj, 'src/a.ts');
  assert.equal(resolved, fs.realpathSync(path.join(proj, 'src', 'a.ts')));
});

test('resolveWithin: 项目内不存在的嵌套路径通过（按父目录 realpath 拼接）', () => {
  const { proj } = makeFixture();
  const resolved = resolveWithin(proj, 'newdir/deep/file.txt');
  assert.equal(resolved, path.join(fs.realpathSync(proj), 'newdir', 'deep', 'file.txt'));
});

test('resolveWithin: .. 越界被拦截', () => {
  const { proj } = makeFixture();
  assert.throws(() => resolveWithin(proj, '../outside/secret.txt'), /越出项目根目录/);
});

test('resolveWithin: 符号链接逃逸被拦截', () => {
  const { proj } = makeFixture();
  assert.throws(() => resolveWithin(proj, 'link/secret.txt'), /符号链接/);
});

test('resolveWithin: 项目外绝对路径被拦截', () => {
  const { proj, outside } = makeFixture();
  assert.throws(() => resolveWithin(proj, path.join(outside, 'secret.txt')), /越出项目根目录/);
});

test('normalizePath: 去尾部分隔符并解析为绝对路径', () => {
  const { proj } = makeFixture();
  const normalized = normalizePath(proj + path.sep + '.' + path.sep);
  assert.equal(normalized, path.resolve(proj));
  assert.ok(path.isAbsolute(normalizePath('x/y')));
});

test('isSensitivePath: 命中各类敏感规则', () => {
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('config/.env.production'), true);
  assert.equal(isSensitivePath('/home/u/.ssh/config'), true);
  assert.equal(isSensitivePath('repo/.git/HEAD'), true);
  assert.equal(isSensitivePath('keys/id_rsa'), true);
  assert.equal(isSensitivePath('keys/id_ed25519'), true);
  assert.equal(isSensitivePath('certs/server.pem'), true);
  assert.equal(isSensitivePath('certs/server.key'), true);
  assert.equal(isSensitivePath('aws_credentials'), true);
  assert.equal(isSensitivePath('app_secret.json'), true);
  assert.equal(isSensitivePath('refresh_token.txt'), true);
});

test('isSensitivePath: 普通文件不误伤', () => {
  assert.equal(isSensitivePath('keys/id_rsa.pub'), false);
  assert.equal(isSensitivePath('src/index.ts'), false);
  assert.equal(isSensitivePath('README.md'), false);
  assert.equal(isSensitivePath('src/tokenizer.ts'), true); // 文件名含 token，按规则命中
});

test('isSensitiveDirSegment', () => {
  for (const s of ['node_modules', 'vendor', 'dist', 'build', '.git', '__pycache__']) {
    assert.equal(isSensitiveDirSegment(s), true, s);
  }
  assert.equal(isSensitiveDirSegment('src'), false);
  assert.equal(isSensitiveDirSegment('Node_Modules'.toLowerCase()), true);
});

test('redactText: 常见凭据模式替换为 ***', () => {
  assert.equal(redactText('key is sk-abc123def456ghi'), 'key is ***');
  assert.equal(redactText('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer ***');
  assert.equal(redactText('api_key=xyz789&other=1'), 'api_key=***&other=1');
  assert.equal(redactText('password: hunter2'), 'password: ***');
  assert.equal(redactText('aws AKIAIOSFODNN7EXAMPLE ok'), 'aws *** ok');
  assert.equal(redactText('nothing here'), 'nothing here'); // 普通文本不动
});

test('redactArgs: 敏感 key 置 ***，字符串值过 redactText', () => {
  const out = redactArgs({
    password: 'p',
    nested: { accessToken: 't', note: 'use sk-abcdefghij please' },
    list: ['api_key=abc', 42],
    plain: 7,
  });
  assert.deepEqual(out, {
    password: '***',
    nested: { accessToken: '***', note: 'use *** please' },
    list: ['api_key=***', 42],
    plain: 7,
  });
});
