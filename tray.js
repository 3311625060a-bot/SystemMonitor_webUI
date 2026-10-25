import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let trayProc = null;

export function startTray(port) {
  if (process.platform !== 'win32' || process.env.MONITOR_NO_TRAY === '1' || trayProc) return;

  const script = fileURLToPath(new URL('./tray.ps1', import.meta.url));
  try {
    trayProc = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', script,
      '-ServerPid', String(process.pid),
      '-Url', `http://127.0.0.1:${port}`,
    ], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    trayProc = null;
    return;
  }

  console.log(`Tray icon process started (pid ${trayProc.pid})`);
  trayProc.on('error', (err) => {
    console.error('[tray] failed to start:', err.message);
    trayProc = null;
  });
  trayProc.on('exit', (code) => {
    if (code) console.error('[tray] exited with code', code);
    trayProc = null;
  });
  trayProc.unref();
}

export function stopTray() {
  if (!trayProc) return;
  try {
    trayProc.kill();
  } catch {}
  trayProc = null;
}
