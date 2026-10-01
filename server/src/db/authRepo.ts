import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthSession, Device, ProjectMember, ProjectRole } from '../types.ts';

// ---------------------------------------------------------------- 行映射

interface DeviceRow {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

interface AuthSessionRow {
  id: string;
  device_id: string;
  refresh_token_hash: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

interface ProjectMemberRow {
  project_id: string;
  device_id: string;
  role: string;
  created_at: number;
}

function mapDevice(r: DeviceRow): Device {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
  };
}

function mapAuthSession(r: AuthSessionRow): AuthSession {
  return {
    id: r.id,
    deviceId: r.device_id,
    refreshTokenHash: r.refresh_token_hash,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
  };
}

function mapProjectMember(r: ProjectMemberRow): ProjectMember {
  return {
    projectId: r.project_id,
    deviceId: r.device_id,
    role: r.role as ProjectRole,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------- devices

export class DevicesRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(name: string): Device {
    const now = Date.now();
    const device: Device = { id: randomUUID(), name, createdAt: now, lastSeenAt: now, revokedAt: null };
    this.#db
      .prepare('INSERT INTO devices (id, name, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, NULL)')
      .run(device.id, device.name, device.createdAt, device.lastSeenAt);
    return device;
  }

  getById(id: string): Device | null {
    const row = this.#db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
    return row ? mapDevice(row) : null;
  }

  list(): Device[] {
    const rows = this.#db
      .prepare('SELECT * FROM devices ORDER BY created_at ASC, id ASC')
      .all() as unknown as DeviceRow[];
    return rows.map(mapDevice);
  }

  touch(id: string, at: number): void {
    this.#db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  revoke(id: string, at: number): void {
    this.#db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id);
  }
}

// ---------------------------------------------------------------- auth sessions

export interface CreateAuthSessionInput {
  deviceId: string;
  refreshTokenHash: string;
  expiresAt: number;
}

export class AuthSessionsRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(input: CreateAuthSessionInput): AuthSession {
    const now = Date.now();
    const session: AuthSession = {
      id: randomUUID(),
      deviceId: input.deviceId,
      refreshTokenHash: input.refreshTokenHash,
      createdAt: now,
      expiresAt: input.expiresAt,
      lastSeenAt: now,
      revokedAt: null,
    };
    this.#db
      .prepare(
        'INSERT INTO auth_sessions (id, device_id, refresh_token_hash, created_at, expires_at, last_seen_at, revoked_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(
        session.id,
        session.deviceId,
        session.refreshTokenHash,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
      );
    return session;
  }

  getById(id: string): AuthSession | null {
    const row = this.#db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as
      | AuthSessionRow
      | undefined;
    return row ? mapAuthSession(row) : null;
  }

  getByRefreshTokenHash(hash: string): AuthSession | null {
    const row = this.#db
      .prepare('SELECT * FROM auth_sessions WHERE refresh_token_hash = ?')
      .get(hash) as AuthSessionRow | undefined;
    return row ? mapAuthSession(row) : null;
  }

  /** 轮换 refresh token：新哈希立即生效，旧哈希随之失效 */
  rotate(id: string, refreshTokenHash: string, expiresAt: number, at: number): AuthSession | null {
    const res = this.#db
      .prepare(
        'UPDATE auth_sessions SET refresh_token_hash = ?, expires_at = ?, last_seen_at = ? ' +
          'WHERE id = ? AND revoked_at IS NULL',
      )
      .run(refreshTokenHash, expiresAt, at, id);
    if (Number(res.changes) === 0) return null;
    return this.getById(id);
  }

  touch(id: string, at: number): void {
    this.#db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  revoke(id: string, at: number): void {
    this.#db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id);
  }

  revokeByDevice(deviceId: string, at: number): void {
    this.#db
      .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
      .run(at, deviceId);
  }

  listByDevice(deviceId: string): AuthSession[] {
    const rows = this.#db
      .prepare('SELECT * FROM auth_sessions WHERE device_id = ? ORDER BY created_at ASC, id ASC')
      .all(deviceId) as unknown as AuthSessionRow[];
    return rows.map(mapAuthSession);
  }
}

// ---------------------------------------------------------------- project members

export class ProjectMembersRepo {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  setRole(projectId: string, deviceId: string, role: ProjectRole): ProjectMember {
    this.#db
      .prepare(
        'INSERT INTO project_members (project_id, device_id, role, created_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(project_id, device_id) DO UPDATE SET role = excluded.role',
      )
      .run(projectId, deviceId, role, Date.now());
    const member = this.get(projectId, deviceId);
    if (member === null) throw new Error(`project member vanished after upsert: ${projectId}/${deviceId}`);
    return member;
  }

  get(projectId: string, deviceId: string): ProjectMember | null {
    const row = this.#db
      .prepare('SELECT * FROM project_members WHERE project_id = ? AND device_id = ?')
      .get(projectId, deviceId) as ProjectMemberRow | undefined;
    return row ? mapProjectMember(row) : null;
  }

  roleOf(projectId: string, deviceId: string): ProjectRole | null {
    const row = this.#db
      .prepare('SELECT role FROM project_members WHERE project_id = ? AND device_id = ?')
      .get(projectId, deviceId) as { role: string } | undefined;
    return row ? (row.role as ProjectRole) : null;
  }

  listByProject(projectId: string): ProjectMember[] {
    const rows = this.#db
      .prepare('SELECT * FROM project_members WHERE project_id = ? ORDER BY created_at ASC, device_id ASC')
      .all(projectId) as unknown as ProjectMemberRow[];
    return rows.map(mapProjectMember);
  }

  listByDevice(deviceId: string): ProjectMember[] {
    const rows = this.#db
      .prepare('SELECT * FROM project_members WHERE device_id = ? ORDER BY created_at ASC, project_id ASC')
      .all(deviceId) as unknown as ProjectMemberRow[];
    return rows.map(mapProjectMember);
  }

  remove(projectId: string, deviceId: string): boolean {
    const res = this.#db
      .prepare('DELETE FROM project_members WHERE project_id = ? AND device_id = ?')
      .run(projectId, deviceId);
    return Number(res.changes) > 0;
  }
}
