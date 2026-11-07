import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('desktop backend uses isolated user directories and persists workflow mappings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-api-'));
  await mkdir(path.join(dir, 'projects'));
  const server = process.env.TEST_DESKTOP_BUNDLE || fileURLToPath(new URL('../server.mjs', import.meta.url));
  const child = fork(server, [], { execArgv: [], env: { ...process.env, DSH_DESKTOP: '1',
    DSH_ROOT: path.join(dir, 'projects'), DSH_STATE_DIR: path.join(dir, 'state'),
    DSH_LOG_DIR: path.join(dir, 'logs'), STUDIO_AUTO_RESUME: '0', PORT: '0', DSH_SESSION_TOKEN: 'test-session' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  let prompt;
  const comfy = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/prompt') {
      let body = ''; for await (const chunk of req) body += chunk;
      prompt = JSON.parse(body).prompt; res.end(JSON.stringify({ prompt_id: 'scene-1' }));
    } else if (req.url === '/history/scene-1') {
      res.end(JSON.stringify({ 'scene-1': { status: { completed: true }, outputs: { '2': { images: [{ filename: 'scene.png' }] } } } }));
    } else if (req.url.startsWith('/view?')) res.end('fake-png');
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((r) => comfy.listen(0, '127.0.0.1', r));
  child.stderr.on('data', (d) => { errors += d; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('startup timeout: ' + errors)), 10000);
      child.once('exit', () => { clearTimeout(timer); reject(new Error('server exited: ' + errors)); });
      child.on('message', (m) => { if (m.type === 'ready') { clearTimeout(timer); resolve(m.port); } });
    });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base + '/api/settings')).status, 403);
    const request = (route, options = {}) => fetch(base + route, { ...options, headers: { ...options.headers, 'X-Studio-Session': 'test-session' } });
    let cfg = await (await request('/api/settings')).json();
    assert.equal(cfg.comfy.url, 'http://127.0.0.1:8188');
    assert(cfg.comfy.workflows.image?.bindings.prompt, 'fresh desktop starts with built-in image workflow');
    assert(cfg.comfy.workflows.frame?.bindings.image, 'fresh desktop starts with built-in reference image mapping');
    assert.equal(cfg.comfy.workflows.video?.referenceMode, 'cuts');
    const defaults = await (await request('/api/settings/workflow-defaults')).json();
    assert.deepEqual(defaults.workflows, cfg.comfy.workflows);
    const image = { name: 'test.json', graph: { '1': { class_type: 'Text', inputs: { text: '' } },
      '2': { class_type: 'SaveImage', inputs: {} } }, bindings: { prompt: ['1', 'text'] }, outputNode: '2' };
    const response = await request('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comfy: { url: `http://127.0.0.1:${comfy.address().port}`, workflows: { image } } }) });
    assert.equal((await response.json()).ok, true);
    cfg = await (await request('/api/settings')).json();
    assert.deepEqual(cfg.comfy.workflows.image, image);
    const project = path.join(dir, 'projects', 'demo');
    await mkdir(path.join(project, 'art'), { recursive: true });
    await writeFile(path.join(project, 'art/demo-art.json'), JSON.stringify({ scenes: [{ name: '街道', image: { prompt: 'a quiet street' } }] }));
    const run = await request('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p: 'demo', task: 'scenes' }) });
    assert.equal(run.status, 200);
    for (let i = 0; i < 100; i++) {
      if (!(await (await request('/api/active')).json()).id) break;
      await delay(20);
    }
    assert.equal(prompt['1'].inputs.text, 'a quiet street');
    assert.equal(await readFile(path.join(project, 'art/images/街道-sheet.png'), 'utf8'), 'fake-png');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    comfy.closeAllConnections(); await new Promise((r) => comfy.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
