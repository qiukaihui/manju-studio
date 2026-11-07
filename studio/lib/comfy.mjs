#!/usr/bin/env node
/**
 * comfy.mjs — ComfyUI API 调用器（零依赖，Node >= 18）
 *
 * 一行用法：
 *   node comfy.mjs --workflow _wf/image_qwen_image_2_1_t2i.json \
 *     --set 'TextEncodeQwenImage21.prompt=@prompt.txt' \
 *     --set 'ResolutionSelector.aspect_ratio=9:16 (Portrait Widescreen)' \
 *     --set 'SaveImageAdvanced.filename_prefix=yaoshi_S03' \
 *     --set 'KSampler.seed=$RANDOM' --out ../art/images/x.png
 *
 * 作为库：
 *   import { createClient, runGraph } from './comfy.mjs';
 *   const c = createClient({ baseUrl: 'http://127.0.0.1:8188' });
 *   const { files, elapsedMs } = await runGraph({ client: c, graph, timeoutMs: 900000 });
 *
 * 错误分级（退出码 + kind）：
 *   CONNECT(2)        连不上 / DNS / 连接被重置 / 提交超时
 *   VALIDATION(3)     图不合法：缺必填、类型不对、未知节点
 *   MISSING_MODEL(4)  模型/文件不在服务器上（Value not in list / not found）
 *   OOM(5)            显存不足（CUDA out of memory）
 *   NODE_ERROR(6)     节点执行抛错（含 node_id / node_type / 异常类型）
 *   TIMEOUT(7)        排队或执行超时
 *   DOWNLOAD(8)       出图了但下载/落盘失败
 *   INTERRUPTED(9)    被 /interrupt 或服务器重启打断
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve as pathResolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadWorkflow, convert, parseOverrideString, parseValue } from './ui2api.mjs';

export const DEFAULT_BASE = 'http://127.0.0.1:8188';

/* ------------------------------------------------------------------ *
 * 错误类型
 * ------------------------------------------------------------------ */

export const ERR = {
  CONNECT: 'CONNECT',
  VALIDATION: 'VALIDATION',
  MISSING_MODEL: 'MISSING_MODEL',
  OOM: 'OOM',
  NODE_ERROR: 'NODE_ERROR',
  TIMEOUT: 'TIMEOUT',
  DOWNLOAD: 'DOWNLOAD',
  INTERRUPTED: 'INTERRUPTED',
  HTTP: 'HTTP',
};

const EXIT_CODE = {
  CONNECT: 2, VALIDATION: 3, MISSING_MODEL: 4, OOM: 5,
  NODE_ERROR: 6, TIMEOUT: 7, DOWNLOAD: 8, INTERRUPTED: 9, HTTP: 10,
};

export class ComfyError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ComfyError';
    this.kind = kind;
    this.exitCode = EXIT_CODE[kind] ?? 1;
    this.extra = extra;
    this.hints = extra.hints || [];
  }
  toJSON() {
    return { kind: this.kind, message: this.message, hints: this.hints, ...this.extra };
  }
}

const OOM_RE = /out of memory|OutOfMemory|Allocation on device|CUDA error: out of memory|not enough memory|CUBLAS_STATUS_ALLOC_FAILED|insufficient memory/i;
const MISSING_RE = /Value not in list|not in list|No such file|does not exist|cannot find|Could not find|not found|Failed to load|FileNotFoundError/i;

