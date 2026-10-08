import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BootstrapSession } from '@ckb-on-ramp/contracts';

// Signing authorization belongs to the durable backend record, not FNN channel status.
export interface StoredBootstrapSession extends BootstrapSession {
  funding_request_hash?: string;
  signed_funding_tx?: unknown;
}

export interface BootstrapSessionStore {
  get(sessionId: string): StoredBootstrapSession | undefined;
  getByChannelId(channelId: string): StoredBootstrapSession | undefined;
  set(sessionId: string, session: StoredBootstrapSession): void;
  delete(sessionId: string): void;
  clear(): void;
  all(): StoredBootstrapSession[];
}

export class MemoryBootstrapSessionStore implements BootstrapSessionStore {
  private readonly sessions = new Map<string, StoredBootstrapSession>();
  private readonly channelIdToSessionId = new Map<string, string>();

  get(sessionId: string): StoredBootstrapSession | undefined {
    return this.sessions.get(sessionId);
  }

  getByChannelId(channelId: string): StoredBootstrapSession | undefined {
    const target = channelId.trim().toLowerCase();
    const sessionId = this.channelIdToSessionId.get(target);
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (s?.channel_id?.trim().toLowerCase() === target) return s;
      this.channelIdToSessionId.delete(target);
    }
    for (const session of this.sessions.values()) {
      if (session.channel_id && session.channel_id.toLowerCase() === target) {
        this.channelIdToSessionId.set(target, session.session_id);
        return session;
      }
    }
    return undefined;
  }

  set(sessionId: string, session: StoredBootstrapSession): void {
    this.sessions.set(sessionId, session);
    if (session.channel_id) {
      this.channelIdToSessionId.set(session.channel_id.trim().toLowerCase(), sessionId);
    }
  }

  delete(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.channel_id) {
      this.channelIdToSessionId.delete(session.channel_id.trim().toLowerCase());
    }
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
    this.channelIdToSessionId.clear();
  }

  all(): StoredBootstrapSession[] {
    return Array.from(this.sessions.values());
  }
}

function resolveDefaultStorePath(): string {
  if (process.env.BOOTSTRAP_STORE_PATH) {
    return process.env.BOOTSTRAP_STORE_PATH;
  }
  // Repo root directory check
  const fromCwd = path.resolve(process.cwd(), 'ops');
  if (fs.existsSync(fromCwd)) {
    return path.resolve(process.cwd(), 'ops/data/bootstrap-sessions.json');
  }
  // When running from workspace subfolder (e.g. apps/api)
  const fromParent = path.resolve(process.cwd(), '../../ops');
  if (fs.existsSync(fromParent)) {
    return path.resolve(process.cwd(), '../../ops/data/bootstrap-sessions.json');
  }
  return path.resolve(process.cwd(), 'ops/data/bootstrap-sessions.json');
}

export class FileBootstrapSessionStore implements BootstrapSessionStore {
  private readonly memory = new MemoryBootstrapSessionStore();
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? resolveDefaultStorePath();
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) return;
    const list: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    if (!Array.isArray(list)) throw new Error('Invalid bootstrap session store');
    for (const session of list) {
      if (!session || typeof session !== 'object' || typeof session.session_id !== 'string') {
        throw new Error('Invalid bootstrap session record');
      }
      this.memory.set(session.session_id, session);
    }
  }

  private saveToDisk(sessions: StoredBootstrapSession[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(sessions, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, this.filePath);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }

  get(sessionId: string): StoredBootstrapSession | undefined {
    return this.memory.get(sessionId);
  }

  getByChannelId(channelId: string): StoredBootstrapSession | undefined {
    return this.memory.getByChannelId(channelId);
  }

  set(sessionId: string, session: StoredBootstrapSession): void {
    const sessions = this.memory.all().filter((item) => item.session_id !== sessionId);
    sessions.push(session);
    // Commit disk first: a persistence failure must not grant in-memory authorization.
    this.saveToDisk(sessions);
    this.memory.set(sessionId, session);
  }

  delete(sessionId: string): void {
    this.saveToDisk(this.memory.all().filter((session) => session.session_id !== sessionId));
    this.memory.delete(sessionId);
  }

  clear(): void {
    this.saveToDisk([]);
    this.memory.clear();
  }

  all(): StoredBootstrapSession[] {
    return this.memory.all();
  }
}
