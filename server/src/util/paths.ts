import fs from 'node:fs';
import path from 'node:path';

/** 解析为绝对路径并规范化（去尾部分隔符，保留根） */
export function normalizePath(p: string): string {
  const abs = path.resolve(p);
  const root = path.parse(abs).root;
  let out = abs;
  while (out.length > root.length && (out.endsWith('/') || out.endsWith('\\'))) {
    out = out.slice(0, -1);
  }
  return out;
}

/** 存在则 realpath；不存在则向上找最近存在的祖先 realpath 后拼接剩余段 */
function realpathLoose(p: string): string {
  let cur = p;
  const missing: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) throw new Error(`路径不存在且无法定位存在的祖先: ${p}`);
    missing.push(path.basename(cur));
    cur = parent;
  }
  let real = fs.realpathSync(cur);
  for (let i = missing.length - 1; i >= 0; i--) {
    real = path.join(real, missing[i]!);
  }
  return real;
}

function sameOrInside(root: string, p: string): boolean {
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const r = fold(root);
  const t = fold(p);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * 将 rel 解析到 projectRoot 内的真实绝对路径。
 * 越界（含符号链接逃逸）抛出带路径信息的错误。
 */
export function resolveWithin(projectRoot: string, rel: string): string {
  const rootReal = fs.realpathSync(normalizePath(projectRoot));
  const target = normalizePath(path.resolve(rootReal, rel));
  if (!sameOrInside(rootReal, target)) {
    throw new Error(`路径越出项目根目录: ${rel} -> ${target} (root: ${rootReal})`);
  }
  const targetReal = realpathLoose(target);
  if (!sameOrInside(rootReal, targetReal)) {
    throw new Error(`路径经符号链接越出项目根目录: ${rel} -> ${targetReal} (root: ${rootReal})`);
  }
  return targetReal;
}

/** 依赖/构建产物目录段（默认排除范围） */
export function isSensitiveDirSegment(seg: string): boolean {
  const s = seg.toLowerCase();
  return (
    s === 'node_modules' ||
    s === 'vendor' ||
    s === 'dist' ||
    s === 'build' ||
    s === '.git' ||
    s === '__pycache__'
  );
}

/** 命中敏感文件规则返回 true（凭据、密钥、.env、.ssh/.git 内部等） */
export function isSensitivePath(p: string): boolean {
  const segments = p.split(/[\\/]+/).filter(Boolean);
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  for (const seg of segments) {
    const s = seg.toLowerCase();
    if (s === '.ssh' || s === '.git') return true;
  }
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === 'id_rsa' || base === 'id_ed25519') return true;
  if (base.endsWith('.pem') || base.endsWith('.key')) return true;
  if (/credential|secret|token/i.test(base)) return true;
  return false;
}
