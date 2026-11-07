import { spawn } from "node:child_process";
// A batch can contain hours of work. Individual generation scripts own per-item deadlines.
export async function runCommand({ cmd, args = [], cwd, onEvent = () => {}, signal, timeoutMs = 0 }) {
  if (signal?.aborted) return { code: -1, cancelled: true, timedOut: false };
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = spawn(process.execPath, [cmd, ...args], { cwd, env: process.env, detached: !win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let cancelled = false, timedOut = false, settled = false, forceTimer;
    const kill = (signalName) => {
      if (!child.pid) return;
      if (win) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          .on('error', () => { try { child.kill(); } catch {} });
      } else { try { process.kill(-child.pid, signalName); } catch { try { child.kill(signalName); } catch {} } }
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      onEvent({ type: 'log', line: `! 命令达到显式超时限制 ${Math.round(timeoutMs / 1000)} 秒` });
      kill('SIGKILL');
    }, timeoutMs) : null;
    const onAbort = () => {
      cancelled = true; kill('SIGTERM');
      forceTimer = setTimeout(() => kill('SIGKILL'), 5000);
    };
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: cancelled || timedOut ? -1 : code, cancelled, timedOut, ...(error ? { error } : {}) });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((line) => onEvent({ type: 'log', line })));
    child.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((line) => onEvent({ type: 'log', line: '! ' + line })));
    child.on('error', (err) => {
      onEvent({ type: 'log', line: `! 子进程启动失败：${err.message}` });
      finish(-1, err.message);
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}
