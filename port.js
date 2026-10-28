import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 3000;
export const PORT_ENV = 'SM_PORT';
export const PORT_FILE = 'port.txt';

// 端口配置文件与 auth.json 放在同一个用户数据目录，升级安装不会丢失。
export function portConfigPath() {
  if (process.env.SYSTEM_MONITOR_DATA_DIR) {
    return join(process.env.SYSTEM_MONITOR_DATA_DIR, PORT_FILE);
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'SystemMonitor', PORT_FILE);
  }
  return join(homedir(), '.system-monitor', PORT_FILE);
}

function parsePort(raw, source) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.warn(`Ignoring invalid port "${text}" from ${source}.`);
    return null;
  }
  return port;
}

// 解析优先级：命令行 --port > 环境变量 SM_PORT > port.txt > 默认 3000
export function resolvePort(argv = process.argv) {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    let raw = null;
    if (arg.startsWith('--port=')) raw = arg.slice('--port='.length);
    else if (arg === '--port') raw = args[i + 1];
    if (raw === null || raw === undefined) continue;
    const port = parsePort(raw, '--port');
    if (port) return { port, source: '--port' };
  }

  const fromEnv = parsePort(process.env[PORT_ENV], PORT_ENV);
  if (fromEnv) return { port: fromEnv, source: PORT_ENV };

  const path = portConfigPath();
  try {
    const firstLine = readFileSync(path, 'utf8').split(/\r?\n/)[0];
    const fromFile = parsePort(firstLine, path);
    if (fromFile) return { port: fromFile, source: path };
  } catch {
    // 文件不存在或不可读时按默认端口运行。
  }

  return { port: DEFAULT_PORT, source: 'default' };
}

export function savePort(port) {
  const path = portConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${port}\n`, 'utf8');
  return path;
}

export function clearPort() {
  try {
    rmSync(portConfigPath(), { force: true });
  } catch {
    // 文件被占用或不存在时忽略，下次启动会退回默认端口。
  }
}

// 直接运行本文件时提供简易命令行：node port.js show / set 3500 / clear
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, value] = process.argv.slice(2);
  const current = resolvePort();
  if (command === 'set') {
    const port = parsePort(value, 'command line');
    if (!port) {
      console.error('用法：node port.js set <1-65535>');
      process.exitCode = 1;
    } else {
      console.log(`端口已写入 ${savePort(port)}（下次启动生效）`);
    }
  } else if (command === 'clear') {
    clearPort();
    console.log(`已删除 ${portConfigPath()}，将使用默认端口 ${DEFAULT_PORT}`);
  } else {
    console.log(`当前端口：${current.port}（来源：${current.source}）`);
    console.log(`配置文件：${portConfigPath()}`);
    console.log('用法：node port.js show | set <端口> | clear');
  }
}
