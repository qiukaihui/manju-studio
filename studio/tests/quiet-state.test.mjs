import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('reading status after seven silent minutes must not abort video generation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quiet-state-'));
  const clock = path.join(dir, 'clock');
  const preload = path.join(dir, 'clock.mjs');
  await writeFile(clock, '0');
  await writeFile(preload, `import {readFileSync} from 'node:fs';const now=Date.now.bind(Date);Date.now=()=>now()+Number(readFileSync(${JSON.stringify(clock)},'utf8'));`);
  let submitted = false;
  const comfy = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/prompt') { for await (const chunk of req) {} submitted = true; res.end('{"prompt_id":"waiting"}'); }
    else res.end('{}');
  });
  await new Promise((r) => comfy.listen(0, '127.0.0.1', r));
  const project = path.join(dir, 'projects/demo');
  for (const [folder, data] of Object.entries({
    art: { scenes: [] }, characters: { characters: [] }, script: { episodes: [] },
    storyboard: { episodes: [{ ep: 1, segments: [{ id: 'E01-01', h3Prompt: 'a scene', cuts: [{ seconds: 5 }] }] }] },
  })) {
    await mkdir(path.join(project, folder), { recursive: true });
    const suffix = folder === 'characters' ? 'cast' : folder;
    await writeFile(path.join(project, folder, `demo-${suffix}.json`), JSON.stringify(data));
  }
  const child = fork(process.env.TEST_DESKTOP_BUNDLE || fileURLToPath(new URL('../server.mjs', import.meta.url)), [], {
    execArgv: ['--import', pathToFileURL(preload).href], env: { ...process.env, DSH_DESKTOP: '1', DSH_SESSION_TOKEN: 'test-session',
      DSH_ROOT: path.join(dir, 'projects'), DSH_STATE_DIR: path.join(dir, 'state'), DSH_LOG_DIR: path.join(dir, 'logs'), PORT: '0', STUDIO_AUTO_RESUME: '0' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    const request = (route, body) => fetch(`http://127.0.0.1:${ready.port}${route}`, {
      method: body ? 'POST' : 'GET', headers: { 'X-Studio-Session': 'test-session', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    await request('/api/settings', { comfy: { url: `http://127.0.0.1:${comfy.address().port}`, workflows: { video: {
      name: 'test.json', graph: { '1': { class_type: 'Text', inputs: { text: '' } }, '2': { class_type: 'SaveVideo', inputs: {} } },
      bindings: { prompt: ['1', 'text'] }, outputNode: '2',
    } } } });
    const start = await request('/api/produce', { p: 'demo', only: ['videos'], options: { plot: false, images: false, videos: true, upscale: false, concat: false, report: false } });
    assert.equal(start.status, 200);
    for (let i = 0; i < 100 && !submitted; i++) await delay(20);
    assert(submitted, 'video generation actually started');
    await delay(30);
    await writeFile(clock, String(7 * 60000));
    const state = await (await request('/api/produce/state')).json();
    assert.equal(state.running, true, 'a quiet GPU task is still running');
    assert(state.quietMs > 6 * 60000);
    assert.equal((await request('/api/produce', { p: 'demo', only: ['videos'] })).status, 409, 'starting again cannot silently replace a quiet task');
    assert.equal((await request('/api/produce/cancel', {})).status, 200, 'only explicit cancel stops the job');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    comfy.closeAllConnections(); await new Promise((r) => comfy.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
