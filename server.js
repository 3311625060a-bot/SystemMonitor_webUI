import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, freemem, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { classifyGpuAdapters } from './gpu.js';
import { startTray, stopTray } from './tray.js';
import {
  AuthStore,
  defaultDataDir,
  validatePassword,
  SESSION_TTL_REMEMBER_MS,
} from './auth.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = 3000;
const PUBLIC_DIR = join(__dirname, 'public');
const SESSION_COOKIE = 'sm_session';
const AUTH_DATA_DIR = defaultDataDir();

const auth = new AuthStore(AUTH_DATA_DIR);
await auth.load();

// 仅当来源是回环地址或本机网卡地址时才视为“本机”。反向代理/内网穿透场景可设置
// SYSTEM_MONITOR_LOCAL_TRUST=0，让所有请求都必须输入密码。
const TRUST_LOCAL = !['0', 'false', 'off'].includes(String(process.env.SYSTEM_MONITOR_LOCAL_TRUST || '').toLowerCase());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function ps(args) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

const UTF8_PREFIX = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8;';

async function psJson(cmd) {
  const out = await ps(['-Command', `${UTF8_PREFIX} ${cmd}`]);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

let cachedSystemInfo = null;

async function getSystemInfo() {
  if (cachedSystemInfo) return cachedSystemInfo;

  const [cpu, osInfo, mem, gpu, board] = await Promise.all([
    psJson('Get-CimInstance Win32_Processor | Select Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed | ConvertTo-Json -Compress'),
    psJson('Get-CimInstance Win32_OperatingSystem | Select Caption, Version, OSArchitecture, BuildNumber, CSName | ConvertTo-Json -Compress'),
    psJson('Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum | Select Sum | ConvertTo-Json -Compress'),
    psJson('Get-CimInstance Win32_VideoController | Select Name, AdapterRAM, DriverVersion, VideoProcessor | ConvertTo-Json -Compress'),
    psJson('Get-CimInstance Win32_BaseBoard | Select Manufacturer, Product | ConvertTo-Json -Compress'),
  ]);

  const cpuData = Array.isArray(cpu) ? cpu[0] : cpu;
  const osData = Array.isArray(osInfo) ? osInfo[0] : osInfo;
  const gpuArr = Array.isArray(gpu) ? gpu : (gpu ? [gpu] : []);
  const boardData = Array.isArray(board) ? board[0] : board;

  cachedSystemInfo = {
    cpu: {
      brand: cpuData?.Name || 'Unknown',
      physicalCores: cpuData?.NumberOfCores || 0,
      cores: cpuData?.NumberOfLogicalProcessors || 0,
      speedMaxGHz: cpuData?.MaxClockSpeed ? +(cpuData.MaxClockSpeed / 1000).toFixed(2) : 0,
    },
    os: {
      distro: osData?.Caption || 'Windows',
      release: osData?.Version || '',
      arch: osData?.OSArchitecture || '',
      kernel: osData?.BuildNumber || '',
      hostname: osData?.CSName || '',
    },
    memory: {
      totalGB: mem?.Sum ? +(mem.Sum / 1024 ** 3).toFixed(2) : +(totalmem() / 1024 ** 3).toFixed(2),
    },
    baseboard: {
      manufacturer: boardData?.Manufacturer || '',
      model: boardData?.Product || '',
    },
    gpus: gpuArr.map((g) => ({
      model: g.Name || 'Unknown',
      vendor: g.VideoProcessor || '',
      vramMB: g.AdapterRAM ? Math.round(g.AdapterRAM / 1024 / 1024) : 0,
    })),
  };
  return cachedSystemInfo;
}

// ---------- 采样层 ----------
// CPU 用 Node 原生接口做差分采样，内存直接读系统内存信息，两者都不产生子进程。
// 其余指标（网卡/磁盘吞吐、GPU、温度、电池）由一个常驻 PowerShell 进程批量采集，
// 避免每次请求都启动新的 powershell.exe。
const state = {
  cpuUsage: 0,
  cpuTemp: null,
  gpus: [],
  gpuAdapters: [],
  gpuSampleAt: 0,
  lastMetricsAt: 0,
  battery: null,
  netDown: 0,
  netUp: 0,
  diskRead: 0,
  diskWrite: 0,
};

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const core of cpus()) {
    const t = core.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let prevCpu = cpuSnapshot();

setInterval(() => {
  const cur = cpuSnapshot();
  const dTotal = cur.total - prevCpu.total;
  const dIdle = cur.idle - prevCpu.idle;
  if (dTotal > 0) {
    state.cpuUsage = +(Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100))).toFixed(1);
  }
  prevCpu = cur;
}, 1000).unref();

