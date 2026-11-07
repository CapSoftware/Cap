// Shared by the tracker plugins: run a CLI (bd, gh) with stdin, an abort signal and a timeout.
//
// The timeout is our own timer rather than spawn's `timeout` option: on Node 22 a spawn that
// fails (the CLI is not installed) never clears that option's timer, so a caller that has
// already answered would linger until it fires.
import { spawn } from 'node:child_process';

const KILL_GRACE_MS = 2000;

export function run(cmd, args, { cwd, input, signal, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let killTimer;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    let child;
    try { child = spawn(cmd, args, { cwd, signal, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { reject(e); return; }
    let out = '', err = '';
    let timedOut = false;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref();
        settle(reject, Object.assign(new Error(`${cmd} timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT', stderr: err, stdout: out }));
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => settle(reject, e.code === 'ENOENT' ? Object.assign(new Error(`${cmd} is not installed (not on PATH)`), { code: 'ENOENT' }) : e));
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (timedOut) return;
      if (code === 0) settle(resolve, { stdout: out, stderr: err });
      else settle(reject, Object.assign(new Error((err || out).trim().split('\n').slice(-3).join(' ') || `${cmd} exited ${code}`), { code, stderr: err, stdout: out }));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
