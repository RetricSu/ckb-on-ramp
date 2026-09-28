import fs from 'node:fs';
import path from 'node:path';
import type { BootstrapSession } from '@ckb-on-ramp/contracts';

export interface BootstrapSessionStore {
  get(sessionId: string): BootstrapSession | undefined;
  getByChannelId(channelId: string): BootstrapSession | undefined;
  set(sessionId: string, session: BootstrapSession): void;
  delete(sessionId: string): void;
  clear(): void;
  all(): BootstrapSession[];
}

export class MemoryBootstrapSessionStore implements BootstrapSessionStore {
  private readonly sessions = new Map<string, BootstrapSession>();
  private readonly channelIdToSessionId = new Map<string, string>();

  get(sessionId: string): BootstrapSession | undefined {
    return this.sessions.get(sessionId);
  }

  getByChannelId(channelId: string): BootstrapSession | undefined {
    const target = channelId.trim().toLowerCase();
    const sessionId = this.channelIdToSessionId.get(target);
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (s) return s;
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

  set(sessionId: string, session: BootstrapSession): void {
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

  all(): BootstrapSession[] {
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
    try {
      if (!fs.existsSync(this.filePath)) return;
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const list = JSON.parse(content) as BootstrapSession[];
      if (Array.isArray(list)) {
        for (const session of list) {
          if (session && typeof session === 'object' && session.session_id) {
            this.memory.set(session.session_id, session);
          }
        }
      }
    } catch (err) {
      console.warn(`[FileBootstrapSessionStore] Failed to read sessions from ${this.filePath}:`, err);
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify(this.memory.all(), null, 2);
      fs.writeFileSync(this.filePath, data, 'utf-8');
    } catch (err) {
      console.warn(`[FileBootstrapSessionStore] Failed to persist sessions to ${this.filePath}:`, err);
    }
  }

  get(sessionId: string): BootstrapSession | undefined {
    return this.memory.get(sessionId);
  }

  getByChannelId(channelId: string): BootstrapSession | undefined {
    return this.memory.getByChannelId(channelId);
  }

  set(sessionId: string, session: BootstrapSession): void {
    this.memory.set(sessionId, session);
    this.saveToDisk();
  }

  delete(sessionId: string): void {
    this.memory.delete(sessionId);
    this.saveToDisk();
  }

  clear(): void {
    this.memory.clear();
    this.saveToDisk();
  }

  all(): BootstrapSession[] {
    return this.memory.all();
  }
}
