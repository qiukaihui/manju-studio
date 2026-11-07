import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildGraph, executeWorkflow } from '../lib/custom-workflow.mjs';
import { productionJobs } from '../lib/custom-production.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const workflow = {
  graph: { '1': { class_type: 'Text', inputs: { text: 'old' } }, '2': { class_type: 'SaveImage', inputs: {} } },
  bindings: { prompt: ['1', 'text'] }, outputNode: '2',
};
test('injects mapped values without changing imported workflow; rejects missing mappings', () => {
  assert.equal(buildGraph(workflow, { prompt: 'new' })['1'].inputs.text, 'new');
  assert.equal(workflow.graph['1'].inputs.text, 'old');
  assert.throws(() => buildGraph({ ...workflow, bindings: {} }, { prompt: 'new' }), /提示词/);
  assert.throws(() => buildGraph({ ...workflow, outputNode: 'missing' }, { prompt: 'new' }), /输出/);
});

test('unused blank reference slots are removed instead of submitting missing template images', () => {
  const config = { ...workflow, graph: { ...workflow.graph,
    ref: { class_type: 'LoadImage', inputs: { image: '' } },
    encoder: { class_type: 'Encoder', inputs: { 'images.image_2': ['ref', 0] } },
  }, bindings: { ...workflow.bindings, image2: ['ref', 'image'] } };
  const graph = buildGraph(config, { prompt: 'new' });
  assert.equal(graph.ref, undefined);
  assert.equal(graph.encoder.inputs['images.image_2'], undefined);
  assert(config.graph.ref);
});

test('batch planning uses each episode scene and current storyboard, without stale plans', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'custom-jobs-'));
  try {
    const put = async (folder, name, data) => { await mkdir(path.join(dir, folder)); await writeFile(path.join(dir, folder, name), JSON.stringify(data)); };
    await put('art', 'p-art.json', { scenes: [{ id: 'S1', name: '白天' }, { id: 'S2', name: '夜晚' }] });
    await put('characters', 'p-cast.json', { characters: [{ id: 'C1', name: '小明', image: { prompt: 'character' } }] });
    await put('script', 'p-script.json', { episodes: [{ ep: 1, scenes: [{ sceneId: 'S1' }] }, { ep: 2, scenes: [{ sceneId: 'S2' }] }] });
    await put('storyboard', 'p-storyboard.json', { episodes: [1, 2].map((ep) => ({ ep, segments: [{ id: `E0${ep}-01`, sceneIndex: 1, h3Prompt: 'video', cuts: [{ frame: 'frame', seconds: 4, characters: ['C1'] }] }] })) });
    const jobs = await productionJobs(dir, 'frames');
    assert.equal(jobs[1].refs[0], 'art/images/夜晚-sheet.png');
    assert.equal((await productionJobs(dir, 'videos'))[1].seconds, 4);
    const cutJobs = await productionJobs(dir, 'videos', { referenceMode: 'cuts' });
    assert.deepEqual(cutJobs[1].refs, ['frames/E02-01/f1.png']);
    assert.notEqual((await productionJobs(dir, 'characters'))[0].prompt, (await productionJobs(dir, 'characters'))[1].prompt);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('submits, polls and downloads only selected node output, preserving file extension', async () => {
  let submitted;
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/prompt') {
      let body = ''; for await (const chunk of req) body += chunk;
      submitted = JSON.parse(body).prompt;
      res.end(JSON.stringify({ prompt_id: 'job-1' }));
    } else if (req.url === '/history/job-1') {
      res.end(JSON.stringify({ 'job-1': { status: { completed: true }, outputs: {
        '9': { images: [{ filename: 'wrong.png' }] }, '2': { images: [{ filename: 'result.webp' }] },
      } } }));
    } else if (req.url.startsWith('/view?')) {
      assert.match(req.url, /result.webp/); res.end('fake-media');
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'custom-workflow-'));
  try {
    const out = await executeWorkflow({ workflow, values: { prompt: 'hello' }, kind: 'image',
      baseUrl: `http://127.0.0.1:${server.address().port}`, out: path.join(dir, 'image.png'), pollMs: 1 });
    assert.equal(submitted['1'].inputs.text, 'hello');
    assert.equal(path.extname(out), '.webp');
    assert.equal(await readFile(out, 'utf8'), 'fake-media');
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); }
});