/** 把 /prompt 的错误体解析成人能看懂的诊断 */
export function classifyPromptError(body) {
  const nodeErrors = body?.node_errors || {};
  const nodeParts = [];
  const flatMessages = [];
  for (const [nodeId, info] of Object.entries(nodeErrors)) {
    const errs = info.errors || [];
    for (const e of errs) {
      const detail = e.details ? ` (${e.details})` : '';
      nodeParts.push(`节点 ${nodeId} [${info.class_type}]: ${e.message}${detail}`);
      flatMessages.push(`${e.message}${detail}`);
    }
  }
  const top = body?.error;
  const topMsg = typeof top === 'string' ? top : [top?.message, top?.details].filter(Boolean).join(': ');
  const all = [topMsg, ...flatMessages].filter(Boolean).join(' | ') || '(服务器未给出错误文本)';

  const hints = [];
  if (OOM_RE.test(all)) {
    hints.push('显存不足：把分辨率降到 640x1152（9:16）再试；或先 /free 释放缓存、检查是否有其它任务占着显存');
    return new ComfyError(ERR.OOM, `显存不足(OOM)：${all}`, { nodeErrors, hints, raw: body });
  }
  if (MISSING_RE.test(all)) {
    const missing = [...all.matchAll(/([\w.\-]+\.(?:safetensors|ckpt|pt|pth|bin|gguf|onnx))/gi)].map((m) => m[1]);
    if (missing.length) hints.push(`服务器缺这些模型文件: ${[...new Set(missing)].join(', ')}`);
    hints.push('用 GET /object_info/<NodeType> 看服务器上到底有哪些可选文件名，或改用已存在的模型');
    return new ComfyError(ERR.MISSING_MODEL, `缺模型/文件：${all}`, { nodeErrors, hints, missing: [...new Set(missing)], raw: body });
  }
  if (Object.keys(nodeErrors).length) {
    hints.push('节点级校验失败：对照 /object_info 检查输入名/类型/枚举；本次不重试');
    return new ComfyError(ERR.VALIDATION, `图校验失败：${all}`, { nodeErrors, hints, raw: body });
  }
  return new ComfyError(ERR.VALIDATION, `提交被拒：${all}`, { nodeErrors, hints, raw: body });
}

/** 用 /history 里的 execution_error 生成诊断 */
export function classifyExecError(histEntry) {
  const msgs = histEntry?.status?.messages || [];
  const errEntry = msgs.find((m) => Array.isArray(m) && m[0] === 'execution_error');
  const data = errEntry?.[1] || {};
  const text = [data.exception_type, data.exception_message].filter(Boolean).join(': ') || JSON.stringify(data);
  const where = data.node_id ? `节点 ${data.node_id}${data.node_type ? ` [${data.node_type}]` : ''}` : '';
  const hints = [];
  if (OOM_RE.test(text)) {
    hints.push('显存不足：降低分辨率到 640x1152 重试；确认没有并发任务');
    return new ComfyError(ERR.OOM, `执行时显存不足：${where} ${text}`, { hints, nodeId: data.node_id, nodeType: data.node_type, traceback: data.traceback, raw: data });
  }
  if (/interrupt/i.test(text)) {
    return new ComfyError(ERR.INTERRUPTED, `任务被中断：${where} ${text}`, { hints: ['有人调了 /interrupt，或服务器被重启'], nodeId: data.node_id, raw: data });
  }
  if (MISSING_RE.test(text)) {
    hints.push('执行期找不到文件，通常是模型/参考图路径问题');
    return new ComfyError(ERR.MISSING_MODEL, `执行期缺文件：${where} ${text}`, { hints, nodeId: data.node_id, nodeType: data.node_type, traceback: data.traceback, raw: data });
  }
  hints.push(`看 /object_info/${data.node_type || '节点类型'} 的必填输入；traceback 里最后一行是真正的异常`);
  return new ComfyError(ERR.NODE_ERROR, `${where} 执行报错：${text}`, { hints, nodeId: data.node_id, nodeType: data.node_type, traceback: data.traceback, raw: data });
}

/* ------------------------------------------------------------------ *
 * HTTP 客户端
 * ------------------------------------------------------------------ */

