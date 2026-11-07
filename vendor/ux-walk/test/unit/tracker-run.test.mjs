import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/trackers/util.mjs';

const util = fileURLToPath(new URL('../../src/trackers/util.mjs', import.meta.url));

// On Node 22, spawn's own `timeout` option leaves its timer running when the CLI is missing,
// so a process that already answered lingered for the whole timeout. Run in a fresh process
// with the same Node that runs this test (CI and the shipped app use Node 22).
test('a missing CLI does not keep the process alive', () => {
  const script = `
    const { run } = await import(${JSON.stringify(util)});
    await run('ux-walk-test-missing-cli', [], { timeoutMs: 20000 }).then(
      () => console.log('resolved'),
      (e) => console.log(e.code),
    );`;
  const started = Date.now();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'ENOENT');
  assert.ok(Date.now() - started < 10000, `process lingered ${Date.now() - started} ms`);
});

test('a CLI that outlives the timeout is killed and rejected', async () => {
  const started = Date.now();
  await assert.rejects(
    run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 }),
    (e) => e.code === 'ETIMEDOUT',
  );
  assert.ok(Date.now() - started < 5000);
});

test('a timed-out CLI does not keep the process alive', () => {
  const script = `
    const { run } = await import(${JSON.stringify(util)});
    await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 }).catch((e) => console.log(e.code));`;
  const started = Date.now();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'ETIMEDOUT');
  assert.ok(Date.now() - started < 8000, `process lingered ${Date.now() - started} ms`);
});

test('success and failure keep their output', async () => {
  const ok = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello', timeoutMs: 10000 });
  assert.equal(ok.stdout, 'hello');
  await assert.rejects(
    run(process.execPath, ['-e', 'console.error("boom"); process.exit(3)'], { timeoutMs: 10000 }),
    (e) => e.code === 3 && e.message === 'boom',
  );
});
