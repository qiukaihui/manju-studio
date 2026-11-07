import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkflows } from '../lib/workflow-config.mjs';

test('accepts independent image/video API graphs and empty configurations', () => {
  const image = { name: '出图.json', graph: { '3': { class_type: 'SaveImage', inputs: {} } } };
  assert.deepEqual(normalizeWorkflows({ image }), { image, frame: null, video: null });
  assert.deepEqual(normalizeWorkflows({}), { image: null, frame: null, video: null });
});

test('rejects editor workflows and malformed API nodes', () => {
  for (const graph of [{ nodes: [], links: [] }, {}, { '3': { inputs: {} } }, { '3': { class_type: 'SaveImage', inputs: [] } }]) {
    assert.throws(() => normalizeWorkflows({ video: { name: 'invalid.json', graph } }), /API/);
  }
});
