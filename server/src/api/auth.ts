import { createHash, randomBytes } from 'node:crypto';
import type { Repo } from '../db/repo.ts';
import type { AuthContext, AuthSession, Device } from '../types.ts';

const AUTH_TOKEN_KEY = 'auth_token';

/** 旧版静态全局 Token（迁移兼容窗口保留，逐步被设备会话取代） */
export function issueAuthToken(repo: Repo): string {
  const existing = repo.kv.get(AUTH_TOKEN_KEY);
  if (existing !== null && existing.length > 0) return existing;
  const token = randomBytes(32).toString('hex');
  repo.kv.set(AUTH_TOKEN_KEY, token);
  return token;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** access token 短期有效（计划文档 4.2：约 15 分钟） */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
/** refresh token 长期有效，只存哈希，支持轮换与撤销 */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface AccessTokenEntry {
  sessionId: string;
  deviceId: string;
  expiresAt: number;
}

export interface IssuedTokens {
  session: AuthSession;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: number;
}

/**
 * 设备会话服务：refresh token 只存 sha256 哈希；access token 为内存中的短期凭据，
 * 每次校验都回查会话与设备撤销状态，保证撤销立即生效。
 */
export class AuthService {
  #repo: Repo;
  /** key = sha256(access token 明文) */
  #accessTokens = new Map<string, AccessTokenEntry>();

  constructor(repo: Repo) {
    this.#repo = repo;
  }

  createDevice(name: string): Device {
    return this.#repo.devices.create(name);
  }

  issueSession(deviceId: string): IssuedTokens {
    const refreshToken = randomBytes(48).toString('base64url');
    const session = this.#repo.authSessions.create({
      deviceId,
      refreshTokenHash: sha256Hex(refreshToken),
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    });
    const access = this.#issueAccessToken(session);
    return { session, refreshToken, ...access };
  }

  /** 轮换 refresh token：旧 token 立即失效（哈希被替换） */
  refresh(refreshToken: string): IssuedTokens | null {
    const now = Date.now();
    const session = this.#repo.authSessions.getByRefreshTokenHash(sha256Hex(refreshToken));
    if (session === null || session.revokedAt !== null || session.expiresAt <= now) return null;
    const device = this.#repo.devices.getById(session.deviceId);
    if (device === null || device.revokedAt !== null) return null;
    const newRefreshToken = randomBytes(48).toString('base64url');
    const rotated = this.#repo.authSessions.rotate(
      session.id,
      sha256Hex(newRefreshToken),
      now + REFRESH_TOKEN_TTL_MS,
      now,
    );
    if (rotated === null) return null;
    const access = this.#issueAccessToken(rotated);
    return { session: rotated, refreshToken: newRefreshToken, ...access };
  }

  /** 校验 access token，返回认证上下文；过期/撤销返回 null */
  authenticateAccessToken(token: string): AuthContext | null {
    const key = sha256Hex(token);
    const entry = this.#accessTokens.get(key);
    if (entry === undefined) return null;
    const now = Date.now();
    if (entry.expiresAt <= now) {
      this.#accessTokens.delete(key);
      return null;
    }
    const session = this.#repo.authSessions.getById(entry.sessionId);
    if (session === null || session.revokedAt !== null || session.expiresAt <= now) return null;
    const device = this.#repo.devices.getById(entry.deviceId);
    if (device === null || device.revokedAt !== null) return null;
    // 低频回写在线时间，避免每请求一次写库
    if (now - session.lastSeenAt > 60_000) {
      this.#repo.authSessions.touch(session.id, now);
      this.#repo.devices.touch(device.id, now);
    }
    return { kind: 'session', deviceId: entry.deviceId, sessionId: entry.sessionId };
  }

  revokeSession(sessionId: string): void {
    const now = Date.now();
    this.#repo.authSessions.revoke(sessionId, now);
    for (const [key, entry] of this.#accessTokens) {
      if (entry.sessionId === sessionId) this.#accessTokens.delete(key);
    }
  }

  revokeDevice(deviceId: string): void {
    const now = Date.now();
    this.#repo.devices.revoke(deviceId, now);
    this.#repo.authSessions.revokeByDevice(deviceId, now);
    for (const [key, entry] of this.#accessTokens) {
      if (entry.deviceId === deviceId) this.#accessTokens.delete(key);
    }
  }

  #issueAccessToken(session: AuthSession): { accessToken: string; accessTokenExpiresAt: number } {
    const accessToken = randomBytes(32).toString('base64url');
    const accessTokenExpiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;
    this.#accessTokens.set(sha256Hex(accessToken), {
      sessionId: session.id,
      deviceId: session.deviceId,
      expiresAt: accessTokenExpiresAt,
    });
    return { accessToken, accessTokenExpiresAt };
  }
}
