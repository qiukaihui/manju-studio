import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../lib/command-runner.mjs';

test('a long batch is not killed at the former one-hour deadline', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'command-runner-'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await writeFile(path.join(dir, 'worker.cjs'), "console.log('ready');setTimeout(()=>console.log('done'),150)");
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const running = runCommand({ cmd: 'worker.cjs', args: [], cwd: dir, onEvent: (e) => { if (e.line === 'ready') ready(); } });
    await started;
    t.mock.timers.tick(3600001);
    const result = await running;
    assert.equal(result.code, 0);
    assert.equal(result.cancelled, false);
    assert.equal(result.timedOut, false);
  } finally { t.mock.timers.reset(); await rm(dir, { recursive: true, force: true }); }
});

test('an explicit deadline is a timeout, not user cancellation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'command-runner-'));
  try {
    await writeFile(path.join(dir, 'worker.cjs'), 'setInterval(()=>{},1000)');
    const result = await runCommand({ cmd: 'worker.cjs', args: [], cwd: dir, timeoutMs: 50 });
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.code, -1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('user cancellation stops the worker and stays distinct from timeout', async () => {
  const controller = new AbortController();
  const result = runCommand({ cmd: '-e', args: ['setInterval(()=>{},1000)'], cwd: os.tmpdir(), signal: controller.signal });
  controller.abort();
  const stopped = await result;
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.timedOut, false);
});
