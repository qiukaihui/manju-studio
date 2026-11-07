import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWorkflowDefaults } from '../lib/workflow-config.mjs';
import { readFileSync } from 'node:fs';
import { buildGraph } from '../lib/custom-workflow.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const item = (name) => ({ name, graph: { '1': { class_type: 'SaveImage', inputs: {} } } });
const defaults = { image: item('image'), frame: item('frame'), video: item('video') };
test('first launch seeds all bundled defaults, without replacing saved custom or cleared workflows', () => {
  assert.deepEqual(mergeWorkflowDefaults(defaults), defaults);
  const custom = item('custom');
  assert.deepEqual(mergeWorkflowDefaults(defaults, { image: custom, video: null }), { image: custom, frame: defaults.frame, video: null });
  assert.equal(defaults.image.name, 'image');
});

test('bundled presets have ready bindings, clean reference placeholders and no dangling links', () => {
  const bundled = JSON.parse(readFileSync(new URL('../assets/workflows/defaults.json', import.meta.url), 'utf8'));
  for (const [kind, config] of Object.entries(bundled)) {
    const graph = buildGraph(config, { prompt: 'test prompt', negative: '', seed: 1, prefix: 'test', seconds: 5, fps: 24, image: 'uploaded.png' });
    assert.equal(graph[config.bindings.prompt[0]].inputs[config.bindings.prompt[1]], 'test prompt');
    assert(graph[config.outputNode]);
    for (const node of Object.values(graph)) {
      if (node.class_type === 'LoadImage') assert.equal(node.inputs.image, 'uploaded.png');
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'number') assert(graph[value[0]], `${kind}: missing linked node`);
      }
    }
  }
  assert.equal(bundled.video.referenceMode, 'cuts');
});

test('saved settings survive a desktop restart; an explicit clear does not reseed defaults', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-upgrade-'));
  try {
    const code = `const m=await import(${JSON.stringify(new URL('../settings.mjs', import.meta.url).href)});console.log(JSON.stringify({workflows:m.getWorkflows(),url:m.getComfyUrl()}));`;
    const load = async () => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, DSH_DESKTOP: '1', DSH_STATE_DIR: dir },
    })).stdout);
    const custom = item('my-custom-workflow');
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ url: 'http://127.0.0.1:9191', workflows: { image: custom } }));
    const saved = await load();
    assert.deepEqual(saved.workflows.image, custom);
    assert(saved.workflows.frame?.bindings.image);
    assert.equal(saved.url, 'http://127.0.0.1:9191');
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ workflows: { image: null, frame: null, video: null } }));
    assert.deepEqual((await load()).workflows, { image: null, frame: null, video: null });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