const SAMPLE_INTERVAL_MS = 2000;

const SAMPLER_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  '\\Network Interface(*)\\Bytes Received/sec',
  '\\Network Interface(*)\\Bytes Sent/sec',
  '\\PhysicalDisk(*)\\Disk Read Bytes/sec',
  '\\PhysicalDisk(*)\\Disk Write Bytes/sec'
)
$gpu = @()
$temp = $null
$battery = $null
$i = 0
$parentPid = ${process.pid}
while ($true) {
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
  $netDown = 0.0; $netUp = 0.0; $diskRead = 0.0; $diskWrite = 0.0
  $c = Get-Counter -Counter $paths -ErrorAction SilentlyContinue
  if ($c) {
    foreach ($s in $c.CounterSamples) {
      if ($s.InstanceName -eq '_total' -or $s.InstanceName -like '*loopback*') { continue }
      $p = $s.Path.ToLower()
      if ($p -like '*bytes received/sec') { $netDown += $s.CookedValue }
      elseif ($p -like '*bytes sent/sec') { $netUp += $s.CookedValue }
      elseif ($p -like '*disk read bytes/sec') { $diskRead += $s.CookedValue }
      elseif ($p -like '*disk write bytes/sec') { $diskWrite += $s.CookedValue }
    }
  }

  $out = nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>$null
  if ($out) {
    $gpu = @()
    foreach ($line in $out) {
      if (-not $line) { continue }
      $f = $line -split ',\\s*'
      $gpu += [pscustomobject]@{ name = $f[0]; usage = [int]$f[1]; vramUsed = [int]$f[2]; vramTotal = [int]$f[3]; temp = [int]$f[4] }
    }
  }

  if ($i % 15 -eq 0) {
    $t = Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi | Select-Object -First 1 -ExpandProperty CurrentTemperature
    if ($t) {
      $c2 = [math]::Round(($t - 2732) / 10, 1)
      if ($c2 -gt 0 -and $c2 -lt 150) { $temp = $c2 }
    }
    $b = Get-CimInstance Win32_Battery | Select-Object -First 1
    if ($b -and $null -ne $b.EstimatedChargeRemaining) {
      $battery = [pscustomobject]@{ percent = [int]$b.EstimatedChargeRemaining; acConnected = ($b.BatteryStatus -eq 2) }
    } else {
      $battery = $null
    }
  }

  $obj = [pscustomobject]@{
    netDown = [double]$netDown; netUp = [double]$netUp
    diskRead = [double]$diskRead; diskWrite = [double]$diskWrite
    gpus = $gpu; temp = $temp; battery = $battery
  }
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
  $i++
  Start-Sleep -Milliseconds ${SAMPLE_INTERVAL_MS}
}
`;

const SAMPLER_ARGV = [
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(SAMPLER_SCRIPT, 'utf16le').toString('base64'),
];

let sampler = null;
let samplerRestartTimer = null;
let samplerStopped = false;
let samplerRestarts = 0;

function applySample(line) {
  let s;
  try {
    s = JSON.parse(line);
  } catch {
    return;
  }
  state.netDown = s.netDown || 0;
  state.netUp = s.netUp || 0;
  state.diskRead = s.diskRead || 0;
  state.diskWrite = s.diskWrite || 0;
  if (s.temp != null) state.cpuTemp = s.temp;
  state.battery = s.battery
    ? { percent: s.battery.percent, acConnected: !!s.battery.acConnected }
    : null;

  const list = Array.isArray(s.gpus) ? s.gpus : (s.gpus ? [s.gpus] : []);
  state.gpus = list.map((g) => ({
    model: g.name || 'GPU',
    vendor: 'NVIDIA',
    usagePercent: g.usage != null ? g.usage : null,
    vramUsedMB: g.vramUsed || 0,
    vramTotalMB: g.vramTotal || 0,
    temp: g.temp != null ? g.temp : null,
  }));
}

function startSampler() {
  if (samplerStopped) return;
  sampler = spawn('powershell.exe', SAMPLER_ARGV, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  sampler.stdout.setEncoding('utf8');
  sampler.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) applySample(line);
    }
    if (buf.length > 64 * 1024) buf = '';
  });

  sampler.stderr.on('data', () => {});

  sampler.on('error', () => {
    sampler = null;
    if (!samplerStopped) samplerRestartTimer = setTimeout(startSampler, 5000);
  });

  sampler.on('exit', () => {
    sampler = null;
    if (samplerStopped) return;
    if (samplerRestarts < 3) {
      samplerRestarts += 1;
      console.warn('sampler exited, restarting...');
    }
    samplerRestartTimer = setTimeout(startSampler, 3000);
  });
}

function stopSampler() {
  samplerStopped = true;
  if (samplerRestartTimer) clearTimeout(samplerRestartTimer);
  if (sampler) sampler.kill();
}

// ---------- 全部 GPU 适配器（Windows 性能计数器）----------
// nvidia-smi 只覆盖 NVIDIA 独显；核显（以及 AMD/Intel 独显）的占用率要走 Windows 的
// GPU Engine 计数器。该查询要枚举数百个实例，单次约 0.4~0.9 秒 CPU，
// 所以只在一个独立的后台 PowerShell 里按 3 秒采样，并且只在页面轮询时运行。
const GPU_SAMPLE_INTERVAL_MS = 3000;
const GPU_IDLE_STOP_MS = 20000;

const GPU_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$engineCls = 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine'
$memCls = 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory'
$parentPid = ${process.pid}
while ($true) {
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
  $map = @{}
  foreach ($m in (Get-CimInstance $memCls)) {
    if ($m.Name -notmatch 'luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)') { continue }
    $l = $Matches[1]
    if (-not $map.ContainsKey($l)) {
      $map[$l] = [pscustomobject]@{ luid = $l; dedicatedMB = 0.0; sharedMB = 0.0; usage = 0.0; engines = 0 }
    }
    $map[$l].dedicatedMB = [math]::Round([double]$m.DedicatedUsage / 1MB, 1)
    $map[$l].sharedMB = [math]::Round([double]$m.SharedUsage / 1MB, 1)
  }
  foreach ($e in (Get-CimInstance $engineCls)) {
    if ($e.Name -notmatch 'luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)') { continue }
    $l = $Matches[1]
    if (-not $map.ContainsKey($l)) {
      $map[$l] = [pscustomobject]@{ luid = $l; dedicatedMB = 0.0; sharedMB = 0.0; usage = 0.0; engines = 0 }
    }
    $map[$l].engines = $map[$l].engines + 1
    $v = [double]$e.UtilizationPercentage
    if ($v -gt $map[$l].usage) { $map[$l].usage = [math]::Round($v, 1) }
  }
  $arr = @($map.Values | Sort-Object -Property dedicatedMB -Descending)
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $arr -Compress -Depth 3))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${GPU_SAMPLE_INTERVAL_MS}
}
`;

