import { randomBytes } from 'node:crypto';
import type { Repo } from '../db/repo.ts';

const AUTH_TOKEN_KEY = 'auth_token';

export function issueAuthToken(repo: Repo): string {
  const existing = repo.kv.get(AUTH_TOKEN_KEY);
  if (existing !== null && existing.length > 0) return existing;
  const token = randomBytes(32).toString('hex');
  repo.kv.set(AUTH_TOKEN_KEY, token);
  return token;
}
