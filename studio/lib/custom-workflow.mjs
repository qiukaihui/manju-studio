import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function buildGraph(workflow, values) {
  const graph = structuredClone(workflow.graph);
  if (!workflow.bindings?.prompt) throw new Error('请在设置中选择工作流的提示词输入');
  if (!graph[workflow.outputNode]) throw new Error('请在设置中选择工作流的输出节点');
  for (const [key, target] of Object.entries(workflow.bindings)) {
    if (!target) continue;
    const [id, field] = target;
    if (!graph[id] || !Object.hasOwn(graph[id].inputs, field)) throw new Error(`工作流输入不存在：${key}`);
    if (values[key] === undefined) {
      if (/^image/.test(key)) {
        // Bundled graphs have blank reference placeholders, not sample project images.
        if (graph[id].class_type === 'LoadImage' && graph[id].inputs[field] === '') {
          delete graph[id];
          for (const node of Object.values(graph)) {
            for (const [input, value] of Object.entries(node.inputs)) {
              if (Array.isArray(value) && value[0] === id) delete node.inputs[input];
            }
          }
        }
        continue;
      }
      throw new Error(`缺少工作流输入：${key}`);
    }
    graph[id].inputs[field] = values[key];
  }
  return graph;
}

export async function executeWorkflow({ workflow, values, kind, baseUrl, out, refs = [], signal,
  pollMs = 1500, timeoutMs = 3600000, onLog = () => {} }) {
  const base = baseUrl.replace(/\/+$/, '');
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  async function request(route, options = {}, raw = false) {
    const res = await fetch(base + route, { ...options, signal: combined });
    if (!res.ok) throw new Error(`ComfyUI ${route.split('?')[0]} 请求失败（${res.status}）`);
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  }
  const mapped = { ...values };
  for (let i = 0; i < refs.length && i < 4; i++) {
    if (!refs[i]) continue;
    const key = i ? `image${i + 1}` : 'image';
    if (!workflow.bindings?.[key]) continue;
    const data = new FormData();
    const filename = `${randomUUID()}${path.extname(refs[i])}`;
    data.append('image', new Blob([await readFile(refs[i])]), filename);
    const upload = await request('/upload/image', { method: 'POST', body: data });
    mapped[key] = [upload.subfolder, upload.name].filter(Boolean).join('/');
  }
  const graph = buildGraph(workflow, mapped);
  const submission = await request('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: randomUUID() }) });
  const id = submission.prompt_id;
  if (!id || Object.keys(submission.node_errors || {}).length) throw new Error('ComfyUI 工作流校验失败，请检查节点、模型和配置映射');
  onLog(`工作流已提交：${id}`);
  try {
    while (true) {
      combined.throwIfAborted();
      const history = (await request(`/history/${encodeURIComponent(id)}`))[id];
      if (history?.status?.status_str === 'error') throw new Error('ComfyUI 工作流执行失败，请检查 ComfyUI 错误日志');
      if (history?.status?.completed || history?.status?.status_str === 'success') {
        const node = history.outputs?.[workflow.outputNode];
        const candidates = Object.values(node || {}).flat().filter((f) => f && typeof f.filename === 'string');
        const allowed = kind === 'video' ? /\.(mp4|webm|mov|mkv)$/i : /\.(png|jpg|jpeg|webp)$/i;
        const file = candidates.find((f) => allowed.test(f.filename));
        if (!file) throw new Error('所选输出节点未返回可用文件，请选择保存图片或视频的节点');
        const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
        const bytes = await request('/view?' + query, {}, true);
        if (!bytes.length) throw new Error('ComfyUI 返回了空文件');
        const output = out.slice(0, out.length - path.extname(out).length) + path.extname(file.filename).toLowerCase();
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, bytes);
        return output;
      }
      await delay(pollMs, undefined, { signal: combined });
    }
  } catch (error) {
    if (combined.aborted) {
      // Delete only our queued job. Never clear/interrupt someone else's ComfyUI work.
      await fetch(base + '/queue', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: [id] }), signal: AbortSignal.timeout(3000) }).catch(() => {});
      onLog('已停止等待并移除本任务的排队项；若已开始计算，请在 ComfyUI 中停止该任务');
    }
    throw error;
  }
}
