import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removePath } from '../src/util/remove.ts';

test('Unicode file and nested directory deletion survives Windows native rm regression', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-unicode-remove-'));
  try {
    const file = path.join(root, '重命名😀.txt');
    fs.writeFileSync(file, '中文');
    removePath(file);
    assert.equal(fs.existsSync(file), false);
    removePath(file); // missing files retain force semantics
    const nested = path.join(root, '目录', '子目录');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, '中文.txt'), 'keep until recursive delete');
    assert.throws(() => removePath(path.join(root, '目录')));
    assert.equal(fs.existsSync(nested), true);
    removePath(path.join(root, '目录'), true);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { removePath(root, true); }
});

test('Recursive deletion removes junction/link without deleting its external target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-remove-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sscode-remove-target-'));
  try {
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'preserve');
    fs.symlinkSync(outside, path.join(root, '链接'), process.platform === 'win32' ? 'junction' : 'dir');
    removePath(root, true);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'preserve');
  } finally { removePath(root, true); removePath(outside, true); }
});
