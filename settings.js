import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultDataDir } from './auth.js';

export const SETTINGS_FILE = 'settings.json';

// 默认开启空闲暂停：没有人看页面的时候采集进程整体退出，省电也省 CPU。
// 关掉之后主采样器回到常驻模式（和 1.x 行为一致）。
export const DEFAULT_SETTINGS = {
  samplerIdlePause: true,
};

export function settingsPath(dir = defaultDataDir()) {
  return join(dir, SETTINGS_FILE);
}

// 只认白名单字段：文件被手工编辑过或来自旧版本时，未知字段直接忽略，
// 类型不对的字段退回默认值，不会把服务带崩。
function sanitize(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.samplerIdlePause === 'boolean') out.samplerIdlePause = raw.samplerIdlePause;
  return out;
}

export function loadSettings(dir = defaultDataDir()) {
  try {
    return { ...DEFAULT_SETTINGS, ...sanitize(JSON.parse(readFileSync(settingsPath(dir), 'utf8'))) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next, dir = defaultDataDir()) {
  const path = settingsPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const payload = { ...DEFAULT_SETTINGS, ...sanitize(next) };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
}
