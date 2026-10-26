import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export const SESSION_TTL_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export function defaultDataDir() {
  if (process.env.SYSTEM_MONITOR_DATA_DIR) {
    return process.env.SYSTEM_MONITOR_DATA_DIR;
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'SystemMonitor');
  }
  return join(homedir(), '.system-monitor');
}

export function validatePassword(password) {
  return typeof password === 'string'
    && password.length >= PASSWORD_MIN
    && password.length <= PASSWORD_MAX;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 访问密码与会话存储。
 * 密码只保存 scrypt 加盐哈希；会话只保存令牌的 SHA-256 摘要。
 * 数据文件默认位于 %LOCALAPPDATA%\SystemMonitor\auth.json。
 */
export class AuthStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, 'auth.json');
    this.data = { version: 1, password: null, sessions: [] };
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const password = parsed.password;
        if (password
          && typeof password.salt === 'string'
          && typeof password.hash === 'string'
          && /^[0-9a-f]+$/i.test(password.salt)
          && /^[0-9a-f]+$/i.test(password.hash)) {
          this.data.password = {
            salt: password.salt,
            hash: password.hash,
            createdAt: Number(password.createdAt) || Date.now(),
          };
        }
        if (Array.isArray(parsed.sessions)) {
          this.data.sessions = parsed.sessions.filter((s) => (
            s
            && typeof s.id === 'string'
            && typeof s.expiresAt === 'number'
            && s.expiresAt > Date.now()
          ));
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('Unable to read auth data:', err.message);
      }
    }
  }

  hasPassword() {
    return !!this.data.password;
  }

  async setPassword(password) {
    if (!validatePassword(password)) {
      throw new Error('invalid_password');
    }
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    this.data.password = {
      salt: salt.toString('hex'),
      hash: Buffer.from(hash).toString('hex'),
      createdAt: Date.now(),
    };
    // 重设密码后，之前设备上的自动登录全部失效。
    this.data.sessions = [];
    await this.save();
  }

  async verifyPassword(password) {
    const record = this.data.password;
    if (!record || typeof password !== 'string') return false;
    try {
      const expected = Buffer.from(record.hash, 'hex');
      const derived = Buffer.from(await scrypt(password, Buffer.from(record.salt, 'hex'), expected.length));
      return expected.length === derived.length && timingSafeEqual(expected, derived);
    } catch {
      return false;
    }
  }

  pruneSessions() {
    const now = Date.now();
    this.data.sessions = this.data.sessions
      .filter((s) => s && typeof s.expiresAt === 'number' && s.expiresAt > now)
      .slice(-MAX_SESSIONS);
  }

  async createSession({ persistent = false } = {}) {
    this.pruneSessions();
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.data.sessions.push({
      id: sha256(token),
      persistent: !!persistent,
      createdAt: now,
      expiresAt: now + (persistent ? SESSION_TTL_REMEMBER_MS : SESSION_TTL_SESSION_MS),
    });
    this.pruneSessions();
    await this.save();
    return token;
  }

  findSession(token) {
    if (!token || typeof token !== 'string') return null;
    const id = sha256(token);
    const now = Date.now();
    return this.data.sessions.find((s) => s.id === id && s.expiresAt > now) || null;
  }

  async deleteSession(token) {
    if (!token || typeof token !== 'string') return;
    const id = sha256(token);
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    if (this.data.sessions.length !== before) await this.save();
  }

  save() {
    const next = this.writeChain.catch(() => {}).then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      this.pruneSessions();
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.filePath);
    });
    // 写链本身吞掉错误，保证一次磁盘故障不会让后续保存永久失效；
    // 调用方仍通过返回值感知本次失败。
    this.writeChain = next.catch((err) => {
      console.error('Failed to save auth data:', err.message);
    });
    return next;
  }
}
