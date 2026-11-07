#!/usr/bin/env node
/**
 * settings.mjs —— 模型接口（Provider）配置中心
 *
 * 配置保存在使用者的数据目录，密钥由使用者自行填写。
 *
 * 协议：
 *   openai    —— POST {baseUrl}/chat/completions（OpenAI 兼容：DeepSeek、GLM Coding Plan、OpenCode Go…）
 *   anthropic —— POST {baseUrl}/v1/messages（Anthropic Messages：GLM Coding Plan 的 anthropic 端点）
 */
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWorkflows, mergeWorkflowDefaults } from './lib/workflow-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.DSH_STATE_DIR || path.resolve(__dirname, '..', 'data', 'state');
const STATE = path.join(STATE_DIR, 'providers.json');

export const DEFAULT_PROVIDERS = { active: 'custom', providers: [{ id: 'custom', label: '通用语言模型接口', protocol: 'openai', baseUrl: '', model: '', keyEnv: 'LLM_API_KEY', apiKey: '', maxTokens: 8000, note: '填写自己的接口地址、模型名称和密钥。' }] };

let cache = null;

function readCred(name) { return process.env[name] || ''; }

export async function loadProviders() {
  if (cache) return cache;
  let data = null;
  try { data = JSON.parse(await readFile(STATE, 'utf8')); } catch {}
  if (!data || !Array.isArray(data.providers) || !data.providers.length) {
    data = structuredClone(DEFAULT_PROVIDERS);
    await saveProviders(data);
  }
  // 补齐默认项（用户删掉后能恢复）＋ 加密钥
  for (const d of DEFAULT_PROVIDERS.providers) {
    if (!data.providers.some((p) => p.id === d.id)) data.providers.push(structuredClone(d));
  }
  for (const p of data.providers) {
    if (!p.apiKey && p.keyEnv) p.apiKey = readCred(p.keyEnv);
  }
  cache = data;
  return data;
}

export async function saveProviders(data) {
  await mkdir(path.dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(data, null, 2), 'utf8');
  try { await chmod(STATE, 0o600); } catch {}
  cache = data;
}

// ── ComfyUI 地址（可运行时热更新，存 state/settings.json）──
const SETTINGS = path.join(STATE_DIR, 'settings.json');
let _COMFY_URL = process.env.COMFY_URL || (process.env.DSH_DESKTOP === '1' ? 'http://127.0.0.1:8188' : 'http://127.0.0.1:8188');
let _WORKFLOWS = normalizeWorkflows();
let _DEFAULT_WORKFLOWS = normalizeWorkflows();
try {
  _DEFAULT_WORKFLOWS = normalizeWorkflows(JSON.parse(readFileSync(path.join(__dirname, 'assets', 'workflows', 'defaults.json'), 'utf8')));
  if (process.env.DSH_DESKTOP === '1') _WORKFLOWS = structuredClone(_DEFAULT_WORKFLOWS);
} catch {}
// 若已存过 settings.json，以其为准（用户在界面改过）；否则用 env；否则默认
try {
  const _p = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  if (_p && _p.url) _COMFY_URL = normComfyUrl(_p.url);
  if (_p && _p.workflows) _WORKFLOWS = process.env.DSH_DESKTOP === '1'
    ? mergeWorkflowDefaults(_DEFAULT_WORKFLOWS, _p.workflows) : normalizeWorkflows(_p.workflows);
} catch {}

/** 归一化：缺协议补 http://，去尾斜杠 */
function normComfyUrl(u) {
  const s = String(u || '').trim();
  if (!s) throw new Error('ComfyUI 地址不能为空');
  if (!/^https?:\/\//i.test(s)) return 'http://' + s.replace(/\/+$/, '');
  return s.replace(/\/+$/, '');
}

export function getComfyUrl() { return _COMFY_URL; }
export function getWorkflows() { return structuredClone(_WORKFLOWS); }
export function getDefaultWorkflows() { return structuredClone(_DEFAULT_WORKFLOWS); }

export async function saveComfyUrl(url, workflows) {
  const u = normComfyUrl(url);
  const next = workflows === undefined ? _WORKFLOWS : normalizeWorkflows(workflows);
  await mkdir(path.dirname(SETTINGS), { recursive: true });
  await writeFile(SETTINGS, JSON.stringify({ url: u, workflows: next }, null, 2), 'utf8');
  _COMFY_URL = u;
  _WORKFLOWS = next;
  return u;
}

export async function activeProvider() {
  const d = await loadProviders();
  return d.providers.find((p) => p.id === d.active) || d.providers[0];
}

export async function providerById(id) {
  const d = await loadProviders();
  return d.providers.find((p) => p.id === id) || null;
}

export function maskKey(k) {
  if (!k) return '';
  if (k.length <= 10) return k[0] + '***';
  return k.slice(0, 6) + '…' + k.slice(-4);
}

/** 给前端看的版本（密钥打码） */
export async function publicProviders() {
  const d = await loadProviders();
  return {
    active: d.active,
    providers: d.providers.map((p) => ({
      id: p.id, label: p.label, protocol: p.protocol, baseUrl: p.baseUrl, model: p.model,
      keyEnv: p.keyEnv, hasKey: !!p.apiKey, keyMask: maskKey(p.apiKey),
      reasoningEffort: p.reasoningEffort || '', maxTokens: p.maxTokens || 8000, note: p.note || '',
    })),
    comfy: { url: _COMFY_URL, workflows: _WORKFLOWS },
  };
}

/** 连通性测试：发一句最短的话 */
export async function testProvider(id) {
  const p = id ? await providerById(id) : await activeProvider();
  if (!p) throw new Error('找不到该接口');
  const t0 = Date.now();
  try {
    const { streamChat } = await import('./agent.mjs');
    const r = await streamChat(
      [{ role: 'user', content: '只回复两个字：可用' }],
      { provider: p, tools: [], maxTokens: 64, temperature: 0, onEvent: () => {} },
    );
    return { ok: true, ms: Date.now() - t0, text: (r.content || '').trim().slice(0, 80), finish: r.finish, model: p.model, baseUrl: p.baseUrl };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 300), model: p.model, baseUrl: p.baseUrl };
  }
}
