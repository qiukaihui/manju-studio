import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('full video stage survives seven hours and completes without being cancelled', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'produce-long-batch-'));
  const originalState = process.env.DSH_STATE_DIR;
  const originalDesktop = process.env.DSH_DESKTOP;
  process.env.DSH_STATE_DIR = path.join(dir, 'state');
  delete process.env.DSH_DESKTOP;
  try {
    await mkdir(path.join(dir, 'scripts'));
    await writeFile(path.join(dir, 'scripts/gen_videos.mjs'), "console.log('ready');setTimeout(()=>console.log('done'),200)");
    const { produce } = await import('../produce.mjs');
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const events = [];
    const running = produce({ project: dir, only: ['videos'], options: { plot: false },
      onEvent: (event) => { events.push(event); if (event.type === 'log' && event.line === 'ready') ready(); } });
    await started;
    t.mock.timers.tick(7 * 3600000);
    const result = await running;
    assert.equal(result.done, 1);
    assert.equal(result.cancelled, undefined);
    assert(events.some((e) => e.type === 'stage_done' && e.id === 'videos'));
    assert(!events.some((e) => e.type === 'stage_cancelled'));
  } finally {
    t.mock.timers.reset();
    if (originalState === undefined) delete process.env.DSH_STATE_DIR; else process.env.DSH_STATE_DIR = originalState;
    if (originalDesktop === undefined) delete process.env.DSH_DESKTOP; else process.env.DSH_DESKTOP = originalDesktop;
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit user stop still cancels a running video stage without retrying', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'produce-user-stop-'));
  const controller = new AbortController();
  try {
    await mkdir(path.join(dir, 'scripts'));
    await writeFile(path.join(dir, 'scripts/gen_videos.mjs'), "console.log('ready');setInterval(()=>{},1000)");
    const { produce } = await import('../produce.mjs');
    const events = [];
    const result = await produce({ project: dir, only: ['videos'], signal: controller.signal,
      onEvent: (event) => { events.push(event); if (event.type === 'log' && event.line === 'ready') controller.abort(); } });
    assert.equal(result.cancelled, true);
    assert(events.some((e) => e.type === 'stage_cancelled'));
    assert(!events.some((e) => e.type === 'stage_retry'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