const GPU_ARGV = [
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(GPU_SCRIPT, 'utf16le').toString('base64'),
];

let gpuProc = null;
let gpuBuf = '';
let gpuIdleTimer = null;
let gpuStopping = false;

function applyGpuSample(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  state.gpuAdapters = list
    .filter((a) => a && typeof a.luid === 'string')
    .map((a) => ({
      luid: a.luid,
      dedicatedMB: Number(a.dedicatedMB) || 0,
      sharedMB: Number(a.sharedMB) || 0,
      usagePercent: a.usage == null ? null : Number(a.usage),
      engines: Number(a.engines) || 0,
    }));
  state.gpuSampleAt = Date.now();
}

function startGpuSampler() {
  if (gpuProc) return;
  gpuStopping = false;
  gpuBuf = '';
  gpuProc = spawn('powershell.exe', GPU_ARGV, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  gpuProc.stdout.setEncoding('utf8');
  gpuProc.stdout.on('data', (chunk) => {
    gpuBuf += chunk;
    let idx;
    while ((idx = gpuBuf.indexOf('\n')) >= 0) {
      const line = gpuBuf.slice(0, idx).trim();
      gpuBuf = gpuBuf.slice(idx + 1);
      if (line) applyGpuSample(line);
    }
    if (gpuBuf.length > 128 * 1024) gpuBuf = '';
  });

  gpuProc.stderr.on('data', () => {});

  gpuProc.on('error', () => {
    gpuProc = null;
  });

  gpuProc.on('exit', () => {
    gpuProc = null;
    if (!gpuStopping && Date.now() - state.lastMetricsAt < GPU_IDLE_STOP_MS) {
      setTimeout(startGpuSampler, 3000).unref();
    }
  });
}

function stopGpuSampler() {
  gpuStopping = true;
  if (gpuIdleTimer) {
    clearTimeout(gpuIdleTimer);
    gpuIdleTimer = null;
  }
  if (gpuProc) gpuProc.kill();
}

function touchGpuSampler() {
  state.lastMetricsAt = Date.now();
  if (!gpuProc) startGpuSampler();
  if (gpuIdleTimer) clearTimeout(gpuIdleTimer);
  gpuIdleTimer = setTimeout(() => {
    gpuIdleTimer = null;
    if (Date.now() - state.lastMetricsAt >= GPU_IDLE_STOP_MS) stopGpuSampler();
  }, GPU_IDLE_STOP_MS + 1000).unref();
}

function buildGpuList() {
  return classifyGpuAdapters(state.gpuAdapters, state.gpus, cachedSystemInfo?.gpus || []);
}

function getMetrics() {
  const total = totalmem();
  const free = freemem();
  const totalGB = +(total / 1024 ** 3).toFixed(2);
  const usedGB = +((total - free) / 1024 ** 3).toFixed(2);

  return {
    timestamp: Date.now(),
    cpu: {
      usagePercent: state.cpuUsage,
      temp: state.cpuTemp,
    },
    memory: {
      usedGB,
      totalGB,
      percent: totalGB > 0 ? +((usedGB / totalGB) * 100).toFixed(1) : 0,
    },
    gpus: buildGpuList(),
    gpuSampledAt: state.gpuSampleAt,
    power: state.battery
      ? { type: 'battery', percent: state.battery.percent, acConnected: state.battery.acConnected }
      : null,
    io: {
      netDownMBs: +(state.netDown / 1024 / 1024).toFixed(2),
      netUpMBs: +(state.netUp / 1024 / 1024).toFixed(2),
      diskReadMBs: +(state.diskRead / 1024 / 1024).toFixed(2),
      diskWriteMBs: +(state.diskWrite / 1024 / 1024).toFixed(2),
    },
  };
}

// ---------- 访问控制 ----------
function canonicalAddress(value) {
  if (!value) return '';
  let addr = String(value).split('%')[0].toLowerCase();
  if (addr.startsWith('::ffff:') && isIP(addr.slice(7)) === 4) addr = addr.slice(7);
  if (isIP(addr) === 6) {
    try {
      return new URL(`http://[${addr}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return addr;
    }
  }
  return addr;
}

let ownAddressCache = { at: 0, set: new Set() };

function ownAddresses() {
  if (Date.now() - ownAddressCache.at < 5000) return ownAddressCache.set;
  const set = new Set();
  for (const entries of Object.values(networkInterfaces())) {
    for (const item of entries || []) {
      const addr = canonicalAddress(item.address);
      if (addr) set.add(addr);
    }
  }
  ownAddressCache = { at: Date.now(), set };
  return set;
}

function isLocalAddress(req) {
  const addr = canonicalAddress(req.socket.remoteAddress);
  if (!addr) return false;
  if (addr === '::1' || addr.startsWith('127.')) return true;
  return ownAddresses().has(addr);
}

// 免密访问受 TRUST_LOCAL 控制；首次设置密码只要求请求来自本机。
// 这样即使为反代场景设置了 SYSTEM_MONITOR_LOCAL_TRUST=0，本机仍能完成首次初始化。
function isLocalRequest(req) {
  return TRUST_LOCAL && isLocalAddress(req);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    let value = part.slice(idx + 1).trim();
    try { value = decodeURIComponent(value); } catch {}
    out[key] = value;
  }
  return out;
}

function sessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
}

function sessionCookie(token, persistent) {
  const maxAge = persistent
    ? `; Max-Age=${Math.floor(SESSION_TTL_REMEMBER_MS / 1000)}`
    : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${maxAge}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error('payload_too_large');
        err.status = 413;
        reject(err);
        return;
      }
      if (!chunks.length) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const err = new Error('invalid_json');
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 60 * 1000;
const loginFailures = new Map();

function loginBlockSeconds(ip) {
  const rec = loginFailures.get(ip);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.blockedUntil > now) return Math.ceil((rec.blockedUntil - now) / 1000);
  if (now - rec.firstAt > LOGIN_WINDOW_MS) loginFailures.delete(ip);
  return 0;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  let rec = loginFailures.get(ip);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) {
    rec = { count: 0, firstAt: now, blockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILURES) {
    rec.blockedUntil = now + LOGIN_BLOCK_MS;
    rec.count = 0;
    rec.firstAt = now;
  }
  loginFailures.set(ip, rec);
  if (loginFailures.size > 500) {
    for (const [key, value] of loginFailures) {
      if (value.blockedUntil < now && now - value.firstAt > LOGIN_WINDOW_MS) {
        loginFailures.delete(key);
      }
    }
  }
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

async function handleAuth(req, res, url) {
  if (url.pathname === '/api/auth/status') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      return true;
    }
    const local = isLocalRequest(req);
    const canSetup = isLocalAddress(req);
    const hasPassword = auth.hasPassword();
    const authenticated = hasPassword
      && (local || !!auth.findSession(sessionToken(req)));
    sendJson(res, 200, {
      local,
      canSetup,
      localTrust: TRUST_LOCAL,
      hasPassword,
      needsSetup: !hasPassword,
      authenticated,
    });
    return true;
  }

  if (url.pathname === '/api/auth/setup') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      return true;
    }
    if (!isLocalAddress(req)) {
      sendJson(res, 403, { error: 'local_only' });
      return true;
    }
    if (auth.hasPassword()) {
      sendJson(res, 409, { error: 'already_configured' });
      return true;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return true;
    }
    if (!validatePassword(body.password)) {
      sendJson(res, 400, { error: 'weak_password' });
      return true;
    }

    await auth.setPassword(body.password);
    const remember = !!body.remember;
    const token = await auth.createSession({ persistent: remember });
    console.log('Access password configured');
    sendJson(res, 201, { ok: true }, { 'Set-Cookie': sessionCookie(token, remember) });
    return true;
  }

  if (url.pathname === '/api/auth/login') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      return true;
    }
    if (!auth.hasPassword()) {
      sendJson(res, 409, { error: 'setup_required' });
      return true;
    }

    const ip = canonicalAddress(req.socket.remoteAddress) || 'unknown';
    const blocked = loginBlockSeconds(ip);
    if (blocked > 0) {
      sendJson(res, 429, { error: 'too_many_attempts', retryAfter: blocked }, {
        'Retry-After': String(blocked),
      });
      return true;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return true;
    }
    if (typeof body.password !== 'string') {
      sendJson(res, 400, { error: 'invalid_request' });
      return true;
    }

    const valid = await auth.verifyPassword(body.password);
    if (!valid) {
      recordLoginFailure(ip);
      sendJson(res, 401, { error: 'invalid_password' });
      return true;
    }

    clearLoginFailures(ip);
    const remember = !!body.remember;
    const token = await auth.createSession({ persistent: remember });
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, remember) });
    return true;
  }

  if (url.pathname === '/api/auth/logout') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      return true;
    }
    await auth.deleteSession(sessionToken(req));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    return true;
  }

  sendJson(res, 404, { error: 'not_found' });
  return true;
}

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/auth/')) {
    return handleAuth(req, res, url);
  }

  if (!auth.hasPassword()) {
    sendJson(res, 403, { error: 'setup_required' });
    return true;
  }
  if (!isLocalRequest(req) && !auth.findSession(sessionToken(req))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (url.pathname === '/api/system-info') {
    const data = await getSystemInfo();
    sendJson(res, 200, data);
    return true;
  }
  if (url.pathname === '/api/metrics') {
    touchGpuSampler();
    sendJson(res, 200, getMetrics());
    return true;
  }
  return false;
}

async function handleStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    return false;
  }
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.includes('\0')) return false;

  // 解析后再校验目录归属，防止 ../ 或编码后的反斜杠越出 public 目录。
  const filePath = resolve(PUBLIC_DIR, '.' + urlPath);
  if (!filePath.startsWith(PUBLIC_DIR + sep)) return false;

  const ext = extname(filePath);
  if (!MIME[ext]) return false;

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Cache-Control': ext === '.js' || ext === '.css' || ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(req.method === 'HEAD' ? undefined : content);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (req.url.startsWith('/api/')) {
      const handled = await handleApi(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }
    const handled = await handleStatic(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

let listenHost = '::';

function onListening() {
  server.removeListener('error', onListenError);
  server.on('error', (err) => console.error('Server error:', err));
  console.log(`System monitor running at http://localhost:${PORT} (listening on ${listenHost === '::' ? '[::]' : listenHost})`);
  console.log(auth.hasPassword()
    ? `Access control: password configured (${TRUST_LOCAL ? 'local access is trusted' : 'local trust disabled'})`
    : 'Access control: waiting for first local password setup');
  startSampler();
  // 启动即预热一次 GPU 采集，页面打开时就能直接看到全部显卡。
  touchGpuSampler();
  startTray(PORT);
  setTimeout(() => {
    getSystemInfo();
  }, 2500).unref();
}

function onListenError(err) {
  if (listenHost === '::' && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
    console.warn(`IPv6 unavailable (${err.code}), falling back to IPv4`);
    listenHost = '0.0.0.0';
    server.once('error', onListenError);
    server.listen(PORT, listenHost, onListening);
    return;
  }
  console.error(`Failed to listen on port ${PORT}: ${err.message}`);
  process.exit(1);
}

server.once('error', onListenError);
server.listen(PORT, listenHost, onListening);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopTray();
    stopSampler();
    stopGpuSampler();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
