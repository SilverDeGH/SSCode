const TEXT_PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_\-]{8,}\b/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=\-]+/gi, '$1 ***'],
  [/\b(api[_-]?key|password|passwd|secret|token)(\s*[=:]\s*)[^\s&'"]+/gi, '$1$2***'],
];

/** 脱敏字符串中的常见凭据模式 */
export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of TEXT_PATTERNS) {
    out = out.replace(re, rep);
  }
  return out;
}

const SENSITIVE_KEY_RE = /password|token|secret|key|authorization/i;

function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v !== null && typeof v === 'object') {
    return redactArgs(v as Record<string, unknown>);
  }
  return v;
}

/** 深拷贝对象：敏感 key 的值替换为 ***，字符串值过 redactText */
export function redactArgs(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? '***' : redactValue(v);
  }
  return out;
}
