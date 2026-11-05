// Shared by the tracker plugins: run a CLI (bd, gh) with stdin and an abort signal.
import { spawn } from 'node:child_process';

export function run(cmd, args, { cwd, input, signal, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { cwd, signal, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs }); }
    catch (e) { reject(e); return; }
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(e.code === 'ENOENT' ? Object.assign(new Error(`${cmd} is not installed (not on PATH)`), { code: 'ENOENT' }) : e));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(Object.assign(new Error((err || out).trim().split('\n').slice(-3).join(' ') || `${cmd} exited ${code}`), { code, stderr: err, stdout: out }));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