export function createClient({ baseUrl = DEFAULT_BASE, clientId = randomUUID(), quiet = false } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const say = (...a) => { if (!quiet) console.log(...a); };

  async function req(path, { method = 'GET', body, timeoutMs = 60000, expectJson = true, raw = false } = {}) {
    const url = path.startsWith('http') ? path : `${base}${path}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        body,
        headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const cause = e?.cause?.code || e?.code || e?.name || '';
      const isTimeout = /Timeout|AbortError/i.test(String(e?.name)) || /Timeout/i.test(String(cause));
      throw new ComfyError(ERR.CONNECT, isTimeout
        ? `请求超时: ${method} ${url}`
        : `连不上 ComfyUI: ${method} ${url} (${cause || e.message})`, {
        hints: [
          `确认服务器在跑且带 --listen 0.0.0.0：curl ${base}/system_stats`,
          '同一网段/防火墙 8188 是否放行',
        ],
        cause: cause || e.message,
      });
    }
    if (raw) {
      if (!res.ok) throw new ComfyError(ERR.HTTP, `HTTP ${res.status}: ${method} ${url}`, { status: res.status });
      return Buffer.from(await res.arrayBuffer());
    }
    const text = await res.text();
    let json = null;
    if (expectJson) {
      try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    }
    if (!res.ok) {
      if (json?.node_errors || json?.error) {
        const err = classifyPromptError(json);
        err.extra.status = res.status;
        throw err;
      }
      throw new ComfyError(ERR.HTTP, `HTTP ${res.status} ${method} ${url}: ${text.slice(0, 400)}`, { status: res.status, body: text.slice(0, 2000) });
    }
    return expectJson ? json : text;
  }

  return {
    baseUrl: base,
    clientId,
    req,
    systemStats: () => req('/system_stats'),
    objectInfo: (node) => req(node ? `/object_info/${encodeURIComponent(node)}` : '/object_info'),
    queueStatus: () => req('/queue'),
    /** POST /prompt */
    async queuePrompt(graph, extra = {}) {
      const body = JSON.stringify({ prompt: graph, client_id: extra.clientId || clientId, ...extra.body });
      try {
        return await req('/prompt', { method: 'POST', body, timeoutMs: 120000 });
      } catch (e) {
        if (e instanceof ComfyError && e.kind === ERR.CONNECT) {
          // 提交超时的常见原因：图太大 / 服务器忙着校验
          e.hints.push('图提交超时：检查是否连错端口，或图里节点太多');
        }
        throw e;
      }
    },
    history: (id) => req(`/history/${encodeURIComponent(id)}`, { timeoutMs: 60000 }),
    historyList: (max = 10) => req(`/history?max_items=${max}`),
    viewUrl: ({ filename, subfolder = '', type = 'output' }) =>
      `${base}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`,
    download: ({ filename, subfolder = '', type = 'output' }) =>
      req(`${base}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`, { raw: true, timeoutMs: 300000 }),
    /** POST /upload/image → { name, subfolder, type } */
    async uploadImage(filePath, { overwrite = true, subfolder = '' } = {}) {
      const buf = readFileSync(filePath);
      const fd = new FormData();
      fd.append('image', new Blob([buf]), basename(filePath));
      fd.append('overwrite', String(overwrite));
      if (subfolder) fd.append('subfolder', subfolder);
      const r = await req('/upload/image', { method: 'POST', body: fd, timeoutMs: 120000 });
      return r;
    },
    free: (body = { unload_models: true, free_memory: true }) =>
      req('/free', { method: 'POST', body: JSON.stringify(body) }).catch((e) => { say(`[warn] /free 失败: ${e.message}`); }),
    interrupt: () => req('/interrupt', { method: 'POST', body: '{}' }).catch((e) => { say(`[warn] /interrupt 失败: ${e.message}`); }),
    say,
  };
}

/* ------------------------------------------------------------------ *
 * 输出收集
 * ------------------------------------------------------------------ */

const FILE_KEYS = ['images', 'gifs', 'videos', 'audio', 'files', 'models'];

export function collectOutputs(historyEntry) {
  const out = [];
  const outputs = historyEntry?.outputs || {};
  for (const [nodeId, val] of Object.entries(outputs)) {
    if (!val || typeof val !== 'object') continue;
    for (const key of FILE_KEYS) {
      const arr = val[key];
      if (!Array.isArray(arr)) continue;
      for (const f of arr) {
        if (!f || typeof f !== 'object' || !f.filename) continue;
        out.push({ nodeId, kind: key, filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output', raw: f });
      }
    }
    // 有些节点直接给 {filename:...}
    if (val.filename && !out.length) out.push({ nodeId, kind: 'file', filename: val.filename, subfolder: val.subfolder || '', type: val.type || 'output', raw: val });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 跑一个图：提交 → 轮询 → 收输出 → 下载
 * ------------------------------------------------------------------ */

export async function runGraph({
  client,
  graph,
  timeoutMs = 900000,
  pollMs = 1500,
  queuePollEvery = 5,
  onEvent = () => {},
  quiet = false,
} = {}) {
  const t0 = Date.now();
  const submitted = await client.queuePrompt(graph);
  const promptId = submitted.prompt_id;
  if (!promptId) throw new ComfyError(ERR.VALIDATION, `服务器没返回 prompt_id: ${JSON.stringify(submitted).slice(0, 500)}`, { raw: submitted });
  const nodeErrorsWarn = submitted.node_errors && Object.keys(submitted.node_errors).length ? submitted.node_errors : null;
  if (nodeErrorsWarn) onEvent('warn', { message: '服务器返回了 node_errors（通常仍会执行）', nodeErrors: nodeErrorsWarn });
  onEvent('submitted', { promptId, number: submitted.number, elapsedMs: Date.now() - t0 });

  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  let hist = null;
  let lastQueueInfo = null;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    polls++;
    let h;
    try {
      h = await client.history(promptId);
    } catch (e) {
      if (e instanceof ComfyError && e.kind === ERR.CONNECT) throw e; // 服务器掉了
      throw e;
    }
    if (h && h[promptId]) {
      hist = h[promptId];
      const st = hist.status || {};
      if (st.status_str === 'error') {
        throw classifyExecError(hist);
      }
      if (st.completed || st.status_str === 'success' || Object.keys(hist.outputs || {}).length) {
        onEvent('executed', { promptId, elapsedMs: Date.now() - t0 });
        break;
      }
    }
    if (polls % queuePollEvery === 0) {
      try {
        const q = await client.queueStatus();
        const running = (q.queue_running || []).map((x) => x[1]);
        const pending = (q.queue_pending || []).map((x) => x[1]);
        const pos = pending.indexOf(promptId);
        lastQueueInfo = { running: running.length, pending: pending.length, position: pos >= 0 ? pos + 1 : null, isRunning: running.includes(promptId) };
        onEvent('progress', { promptId, waitedMs: Date.now() - t0, ...lastQueueInfo });
      } catch { /* queue 查询失败不影响主流程 */ }
    }
  }

  if (!hist) {
    throw new ComfyError(ERR.TIMEOUT, `等 ${Math.round(timeoutMs / 1000)}s 还没出结果（prompt_id=${promptId}）`, {
      hints: [
        '首跑要加载 int8 大模型，冷启动可能 2-5 分钟；用 --timeout 调大',
        lastQueueInfo?.running ? '有其它任务在跑，排队中' : '检查服务器 GPU 是否卡住（/queue、/system_stats 的 vram_free）',
      ],
      promptId,
      lastQueueInfo,
    });
  }

  const outputs = collectOutputs(hist);
  if (!outputs.length) {
    throw new ComfyError(ERR.DOWNLOAD, `执行成功但没有任何输出文件（prompt_id=${promptId}）`, { hints: ['检查 SaveImage 节点是否在输出链上 / 是否被剪枝'], promptId, history: hist });
  }

  // 服务器侧耗时
  let serverExecMs = null;
  const msgs = hist.status?.messages || [];
  const tStart = msgs.find((m) => Array.isArray(m) && m[0] === 'execution_start')?.[1]?.timestamp;
  const tEnd = msgs.find((m) => Array.isArray(m) && (m[0] === 'execution_success'))?.[1]?.timestamp;
  if (tStart && tEnd) serverExecMs = tEnd - tStart;

  return { promptId, outputs, history: hist, elapsedMs: Date.now() - t0, serverExecMs, polls, lastQueueInfo };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把输出下载到 outPath。多个输出时自动加 -1/-2 后缀。返回落盘文件列表 */
export async function downloadOutputs(client, outputs, outPath) {
  const files = [];
  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    let dest = outPath;
    if (outputs.length > 1) {
      const dot = outPath.lastIndexOf('.');
      const stem = dot > 0 ? outPath.slice(0, dot) : outPath;
      const ext = dot > 0 ? outPath.slice(dot) : '';
      dest = `${stem}-${i + 1}${ext}`;
    }
    let buf;
    try {
      buf = await client.download(o);
    } catch (e) {
      throw new ComfyError(ERR.DOWNLOAD, `下载失败 ${o.filename}: ${e.message}`, { hints: ['文件可能已被清理；或 /view 参数不对'], filename: o.filename });
    }
    if (!buf.length) throw new ComfyError(ERR.DOWNLOAD, `下载到 0 字节: ${o.filename}`, { filename: o.filename });
    mkdirSync(dirname(pathResolve(dest)), { recursive: true });
    writeFileSync(dest, buf);
    files.push({ path: dest, bytes: buf.length, filename: o.filename, subfolder: o.subfolder, nodeId: o.nodeId });
  }
  return files;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const a = {
    sets: [], keep: [], prune: true, quiet: false, base: DEFAULT_BASE,
    timeout: 900000, poll: 1500, out: null, outdir: null, graph: null, workflow: null,
    list: false, dryRun: false, saveApi: null, seed: null, validate: false, clientId: null, noObjectInfo: false,
    upload: null, objectInfoUrl: null, queryPrompt: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--base': a.base = next(); break;
      case '--workflow': a.workflow = next(); break;
      case '--graph': a.graph = next(); break;
      case '--set': a.sets.push(next()); break;
      case '--keep': a.keep.push(next()); break;
      case '--seed': a.seed = next(); break;
      case '--out': a.out = next(); break;
      case '--outdir': a.outdir = next(); break;
      case '--timeout': a.timeout = Math.round(Number(next()) * 1000); break;
      case '--poll': a.poll = Math.round(Number(next()) * 1000); break;
      case '--save-api': a.saveApi = next(); break;
      case '--client-id': a.clientId = next(); break;
      case '--upload': a.upload = next(); break;
      case '--query-prompt': a.queryPrompt = next(); break;
      case '--list': a.list = true; break;
      case '--prune': a.prune = true; break;
      case '--no-prune': a.prune = false; break;
      case '--dry-run': a.dryRun = true; break;
      case '--validate': a.validate = true; break;
      case '--no-object-info': a.noObjectInfo = true; break;
      case '--quiet': a.quiet = true; break;
      case '-h': case '--help': a.help = true; break;
      default:
        if (k.startsWith('--')) throw new Error(`未知参数 ${k}`);
        if (!a.workflow) a.workflow = k;
        else throw new Error(`多余参数 ${k}`);
    }
  }
  return a;
}

function printError(e, quiet) {
  const tag = e.kind || 'ERROR';
  console.error(`\n✗ [${tag}] ${e.message}`);
  if (e.extra?.nodeErrors) {
    for (const [id, info] of Object.entries(e.extra.nodeErrors)) {
      console.error(`  · 节点 ${id} [${info.class_type}]`);
      for (const er of info.errors || []) console.error(`      ${er.message}${er.details ? ` — ${er.details}` : ''}`);
    }
  }
  if (e.extra?.nodeId) console.error(`  · 出错节点: ${e.extra.nodeId}${e.extra.nodeType ? ` (${e.extra.nodeType})` : ''}`);
  if (!quiet) for (const h of e.hints || []) console.error(`  → ${h}`);
  if (e.extra?.traceback && !quiet) {
    const tb = String(e.extra.traceback).trim().split('\n');
    console.error(`  → traceback(尾): ${tb.slice(-3).join(' / ')}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法: node comfy.mjs --workflow <ui.json> [选项]

  --base <url>           默认 ${DEFAULT_BASE}
  --workflow <ui.json>   UI 格式工作流（会用 ui2api 转换；默认剪枝）
  --graph <api.json>     直接用 API 格式（跳过转换）
  --set K=V              覆盖，规则同 ui2api.mjs
  --seed <random|n>
  --out <file>           单输出落盘路径；多输出自动加 -1/-2
  --outdir <dir>         多输出都放进目录
  --timeout <秒>         默认 900
  --poll <秒>            轮询间隔，默认 1.5
  --list                 只打印转换后的节点，不提交
  --dry-run              转换 + 校验，不提交
  --save-api <file>      把转换结果存成 API JSON
  --validate             提交前用 /object_info 校验输入名/枚举（不校验也会取，只用于转换）
  --no-object-info       不取 /object_info（纯 API 图可用；视频工作流别加）
  --no-prune             保留不可达节点（会执行提示词增强等分支，慢）
  --upload <file>        只做一次图片上传测试
  --query-prompt <id>    查历史结果
  --quiet
`);
    return;
  }

  const client = createClient({ baseUrl: args.base, clientId: args.clientId || undefined, quiet: args.quiet });

  if (args.upload) {
    const r = await client.uploadImage(args.upload);
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (args.queryPrompt) {
    const h = await client.history(args.queryPrompt);
    console.log(JSON.stringify(h, null, 2));
    return;
  }

  // 组装 graph
  const overrides = {};
  for (const s of args.sets) {
    const { key, valueSrc } = parseOverrideString(s);
    overrides[key] = parseValue(valueSrc);
  }
  if (args.seed != null) overrides['*seed'] = args.seed === 'random' ? Math.floor(Math.random() * 2 ** 48) : Number(args.seed);

  let graph = null;
  let conv = null;
  let objectInfo = null;
  // UI 格式转换一律先取 object_info：视频工作流（SaveVideo 等）只有位置式 widgets_values，
  // 没有 object_info 的 input_order 就映射不出 format/codec，会报 "Required input is missing"。
  // 真的取不到也继续（图片工作流有 widgets_values_named，不依赖它）。
  if (!args.noObjectInfo && (args.workflow || args.validate)) {
    try { objectInfo = await client.objectInfo(); }
    catch (e) { console.error(`[warn] 取 object_info 失败（继续）: ${e.message}`); }
  }

  if (args.graph) {
    graph = JSON.parse(readFileSync(args.graph, 'utf8'));
    // 对 API 图做覆盖：包一层
    if (Object.keys(overrides).length) {
      const wrapped = { alreadyApi: true, api: graph };
      graph = convert(wrapped, { overrides, prune: false, objectInfo, validate: args.validate }).api;
    }
  } else {
    if (!args.workflow) throw new Error('需要 --workflow 或 --graph');
    const loaded = loadWorkflow(args.workflow);
    conv = convert(loaded, {
      overrides,
      prune: args.prune,
      keep: args.keep,
      objectInfo,
      validate: args.validate,
    });
    if (!args.quiet) for (const w of conv.warnings) console.error(`[warn] ${w}`);
    graph = conv.api;
  }

  if (args.saveApi) { writeFileSync(args.saveApi, JSON.stringify(graph, null, 2)); if (!args.quiet) console.error(`[ok] API 图已写 ${args.saveApi}`); }
  if (args.list) {
    for (const [id, n] of Object.entries(graph)) console.log(`${id}\t${n.class_type}\tinputs: ${Object.keys(n.inputs).join(',')}`);
    return;
  }
  if (args.dryRun) { console.log(JSON.stringify(graph, null, 2)); return; }

  // 提交
  console.log(`[..] 提交到 ${client.baseUrl}（${Object.keys(graph).length} 节点，client_id=${client.clientId.slice(0, 8)}）`);
  const startedAt = Date.now();
  let result;
  try {
    result = await runGraph({
      client, graph,
      timeoutMs: args.timeout,
      pollMs: args.poll,
      quiet: args.quiet,
      onEvent: (ev, data) => {
        if (args.quiet) return;
        if (ev === 'submitted') console.log(`[..] prompt_id=${data.promptId} 已入队`);
        else if (ev === 'progress') {
          const q = data.isRunning ? '执行中' : (data.position ? `排队第 ${data.position}` : '等待');
          process.stdout.write(`\r[..] ${q} · ${(data.waitedMs / 1000).toFixed(0)}s   `);
        } else if (ev === 'executed') process.stdout.write('\n');
        else if (ev === 'warn') {
          console.log(`[warn] ${data.message}`);
          for (const [id, info] of Object.entries(data.nodeErrors || {})) {
            for (const er of info.errors || []) console.log(`       · 节点 ${id} [${info.class_type}] ${er.message}${er.details ? ` — ${er.details}` : ''}`);
          }
        }
      },
    });
  } catch (e) {
    printError(e, args.quiet);
    process.exit(e.exitCode || 1);
  }

  // 落盘
  const outPath = args.out || (args.outdir ? `${args.outdir.replace(/\/+$/, '')}/${result.outputs[0].filename}` : `${result.outputs[0].filename}`);
  let files;
  try {
    files = await downloadOutputs(client, result.outputs, outPath);
  } catch (e) {
    printError(e, args.quiet);
    process.exit(e.exitCode || 1);
  }

  const wall = Date.now() - startedAt;
  console.log(`[ok] prompt_id=${result.promptId}  服务器执行=${result.serverExecMs != null ? (result.serverExecMs / 1000).toFixed(1) + 's' : '?'}  端到端=${(wall / 1000).toFixed(1)}s`);
  for (const f of files) console.log(`[ok] ${f.path}  ${(f.bytes / 1024).toFixed(0)} KB  ← ${f.filename}`);
  console.log(JSON.stringify({ ok: true, promptId: result.promptId, serverExecMs: result.serverExecMs, elapsedMs: wall, files }, null, 0));
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    if (e instanceof ComfyError) { printError(e, false); process.exit(e.exitCode || 1); }
    console.error(`[error] ${e?.stack || e}`);
    process.exit(1);
  });
}
