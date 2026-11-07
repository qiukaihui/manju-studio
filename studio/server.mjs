#!/usr/bin/env node
/**
 * 漫剧工坊 Studio —— 本地可视化工作台后端
 * 零依赖：node:http / fs / child_process。端口默认 7799。
 *
 * API:
 *   GET  /api/projects                         项目列表
 *   GET  /api/project?p=<name>                 项目全量状态（阶段/产物/媒体/统计）
 *   POST /api/run        {p, task, args?}      跑任务（scenes/characters/frames/videos/upscale/concat/staging/validate）
 *   POST /api/cancel     {jobId}               取消当前任务
 *   GET  /api/events                           任务日志 SSE
 *   GET  /api/comfy                            ComfyUI 队列/显存（代理）
 *   GET  /media/<项目>/<相对路径>               项目文件（图/视频/报告 html）
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync, readdirSync, renameSync, unlinkSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { produce, previewPlan, scopeSegIds } from './produce.mjs';
import { customWorkflowFor, runCustomProduction } from './lib/custom-production.mjs';
import { publicProviders, saveProviders, loadProviders, activeProvider, providerById, testProvider, getComfyUrl, saveComfyUrl, getDefaultWorkflows } from './settings.mjs';
import { runEpisodeAction } from './episodes.mjs';
import { runAgent } from './agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.DSH_STATE_DIR || path.resolve(__dirname, '..', 'data', 'state');
const LOG_DIR = process.env.DSH_LOG_DIR || path.resolve(__dirname, '..', 'data', 'logs');
await mkdir(STATE_DIR, { recursive: true });
await mkdir(LOG_DIR, { recursive: true });
// 打包分发时：ROOT/SKILLS 走环境变量覆盖（否则打包后 __dirname 变了，找不到项目/技能）
const ROOT = process.env.DSH_ROOT ? path.resolve(process.env.DSH_ROOT) : path.resolve(__dirname, '..', 'projects'); // 项目根目录（含各剧目录）
const UI = path.join(__dirname, 'ui');
const PORT = Number(process.env.PORT || 7799);
let COMFY = getComfyUrl(); // 运行时可改：/api/settings 保存 ComfyUI 地址会热更新此变量

// 脚本模板项目：优先环境变量，其次自动找任意带 scripts/gen_videos.mjs 的项目
function findTemplateProject() {
  if (process.env.TEMPLATE_PROJECT) {
    const t = path.join(ROOT, process.env.TEMPLATE_PROJECT);
    if (existsSync(path.join(t, 'scripts', 'gen_videos.mjs'))) return t;
  }
  try {
    for (const d of readdirSync(ROOT, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'studio') continue;
      const t = path.join(ROOT, d.name);
      if (existsSync(path.join(t, 'scripts', 'gen_videos.mjs'))) return t;
    }
  } catch {}
  return null;
}
const TEMPLATE_PROJECT = findTemplateProject();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.srt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/** 向 ComfyUI 发一个「不复用连接」的 GET，避免长驻进程里的 keep-alive 死 socket
 *  target —— 可选；传入则 ping 该地址（用于设置页「测试连接」，不影响全局 COMFY） */
function comfyGetJson(pathname, timeoutMs = 5000, target) {
  return new Promise((resolve, reject) => {
    const url = new URL((target || COMFY) + pathname);
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search,
      method: 'GET', agent: false, timeout: timeoutMs,
      headers: { accept: 'application/json', connection: 'close' },
    }, (r) => {
      let b = '';
      r.setEncoding('utf8');
      r.on('data', (d) => { b += d; });
      r.on('end', () => {
        if (r.statusCode >= 400) return reject(new Error(`HTTP ${r.statusCode}`));
        try { resolve(JSON.parse(b)); } catch { reject(new Error('响应不是 JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`超时 ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

async function comfyGetRetry(pathname) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try { return await comfyGetJson(pathname); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  throw lastErr;
}

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
};
const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
const safeJoin = (base, rel) => {
  const r = path.resolve(base, rel);
  if (!r.startsWith(path.resolve(base) + path.sep) && r !== path.resolve(base)) return null;
  return r;
};

/* ---------------------------------- 项目扫描 ---------------------------------- */
const STAGES = [
  { key: 'outline', name: '改编大纲', dir: 'outline', json: (n) => `${n}-outline.json`, report: (n) => `${n}-outline-report.html`, md: (n) => `${n}-outline.md` },
  { key: 'characters', name: '角色设定', dir: 'characters', json: (n) => `${n}-cast.json`, report: (n) => `${n}-cast-report.html`, md: (n) => `${n}-cast.md` },
  { key: 'art', name: '美术设定', dir: 'art', json: (n) => `${n}-art.json`, report: (n) => `${n}-art-report.html`, md: (n) => `${n}-art.md` },
  { key: 'script', name: '剧本', dir: 'script', json: (n) => `${n}-script.json`, report: (n) => `${n}-script-report.html`, md: (n) => `${n}-script.md` },
  { key: 'staging', name: '开场站位', dir: 'staging', json: (n) => `${n}-staging.json`, report: () => 'staging-report.html', md: () => null },
  { key: 'storyboard', name: '分镜', dir: 'storyboard', json: (n) => `${n}-storyboard.json`, report: (n) => `${n}-storyboard-report.html`, md: (n) => `${n}-storyboard.md` },
];

async function listDirs(p) {
  try { return (await readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); }
  catch { return []; }
}

async function projectMeta(name) {
  const dir = path.join(ROOT, name);
  const files = [];
  for (const s of STAGES) {
    const sd = path.join(dir, s.dir);
    if (!existsSync(sd)) continue;
    let entries = [];
    try { entries = await readdir(sd); } catch {}
    const j = entries.find((f) => f.endsWith('.json') && !/manifest|\.gates|plan/i.test(f));
    const rep = entries.find((f) => f.endsWith('.html'));
    const md = entries.find((f) => f.endsWith('.md'));
    let corrupt = false;
    if (j) { try { JSON.parse(await readFile(path.join(sd, j), 'utf8')); } catch { corrupt = true; } }
    files.push({ key: s.key, name: s.name, dir: s.dir, json: j || null, report: rep || null, md: md || null, corrupt });
  }
  return { name, dir, stages: files };
}

async function listProjects() {
  const out = [];
  for (const d of await listDirs(ROOT)) {
    if (d === 'node_modules' || d === 'studio') continue;
    const dir = path.join(ROOT, d);
    const m = await projectMeta(d);
    if (!m.stages.length && !existsSync(path.join(dir, 'docs/编剧-原稿.txt'))) continue;
    const meta = await readMeta(dir);
    const outline = await readJson(path.join(dir, 'outline', `${d}-outline.json`));
    const stagesDone = m.stages.filter((s) => s.json).length;
    let cover = meta.cover || null;
    if (!cover) {
      const cand = ['art/images', 'frames', 'characters/images'];
      for (const c of cand) {
        try {
          const f = (await readdir(path.join(dir, c)))[0];
          if (f) { cover = `/media/${encodeURIComponent(d)}/${c}/${encodeURIComponent(f)}`; break; }
        } catch {}
      }
    }
    let episodes = meta.episodes ?? outline?.params?.episodes ?? null;
    let seconds = meta.secondsPerEpisode ?? (outline?.params?.minutesPerEpisode ? outline.params.minutesPerEpisode * 60 : null);
    out.push({
      name: d, title: meta.title || d, genre: meta.genre || outline?.params?.genre || null,
      style: meta.style || null, episodes, seconds, cover,
      stages: m.stages.map((s) => ({ key: s.key, name: s.name, json: !!s.json, report: !!s.report })),
      progress: Math.round((stagesDone / 6) * 100),
      updatedAt: (await stat(path.join(dir, 'docs')).catch(() => null))?.mtimeMs || null,
    });
  }
  return out;
}

/* --------------------------------- 项目全量状态 -------------------------------- */
async function mediaList(dir, rel, filter) {
  const base = path.join(dir, rel);
  if (!existsSync(base)) return [];
  const out = [];
  async function walk(d, depth = 0) {
    if (depth > 3) return;
    let ents = [];
    try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (!filter || filter.test(e.name)) {
        const st = statSync(full);
        out.push({
          path: path.relative(dir, full).split(path.sep).join('/'),
          size: st.size, mtime: st.mtimeMs,
          url: '/media/' + encodeURIComponent(path.basename(dir)) + '/' + path.relative(dir, full).split(path.sep).map(encodeURIComponent).join('/'),
        });
      }
    }
  }
  await walk(base);
  return out.sort((a, b) => a.path.localeCompare(b.path, 'zh'));
}

async function projectState(name) {
  const dir = path.join(ROOT, name);
  if (!existsSync(dir)) return null;
  const meta = await projectMeta(name);
  const data = {};
  for (const s of meta.stages) {
    const jp = s.json ? path.join(dir, s.dir, s.json) : null;
    data[s.key] = jp ? await readJson(jp) : null;
  }
  const outline = data.outline, cast = data.characters, art = data.art, script = data.script, staging = data.staging, sb = data.storyboard;

  // 统计
  const stats = {
    episodes: outline?.params?.episodes ?? null,
    minutes: outline?.params?.minutesPerEpisode ?? null,
    genre: outline?.params?.genre ?? null,
    characters: cast?.characters?.length ?? null,
    scenes: art?.scenes?.length ?? null,
    props: art?.props?.length ?? null,
    scriptScenes: script?.episodes?.reduce?.((n, e) => n + (e.scenes?.length || 0), 0) ?? null,
    scriptLines: script?.episodes?.reduce?.((n, e) => n + (e.scenes || []).reduce((m, s) => m + (s.flow || []).filter((b) => b.line).length, 0), 0) ?? null,
    segments: sb?.episodes?.reduce?.((n, e) => n + (e.segments?.length || 0), 0) ?? null,
    cuts: sb?.episodes?.reduce?.((n, e) => n + (e.segments || []).reduce((m, s) => m + (s.cuts?.length || 0), 0), 0) ?? null,
    seconds: sb?.episodes?.reduce?.((n, e) => n + (e.segments || []).reduce((m, s) => m + (s.cuts || []).reduce((k, c) => k + (c.seconds || 0), 0), 0), 0) ?? null,
  };

  const media = {
    scenes: await mediaList(dir, 'art/images', /\.(png|webp|jpg)$/i),
    characters: await mediaList(dir, 'characters/images', /\.(png|webp|jpg)$/i),
    frames: await mediaList(dir, 'frames', /\.(png|webp|jpg)$/i),
    segments: await mediaList(dir, 'renders/segments', /\.mp4$/i),
    finals: (await mediaList(dir, 'renders', /\.mp4$/i)).filter((m) => !/\/segments\//.test(m.path) && !/\/upscale/.test(m.path) && !/\/title\.mp4$/.test(m.path)),
    upscaled: await mediaList(dir, 'renders/upscale720', /\.mp4$/i),
    srt: await mediaList(dir, 'renders', /\.srt$/i),
  };

  // 结构化摘要（给前端渲染用，避免把整份大 JSON 都塞过去太重，这里给必要字段）
  const scriptView = script?.episodes?.map((ep) => ({
    ep: ep.ep, targetSeconds: ep.targetSeconds,
    scenes: (ep.scenes || []).map((s) => ({
      sceneId: s.sceneId, characters: s.characters, props: s.props,
      flow: (s.flow || []).map((b) => (b.line ? { who: b.speaker, line: b.line, delivery: b.delivery || '' } : { action: b.action })),
    })),
  })) || null;

  const storyboardView = sb?.episodes?.map((ep) => ({
    ep: ep.ep,
    segments: (ep.segments || []).map((sg) => ({
      id: sg.id, sceneIndex: sg.sceneIndex, blocking: sg.blocking, note: sg.note,
      seconds: (sg.cuts || []).reduce((n, c) => n + (c.seconds || 0), 0),
      cuts: (sg.cuts || []).map((c) => ({ beats: c.beats, seconds: c.seconds, size: c.size, camera: c.camera, characters: c.characters, frame: c.frame, shot: c.shot, lighting: c.lighting })),
      h3Prompt: sg.h3Prompt, soundscape: sg.soundscape, music: sg.music,
    })),
  })) || null;

  // 产物过期标记：上游改过、下游没重出，界面要明说，别让用户以为还是配套的
  const mtimeOf = (p) => { try { return statSync(p).mtimeMs || 0; } catch { return 0; } };
  const firstJson = (sub, re) => {
    try { const f = readdirSync(path.join(dir, sub)).filter((x) => re.test(x)).sort()[0]; return f ? path.join(dir, sub, f) : null; } catch { return null; }
  };
  const newestIn = (sub, re) => {
    try {
      const files = readdirSync(path.join(dir, sub), { recursive: true }).filter((x) => re.test(String(x)));
      return Math.max(0, ...files.map((f) => mtimeOf(path.join(dir, sub, f))));
    } catch { return 0; }
  };
  const sbFile = firstJson('storyboard', /-storyboard\.json$/);
  const sbM = sbFile ? mtimeOf(sbFile) : 0;
  const fpM = mtimeOf(path.join(dir, 'storyboard', 'frames-plan.json'));
  const vpM = mtimeOf(path.join(dir, 'storyboard', 'video-plan.json'));
  const frameM = newestIn('frames', /\.(png|webp)$/i);
  const segM = newestIn('renders/segments', /\.mp4$/i);
  const stale = [];
  if (sbM && fpM && fpM < sbM) stale.push({ key: 'frames', label: '关键帧', detail: '关键帧计划比最新分镜旧：现在这批关键帧是按老分镜出的，和新分镜可能对不上' });
  if (sbM && vpM && vpM < sbM) stale.push({ key: 'videos', label: '视频段', detail: '视频计划比最新分镜旧：已生成的视频段可能和新分镜对不上' });
  if (fpM && frameM && frameM < fpM) stale.push({ key: 'frames-out', label: '关键帧出图', detail: '关键帧图片比关键帧计划旧，需要重出' });
  if (vpM && segM && segM < vpM) stale.push({ key: 'videos-out', label: '视频出片', detail: '视频段比视频计划旧，需要重出' });

  return {
    name, stages: meta.stages, stats, media, meta: await readMeta(dir), stale,
    corruptStages: meta.stages.filter((x) => x.corrupt).map((x) => ({ key: x.key, name: x.name, file: x.json })),
    resumeAvailable: !!(await loadProduceState()),
    resumeInfo: (() => { try { const s0 = JSON.parse(readFileSync(PRODUCE_STATE, 'utf8')); return s0 && s0.project ? { stage: s0.stage || '准备中', stagesDone: s0.stagesDone || [], meta: { episodes: s0.episodes, resolution: s0.resolution } } : null; } catch { return null; } })(),
    reports: meta.stages.filter((s) => s.report).map((s) => ({ key: s.key, name: s.name, url: `/media/${encodeURIComponent(name)}/${s.dir}/${encodeURIComponent(s.report)}` })),
    outline: outline ? { params: outline.params, adaptation: outline.adaptation, characters: outline.characters, scenes: outline.scenes, props: outline.props, beats: outline.beats, episodes: outline.episodes } : null,
    cast: cast ? { characters: (cast.characters || []).map((c) => ({ id: c.id, name: c.name, importance: c.importance, oneLiner: c.oneLiner, image: c.image, voice: c.voice })) } : null,
    art: art ? { scenes: art.scenes, props: art.props } : null,
    script: scriptView, storyboard: storyboardView,
    staging: staging ? { scenes: staging.scenes || staging.locations || [] } : null,
    updatedAt: Math.max(0, ...meta.stages.map((s) => (s.json ? (statSync(path.join(dir, s.dir, s.json)).mtimeMs || 0) : 0))),
  };
}

/* ---------------------------------- 崩溃防护 ---------------------------------- */
const CRASH_LOG = path.join(LOG_DIR, 'crash.log');
process.on('uncaughtException', async (err) => {
  try { await writeFile(CRASH_LOG, JSON.stringify({ at: new Date().toISOString(), kind: 'uncaught', error: String(err?.stack || err) }) + '\n', { flag: 'a' }); } catch {}
  console.error('[crash]', err);
});
process.on('unhandledRejection', async (err) => {
  try { await writeFile(CRASH_LOG, JSON.stringify({ at: new Date().toISOString(), kind: 'rejection', error: String(err?.stack || err) }) + '\n', { flag: 'a' }); } catch {}
  console.error('[reject]', err);
});

/* ---------------------------------- 生产状态持久化 ---------------------------------- */
const PRODUCE_STATE = path.join(STATE_DIR, 'produce.json');
async function saveProduceState(obj) {
  // 原子写：先写 .tmp 再 rename，避免 kill -9 时留下半截 JSON（续跑就靠它）
  try {
    await mkdir(path.dirname(PRODUCE_STATE), { recursive: true });
    const tmp = PRODUCE_STATE + '.tmp';
    await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try { if (existsSync(PRODUCE_STATE)) await copyFile(PRODUCE_STATE, PRODUCE_STATE + '.bak'); } catch {}
    renameSync(tmp, PRODUCE_STATE);
  } catch {}
}
async function loadProduceState() {
  for (const f of [PRODUCE_STATE, PRODUCE_STATE + '.bak']) {
    try {
      const st = JSON.parse(await readFile(f, 'utf8'));
      if (st && st.project) return st;
    } catch {}
  }
  return null;
}
async function clearProduceState() {
  // 主文件与备份都要清：只清主文件时，读逻辑会回退到 .bak 把刚成功的记录又捞回来
  try { await writeFile(PRODUCE_STATE, 'null'); } catch {}
  try { await writeFile(PRODUCE_STATE + '.bak', 'null'); } catch {}
}

/* ---------------------------------- 生产日志 ---------------------------------- */
const PRODUCE_LOG = path.join(LOG_DIR, 'produce.log');
async function logProduce(obj) {
  try { await writeFile(PRODUCE_LOG, JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n', { flag: 'a' }); } catch {}
}
await logProduce({ type: 'server_start', pid: process.pid });

/* ---------------------------------- AI 助手会话 ---------------------------------- */
const CHAT = { history: new Map(), sessions: new Map() };
let currentChat = null;

function chatHistory(name) {
  if (!CHAT.history.has(name)) CHAT.history.set(name, []);
  return CHAT.history.get(name);
}

/** 首次访问时从 docs/chat-log.jsonl 恢复最近 20 条 */
async function loadChatHistory(name) {
  const mem = chatHistory(name);
  if (mem.length) return mem;
  try {
    const f = path.join(ROOT, name, 'docs', 'chat-log.jsonl');
    const raw = await readFile(f, 'utf8');
    const rows = raw.split('\n').filter(Boolean).slice(-20).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    for (const r of rows) if (r.role && r.content) mem.push({ role: r.role, content: r.content });
  } catch {}
  return mem;
}

async function appendChatLog(dir, msgs) {
  try {
    const f = path.join(dir, 'docs', 'chat-log.jsonl');
    await mkdir(path.dirname(f), { recursive: true });
    const lines = msgs.filter((m) => m.content).map((m) => JSON.stringify({ at: new Date().toISOString(), role: m.role, content: m.content })).join('\n');
    if (lines) await writeFile(f, lines + '\n', { flag: 'a' });
  } catch {}
}

async function buildChatSystem(name, dir) {
  const meta = await readMeta(dir);
  const st = await projectState(name).catch(() => null);
  const files = [];
  for (const f of ['docs/01-情节梳理.md', 'docs/编剧-原稿.txt', 'outline/' + name + '-outline.json', 'characters/' + name + '-cast.json', 'art/' + name + '-art.json', 'script/' + name + '-script.json', 'staging/' + name + '-staging.json', 'storyboard/' + name + '-storyboard.json']) {
    if (existsSync(path.join(dir, f))) files.push(f);
  }
  const eps = st?.stats?.episodes || meta.episodes || 1;
  return `你是《${meta.title || name}》的常驻 AI 助手，停在工作台右侧，用户随时会找你改东西。

【项目】${meta.title || name}
- 目录：${dir}（你的工作目录，只能读写这里）
- 规格：${eps} 集 × ${meta.secondsPerEpisode || 120} 秒 · ${meta.aspect || '9:16'} · ${meta.resolution || '720p'}
- 题材/画风：${meta.genre || '未设'} / ${meta.style || '未设'}
- 已有文件：${files.length ? files.join('、') : '（暂无，可先跑生产）'}

【你能做什么】
1. 改情节：编辑 docs/01-情节梳理.md、docs/sources/E0X.txt、分集梗概 docs/synopses/E0X.md
2. 改设定与剧本：outline / cast / art / script / staging / storyboard 的 JSON（先读再改，保持 schema）
3. 改完必须跑对应技能的 validate（node ~/.agents/skills/<skill>/scripts/<skill>.mjs validate ...）直到通过
4. 解释现状、给修改方案、指出质量门问题

【规矩】
- 只动本项目目录；不要读 studio/、别的项目、README
- 改 JSON 前先 read_file 原文；改动要小步，一次一件事
- 出图/出片这类长任务不要自己跑，告诉用户去「生产」页点对应任务
- 回答简洁中文，改完用 2–4 行说明改了哪些文件、校验结果`;
}

/* -------------------------------- 项目元数据 / 预设 ------------------------------- */
const PRESET_DIR = path.join(__dirname, 'assets', 'presets');
const PRESETS = {
  genres: [
    ['fantasy', '玄幻奇幻', 'a bustling night market of spirits under red lanterns, fox spirits and toad merchants, cartoonish guofeng cel'],
    ['xianxia', '仙侠修真', 'immortal peaks floating above a sea of clouds, ancient sword pavilion, cranes, golden dawn'],
    ['wuxia', '武侠江湖', 'rain-soaked inn courtyard, swordsman in straw hat, bamboo grove, ink-wash atmosphere'],
    ['palace', '宫斗权谋', 'imperial palace corridor at dusk, red pillars, silk curtains, a lone court lady with a lantern'],
    ['historical', '古装宅斗', 'Ming-Qing mansion courtyard, carved wooden screens, plum blossoms, servants in waiting'],
    ['republic', '民国传奇', '1930s Shanghai alley at night, rain-slick cobblestones, gas lamp, fog, figure with umbrella'],
    ['urban', '都市情感', 'modern city apartment at dusk through rain-streaked window, warm interior light, skyline bokeh'],
    ['comeback', '都市逆袭', 'night corporate lobby, a determined young woman in a suit walking away from a glass office, city lights'],
    ['suspense', '悬疑推理', 'dim interrogation room, single hanging bulb, scattered case files, cigarette smoke'],
    ['crime', '罪案刑侦', 'rainy crime scene at night, police tape, flashing light on wet asphalt, silhouettes'],
    ['spy', '谍战风云', '1940s intelligence office, desk lamp over files and a revolver, venetian blind shadows'],
    ['horror', '灵异惊悚', 'abandoned temple at midnight, paper effigies, flickering candle, cold mist'],
    ['scifi', '科幻未来', 'neon megacity rooftop, holographic signs, a lone figure looking at a giant ringed planet'],
    ['romance', '甜宠恋爱', 'bright cafe corner in afternoon sun, pastel interior, flowers, soft warm glow'],
    ['campus', '校园青春', 'sunlit classroom by the window, chalk dust in the air, two students, summer green'],
    ['workplace', '职场商战', 'glass boardroom at night, scattered documents, city skyline, tense meeting'],
    ['family', '家庭伦理', 'old family dining table, steaming dishes, fading evening light through lace curtains'],
    ['rebirth', '穿越重生', 'a modern person waking in an ancient bedchamber, silk canopy, candle, confusion'],
  ],
  styles: [
    ['guofeng', '国风赛璐璐', 'Chinese cel-shaded animation style, bold lineart, flat colors, guofeng fantasy'],
    ['anime', '日漫赛璐璐', 'Japanese anime cel-shaded style, clean crisp lineart, flat colors, expressive'],
    ['ink', '水墨', 'Chinese ink wash painting style, sumi-e brush strokes, xuan paper texture, minimal color'],
    ['realistic', '厚涂写实', 'painterly semi-realistic illustration, thick brushwork, detailed texture, dramatic rim light'],
    ['comic', '美漫', 'American comic book style, bold ink outlines, halftone shading, saturated colors'],
    ['3d', '3D 动画', '3D animated film still, stylized characters, soft global illumination, cinematic depth of field'],
    ['watercolor', '治愈水彩', 'soft watercolor illustration, gentle washes, paper texture, warm pastel palette'],
    ['gothic', '暗黑哥特', 'dark gothic illustration, high contrast chiaroscuro, desaturated crimson, ornate shadows'],
  ],
  aspects: [['9:16', '竖屏 9:16'], ['16:9', '横屏 16:9']],
  resolutions: [['720p', '720p'], ['1080p', '1080p']],
};
function novelOf(dir) {
  const docs = path.join(dir, 'docs');
  try {
    const cands = readdirSync(docs).filter((f) => /\.(txt|md)$/i.test(f));
    const score = (f) => (/原稿|原文|小说|novel|编剧|剧本/i.test(f) ? 0 : /^0?1[-_.]/.test(f) ? 2 : 1);
    cands.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
    if (cands.length) return path.join(docs, cands[0]);
  } catch {}
  return path.join(dir, 'docs', '编剧-原稿.txt');
}

function metaPath(dir) { return path.join(dir, 'project.json'); }
async function readMeta(dir) {
  const m = await readJson(metaPath(dir));
  if (m) return m;
  // 兼容老项目：从大纲/目录推断
  const name = path.basename(dir);
  let episodes = null, seconds = null, genre = null;
  const ol = await readJson(path.join(dir, 'outline', `${name}-outline.json`));
  if (ol?.params) { episodes = ol.params.episodes; seconds = ol.params.minutesPerEpisode ? ol.params.minutesPerEpisode * 60 : null; genre = ol.params.genre; }
  return { name, title: name, episodes, secondsPerEpisode: seconds, genre, style: null, createdAt: null, legacy: true };
}

/** 从剧本正文里识别分集：第N集 / 第N话 / EP01 / E01 / 第N章 */
function splitEpisodes(text) {
  const patterns = [
    /^\s*第\s*([一二三四五六七八九十百零〇\d]+)\s*集(?!\d).*$/gm,
    /^\s*第\s*([一二三四五六七八九十百零〇\d]+)\s*话(?!\d).*$/gm,
    /^\s*(?:EP|Ep|ep|E|e)\s*(\d{1,3})(?!\d).*$/gm,
    /^\s*第\s*([一二三四五六七八九十百零〇\d]+)\s*章(?!\d).*$/gm,
  ];
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const toNum = (s) => {
    if (/^\d+$/.test(s)) return Number(s);
    if (s === '十') return 10;
    if (/^十[一二三四五六七八九]$/.test(s)) return 10 + cn[s[1]];
    if (/^[一二三四五六七八九]十$/.test(s)) return cn[s[0]] * 10;
    if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(s)) return cn[s[0]] * 10 + cn[s[2]];
    return cn[s] || null;
  };
  const sceneRe = /^\s*(?:第\s*[一二三四五六七八九十\d]+\s*场|场景\s*[一二三四五六七八九十\d]+)/gm;
  let hits = [];
  for (const re of patterns) {
    const found = [...text.matchAll(re)].map((m) => ({ idx: m.index, raw: m[0].trim(), no: toNum(m[1]) })).filter((x) => x.no);
    if (found.length && (found.length >= 2 || found[0].idx < 400)) { hits = found; break; }
  }
  const countScenes = (t) => (t.match(sceneRe) || []).length;
  if (!hits.length) {
    return { detected: false, list: [{ no: 1, title: '全篇', text: text.trim(), scenes: countScenes(text) }] };
  }
  hits.sort((a, b) => a.idx - b.idx);
  // 去重（同一集重复出现只取第一个）
  const seen = new Set();
  hits = hits.filter((h) => (seen.has(h.no) ? false : (seen.add(h.no), true)));
  const list = hits.map((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].idx : text.length;
    const t = text.slice(h.idx, end).trim();
    return { no: h.no, title: h.raw, text: t, scenes: countScenes(t) };
  });
  return { detected: true, list };
}

async function episodeRows(p) {
  const dir = path.join(ROOT, p);
  const st = await projectState(p);
  if (!st) return null;
  const meta = await readMeta(dir);
  const name = p;
  const total = Number(meta.episodes) || Number(st.stats.episodes) || 1;
  const outlineEps = st.outline?.episodes || [];
  const scriptEps = st.script || [];
  const sbEps = st.storyboard || [];
  const synDir = path.join(dir, 'docs', 'synopses');
  const rows = [];
  for (let ep = 1; ep <= total; ep++) {
    const epTag = `E${String(ep).padStart(2, '0')}`;
    const o = outlineEps.find((x) => x.ep === ep);
    const sc = scriptEps.find((x) => x.ep === ep);
    const sb = sbEps.find((x) => x.ep === ep);
    let synopsis = '';
    try { synopsis = await readFile(path.join(synDir, `${epTag}.md`), 'utf8'); synopsis = synopsis.replace(/^#.*\n+/, '').trim(); } catch {}
    const frames = (st.media.frames || []).filter((m) => m.path.includes(`/${epTag}-`));
    const vids = (st.media.segments || []).filter((m) => m.path.includes(`${epTag}-`));
    const scenes = sc?.scenes?.length || 0;
    const lines = sc ? sc.scenes.reduce((n, s) => n + s.flow.filter((b) => b.line).length, 0) : 0;
    const secs = sc ? sc.scenes.reduce((n, s) => n + s.flow.reduce((k, b) => k + (b.line ? 0 : 0), 0), 0) : 0;
    let source = '';
    try { source = await readFile(path.join(dir, 'docs', 'sources', `${epTag}.txt`), 'utf8'); } catch {}
    const status = vids.length ? 6 : frames.length ? 5 : sb ? 4 : sc ? 3 : (o || synopsis) ? 2 : source ? 1 : 0;
    rows.push({
      ep, tag: epTag, synopsis, hasSource: !!source, sourceChars: source.length,
      sourcePreview: source ? source.replace(/^#.*\n+/, '').replace(/\s+/g, ' ').slice(0, 90) : '',
      hasOutline: !!o, hook: o?.hook || '', synopsisOutline: o?.synopsis || '',
      scenes, lines, scenesSec: Math.round(secs),
      segments: sb?.segments?.length || 0, cuts: sb ? sb.segments.reduce((n, s) => n + s.cuts.length, 0) : 0,
      seconds: sb ? Math.round(sb.segments.reduce((n, s) => n + s.cuts.reduce((k, c) => k + c.seconds, 0), 0)) : 0,
      frames: frames.length, videos: vids.length, status,
    });
  }
  return { total, rows, meta };
}

/* -------------------------------- 一键生产脚手架 ------------------------------- */
let currentProduce = null;

async function ensureProject(name, { novelText } = {}) {
  if (!/^[\w\u4e00-\u9fa5·\- ]{1,60}$/.test(name)) throw new Error('剧名不合法（字母/数字/中文，≤60 字）');
  const dir = path.join(ROOT, name);
  for (const d of ['docs', 'outline', 'characters', 'art', 'script', 'staging', 'storyboard', 'scripts', 'frames', 'renders/segments']) {
    await mkdir(path.join(dir, d), { recursive: true });
  }
  if (novelText && String(novelText).trim()) {
    await writeFile(path.join(dir, 'docs/编剧-原稿.txt'), String(novelText), 'utf8');
  }
  const src = TEMPLATE_PROJECT ? path.join(TEMPLATE_PROJECT, 'scripts') : null;
  const dst = path.join(dir, 'scripts');
  if (existsSync(src) && !existsSync(path.join(dst, 'gen_videos.mjs'))) {
    await cp(src, dst, { recursive: true });
  }
  return dir;
}

/* ---------------------------------- 任务执行 ---------------------------------- */
const SKILLS = process.env.DSH_SKILLS || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills'); // 技能脚本目录（打包分发用 DSH_SKILLS 指向对方机器）
const TASKS = {
  validate: { label: '跑全部质量门', cmd: null, build: null },
  scenes: { label: '出场景设定图', cmd: 'gen_scenes.mjs', cwd: 'scripts', args: [] },
  characters: { label: '出角色锚点图', cmd: 'gen_characters.mjs', cwd: 'scripts', args: [] },
  frames: { label: '出分镜关键帧', cmd: 'gen_frames.mjs', cwd: 'scripts', args: [] },
  videos: { label: '生成视频段', cmd: 'gen_videos.mjs', cwd: 'scripts', args: [] },
  upscale: { label: 'SeedVR2 超分', cmd: 'gen_upscale.mjs', cwd: 'scripts', args: ['--res', '720'] },
  staging: { label: '重渲染站位报告', cmd: null, build: null },
};

const serverStartedAt = Date.now();
const MANUAL_LOG = path.join(LOG_DIR, 'manual.log');
const MANUAL_LAST = path.join(STATE_DIR, 'manual-last.json');

let active = null;              // {id, task, project, child, startedAt, lines, sse}
const listeners = new Set();
const broadcast = (msg) => { for (const fn of listeners) { try { fn(msg); } catch {} } };

function runJob({ project, task, extraArgs = [] }) {
  const dir = path.join(ROOT, project);
  const def = TASKS[task];
  if (!def) throw new Error('未知任务');
  const id = Math.random().toString(36).slice(2, 10);
  const job = { id, task, label: def.label, project, startedAt: Date.now(), lines: [], done: false, exitCode: null, child: null };
  active = job;
  const emit = (line) => {
    job.lines.push(line);
    if (job.lines.length > 800) job.lines.shift();
    try { appendFileSync(MANUAL_LOG, JSON.stringify({ at: new Date().toISOString(), project, task, id, line }) + '\n'); } catch {}
    broadcast({ type: 'log', id, line });
  };
  const finish = (code) => {
    job.exitCode = code; job.done = true;
    try { writeFileSync(MANUAL_LAST, JSON.stringify({ id, project, task, label: def.label, exitCode: code, doneAt: new Date().toISOString(), lines: job.lines.slice(-300) }, null, 2)); } catch {}
    broadcast({ type: 'done', id, exitCode: code });
    active = null;
  };
  emit(`▶ ${def.label} · ${project}`);
  if (process.env.DSH_DESKTOP === '1' && ['scenes', 'characters', 'frames', 'videos'].includes(task) && !customWorkflowFor(task)) {
    emit('✗ 请先在设置中配置并保存出图／出视频工作流'); finish(-1); return job;
  }
  if (customWorkflowFor(task)) {
    const controller = new AbortController();
    job.child = { kill: () => controller.abort() };
    runCustomProduction({ project: dir, task, args: extraArgs, signal: controller.signal, onLog: emit })
      .then(() => finish(0)).catch((e) => { emit(`✗ ${controller.signal.aborted ? '任务已取消' : e.message}`); finish(-1); });
    return job;
  }

  if (task === 'validate') {
    // 产物文件名按目录里真实存在的来（老项目前缀可能和目录名不同），原稿也按 docs 里实际文件找
    const firstIn = (sub, re) => { try { return readdirSync(path.join(dir, sub)).filter((x) => re.test(x)).sort()[0] || null; } catch { return null; } };
    const A = (rel) => path.join(dir, rel);
    const fOutline = firstIn('outline', /-outline\.json$/);
    const fCast = firstIn('characters', /-cast\.json$/);
    const fArt = firstIn('art', /-art\.json$/);
    const fScript = firstIn('script', /-script\.json$/);
    const fStaging = firstIn('staging', /-staging\.json$/);
    const fSb = firstIn('storyboard', /-storyboard\.json$/);
    const fNovel = novelOf(dir);
    const missing = [['大纲', fOutline], ['角色', fCast], ['美术', fArt], ['剧本', fScript], ['站位', fStaging], ['分镜', fSb]].filter(([, f]) => !f);
    // [阶段名, 校验脚本, 参数]；用 process.execPath 跑脚本，不要再把 'node' 当脚本传进去
    const checks = [
      ['大纲', `${SKILLS}/novel-outline/scripts/novel-outline.mjs`, ['validate', A(path.join('outline', fOutline))]],
      ['角色', `${SKILLS}/novel-characters/scripts/novel-characters.mjs`, ['validate', A(path.join('characters', fCast)), fNovel]],
      ['美术', `${SKILLS}/novel-art/scripts/novel-art.mjs`, ['validate', A(path.join('art', fArt)), '--cast', A(path.join('characters', fCast))]],
      ['剧本', `${SKILLS}/novel-script/scripts/novel-script.mjs`, ['validate', A(path.join('script', fScript)), '--outline', A(path.join('outline', fOutline)), '--art', A(path.join('art', fArt))]],
      ['站位', `${SKILLS}/novel-staging/scripts/novel-staging.mjs`, ['validate', A(path.join('staging', fStaging)), '--script', A(path.join('script', fScript)), '--art', A(path.join('art', fArt))]],
      ['分镜', `${SKILLS}/novel-storyboard/scripts/novel-storyboard.mjs`, ['validate', A(path.join('storyboard', fSb)), '--script', A(path.join('script', fScript)), '--outline', A(path.join('outline', fOutline)), '--cast', A(path.join('characters', fCast)), '--art', A(path.join('art', fArt))]],
    ];
    if (missing.length) {
      emit(`✗ 缺产物：${missing.map(([k]) => k).join('、')}，先跑一键生成`);
      job.done = true; job.exitCode = 1; broadcast({ type: 'done', id, exitCode: 1 }); active = null;
      return job;
    }
    (async () => {
      let failed = 0;
      for (const [label, cmd, args] of checks) {
        emit(`\n【${label}】`);
        await new Promise((resolve) => {
          const c = spawn(process.execPath, [cmd, ...args], { cwd: ROOT, env: process.env });
          job.child = c;
          c.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => emit(l)));
          c.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => emit('! ' + l)));
          c.on('close', (code) => { if (code !== 0) failed++; resolve(); });
        });
      }
      emit(failed ? `\n✗ ${failed} 个阶段未过` : '\n✓ 六阶质量门全部通过');
      finish(failed);
    })();
    return job;
  }

  const script = path.join(dir, def.cwd, def.cmd);
  if (!existsSync(script)) {
    emit(`✗ 找不到脚本 ${script}`);
    finish(-1);
    return job;
  }
  const c = spawn(process.execPath, [script, ...def.args, ...extraArgs], { cwd: path.join(dir, def.cwd), env: process.env });
  job.child = c;
  c.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => emit(l)));
  c.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => emit('! ' + l)));
  c.on('close', (code) => {
    emit(code === 0 ? `\n✓ ${def.label} 完成` : `\n✗ ${def.label} 退出码 ${code}`);
    finish(code);
  });
  return job;
}

/* ----------------------------------- 静态服务 ---------------------------------- */
async function serveFile(res, file, req) {
  try {
    const st = await stat(file);
    if (!st.isFile()) return json(res, 404, { error: 'not a file' });
    const ext = path.extname(file).toLowerCase();
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' };
    if (ext === '.mp4' || ext === '.mov') {
      headers['accept-ranges'] = 'bytes';
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m?.[1] ? Number(m[1]) : 0;
        const end = m?.[2] ? Number(m[2]) : st.size - 1;
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
        return createReadStream(file, { start, end }).pipe(res);
      }
      headers['content-length'] = st.size;
      res.writeHead(200, headers);
      return createReadStream(file).pipe(res);
    }
    headers['content-length'] = st.size;
    res.writeHead(200, headers);
    return createReadStream(file).pipe(res);
  } catch { json(res, 404, { error: 'not found' }); }
}

async function resumeProduce() {
  if (currentProduce) return { code: 409, body: { error: `已有生产任务在跑（${currentProduce.project}）` } };
  const st = await loadProduceState();
  if (!st || !st.project || !existsSync(path.join(ROOT, st.project))) return { code: 404, body: { error: '没有可续跑的生产记录' } };
  const dir = path.join(ROOT, st.project);
  const ac = new AbortController();
  const prov = await activeProvider();
  const stagesDone = Array.isArray(st.stagesDone) ? [...st.stagesDone] : [];
  const startedAt = st.startedAt || Date.now();
  currentProduce = { project: st.project, dir, abort: ac, stage: '续跑', startedAt: Date.now() };
  await logProduce({ type: 'manual_resume', project: st.project, stage: st.stage || null, stagesDone });
  const baseState = () => ({ ...st, startedAt, stagesDone: [...stagesDone], options: st.options || {} });
  const onEvent = (e) => {
    if (currentProduce) currentProduce.lastEventAt = Date.now();
    if (e.type === 'stage_start') { currentProduce.stage = e.label; saveProduceState({ ...baseState(), stage: e.label }); }
    if (e.type === 'stage_done') { if (!stagesDone.includes(e.id)) stagesDone.push(e.id); saveProduceState({ ...baseState(), stage: e.label, lastDone: e.id, autoResumes: 0 }); }
    if (e.type === 'produce_done') { currentProduce = null; logProduce({ project: st.project, ...e }); if (!e.error && !e.failed) clearProduceState(); }
    if (['stage_start', 'stage_done', 'stage_error', 'stage_cancelled', 'stage_retry', 'log', 'stage_skip', 'agent_done'].includes(e.type)) logProduce({ project: st.project, ...e });
    broadcast({ type: 'produce', event: e, project: st.project });
  };
  produce({
    project: dir, novelPath: novelOf(dir),
    episodes: st.episodes || 1, seconds: st.seconds || 120,
    genre: st.genre || '国风奇幻', style: st.style || '',
    aspect: st.aspect || '9:16', resolution: st.resolution || '720p',
    // 续跑不再强制重跑前期：已完成的阶段本来就会跳过，forcePre 只会把好产物再盖一遍
    options: { ...(st.options || {}), forcePre: false }, only: st.only || null, scopeEps: st.scopeEps || null,
    onEvent, signal: ac.signal, provider: prov,
  }).catch((err) => { logProduce({ type: 'produce_crash', project: st.project, error: String(err?.message || err) }); broadcast({ type: 'produce', event: { type: 'produce_done', error: String(err?.message || err) }, project: st.project }); })
    .finally(() => { currentProduce = null; });
  return { code: 200, body: { ok: true, project: st.project, resumedFrom: st.stage || null } };
}

const server = http.createServer(async (req, res) => {
  if (process.env.DSH_DESKTOP === '1' && process.env.DSH_SESSION_TOKEN && req.headers['x-studio-session'] !== process.env.DSH_SESSION_TOKEN) {
    return json(res, 403, { error: '请从桌面软件访问' });
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(UI, 'index.html'), req);
    if (p.startsWith('/ui/')) {
      const f = safeJoin(UI, p.slice(4));
      return f ? serveFile(res, f, req) : json(res, 403, { error: 'forbidden' });
    }
    if (p.startsWith('/presets/')) {
      const f = safeJoin(PRESET_DIR, p.slice('/presets/'.length));
      return f ? serveFile(res, f, req) : json(res, 403, { error: 'forbidden' });
    }
    if (p.startsWith('/media/')) {
      const rest = decodeURIComponent(p.slice(7));
      const f = safeJoin(ROOT, rest);
      return f ? serveFile(res, f, req) : json(res, 403, { error: 'forbidden' });
    }
    if (p === '/api/version') {
      let v = 0;
      try { for (const f of readdirSync(UI)) if (/\.(js|css|html)$/i.test(f)) v = Math.max(v, statSync(path.join(UI, f)).mtimeMs); } catch {}
      return json(res, 200, { ui: Math.round(v), boot: Math.round(serverStartedAt), pid: process.pid });
    }
    if (p === '/api/projects' && req.method === 'GET') return json(res, 200, await listProjects());
    if (p === '/api/project') {
      const name = url.searchParams.get('p');
      const st = name ? await projectState(name) : null;
      return st ? json(res, 200, st) : json(res, 404, { error: '项目不存在' });
    }
    if (p === '/api/run' && req.method === 'POST') {
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      if (active) return json(res, 409, { error: '已有任务在跑', job: { id: active.id, label: active.label } });
      const GPU_TASKS = ['scenes', 'characters', 'frames', 'videos', 'upscale'];
      if (currentProduce && GPU_TASKS.includes(String(body.task))) {
        return json(res, 409, { error: `一键生产正在跑（${currentProduce.project} · ${currentProduce.stage || '准备中'}），等它结束再手动补产，否则会抢 GPU` });
      }
      // 「范围」选到某一集时，手动补产也按该集的分段过滤
      let extraArgs = Array.isArray(body.args) ? body.args : [];
      const scopeEps = Array.isArray(body.scopeEps) && body.scopeEps.length ? body.scopeEps.map(Number) : null;
      if (scopeEps && ['frames', 'videos', 'upscale'].includes(String(body.task))) {
        try {
          const pdir = path.join(ROOT, String(body.p || '').trim());
          const sbFile = readdirSync(path.join(pdir, 'storyboard')).find((f) => /-storyboard\.json$/.test(f));
          const base = sbFile ? sbFile.replace(/-storyboard\.json$/, '') : path.basename(pdir);
          const segs = scopeSegIds(pdir, base, scopeEps);
          if (segs && segs.length) {
            if (body.task === 'frames') extraArgs = ['--seg', segs.join(',')];
            else extraArgs = ['--only', String(body.task) === 'upscale' ? segs[0] : segs.join(',')];
          }
        } catch {}
      }
      const job = runJob({ project: body.p, task: body.task, extraArgs });
      return json(res, 200, { job: { id: job.id, label: job.label } });
    }
    if (p === '/api/cancel' && req.method === 'POST') {
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      if (active && (!body.jobId || body.jobId === active.id) && active.child) {
        active.child.kill('SIGTERM');
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: '没有可取消的任务' });
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      if (active) { res.write(`data: ${JSON.stringify({ type: 'log', id: active.id, line: `（连接时任务进行中：${active.label}，已产生 ${active.lines.length} 行日志）` })}\n\n`); }
      const fn = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
      listeners.add(fn);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); listeners.delete(fn); });
      return;
    }
    if (p === '/api/comfy') {
      const t0 = Date.now();
      try {
        const [q, sys] = await Promise.all([comfyGetRetry('/queue'), comfyGetRetry('/system_stats')]);
        const dev = sys.devices?.[0] || {};
        return json(res, 200, {
          ok: true, latencyMs: Date.now() - t0,
          running: q.queue_running?.length || 0, pending: q.queue_pending?.length || 0,
          vramFree: dev.vram_free, vramTotal: dev.vram_total, name: dev.name,
        });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e), latencyMs: Date.now() - t0, target: COMFY });
      }
    }
    if (p === '/api/comfy/ping' && req.method === 'POST') {
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      let tgt = String(body.url || '').trim();
      if (!tgt) return json(res, 200, { ok: false, error: '地址为空' });
      if (!/^https?:\/\//i.test(tgt)) tgt = 'http://' + tgt;
      tgt = tgt.replace(/\/+$/, '');
      const t0 = Date.now();
      try {
        await comfyGetJson('/system_stats', 4000, tgt);
        return json(res, 200, { ok: true, latencyMs: Date.now() - t0, target: tgt });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e), latencyMs: Date.now() - t0, target: tgt });
      }
    }
    if (p === '/api/chat' && req.method === 'POST') {
      if (currentChat) {
        const quietMs = Date.now() - (currentChat.lastEventAt || currentChat.startedAt);
        if (currentChat.abort?.signal?.aborted || quietMs > 5 * 60000) { try { currentChat.abort?.abort(); } catch {} currentChat = null; }
        else return json(res, 409, { error: '助手正在回复，稍等' });
      }
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      const name = String(body.p || '').trim();
      const message = String(body.message || '').trim();
      if (!name || !message) return json(res, 400, { error: '缺少项目或消息' });
      const dir = path.join(ROOT, name);
      if (!existsSync(dir)) return json(res, 404, { error: '项目不存在' });
      const hist = await loadChatHistory(name);
      hist.push({ role: 'user', content: message });
      const ac = new AbortController();
      currentChat = { project: name, abort: ac, startedAt: Date.now() };
      const send = (event) => { if (currentChat) currentChat.lastEventAt = Date.now(); broadcast({ type: 'chat', event, project: name }); };
      send({ type: 'chat_start', project: name });
      const system = await buildChatSystem(name, dir);
      const chatProv = await activeProvider();
      runAgent({
        systemPrompt: system,
        task: message,
        history: hist.slice(0, -1),
        workdir: dir,
        maxTurns: Number(body.maxTurns) || 80,
        maxTokens: Number(chatProv.maxTokens) || 8000,
        provider: chatProv,
        onEvent: (e) => send(e),
        signal: ac.signal,
        label: '助手',
      }).then(async (r) => {
        hist.push({ role: 'assistant', content: String(r.content || '').slice(0, 8000) });
        await appendChatLog(dir, [{ role: 'user', content: message }, { role: 'assistant', content: r.content }]);
        send({ type: 'chat_done', content: r.content, truncated: !!r.truncated, turns: r.turns });
      }).catch((err) => {
        hist.pop(); // 失败时撤回用户消息，允许重发
        send({ type: 'chat_done', error: String(err?.message || err) });
      }).finally(() => { currentChat = null; });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/chat/cancel' && req.method === 'POST') {
      if (!currentChat) return json(res, 404, { error: '没有进行中的对话' });
      currentChat.abort.abort();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/produce/log') {
      const n = Math.min(Number(url.searchParams.get('lines')) || 80, 500);
      try {
        const raw = await readFile(PRODUCE_LOG, 'utf8');
        const lines = raw.trim().split('\n').slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
        return json(res, 200, { lines });
      } catch { return json(res, 200, { lines: [] }); }
    }
    if (p === '/api/chat/history') {
      const name = url.searchParams.get('p');
      if (!name) return json(res, 400, { error: '缺少项目' });
      return json(res, 200, { messages: await loadChatHistory(name) });
    }
    if (p === '/api/chat/clear' && req.method === 'POST') {
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      CHAT.history.delete(String(body.p || ''));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/produce' && req.method === 'POST') {
      if (active) return json(res, 409, { error: `手动任务正在跑（${active.label}），等它结束再一键生成` });
      if (currentProduce) {
        return json(res, 409, { error: `已有生产任务在跑（${currentProduce.project} · ${currentProduce.stage || '准备中'}），请等待完成或先停止任务` });
      }
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      const projName = String(body.p || body.name || '').trim();
      if (!projName) return json(res, 400, { error: '缺少项目' });
      let dir = path.join(ROOT, projName);
      if (!existsSync(dir)) {
        if (!body.name) return json(res, 404, { error: '项目不存在' });
        dir = await ensureProject(body.name, { novelText: body.novelText });
      }
      // 老项目补齐 scripts 模板与元数据，避免生产阶段因缺脚本直接失败
      try {
        const tpl = TEMPLATE_PROJECT ? path.join(TEMPLATE_PROJECT, 'scripts') : null;
        if (tpl && existsSync(tpl) && !existsSync(path.join(dir, 'scripts', 'gen_videos.mjs'))) {
          await cp(tpl, path.join(dir, 'scripts'), { recursive: true });
        }
        if (!existsSync(metaPath(dir))) {
          const ol = await readJson(path.join(dir, 'outline', `${projName}-outline.json`));
          const epsIdx = (await readdir(path.join(dir, 'outline')).catch(() => [])).find((f) => f.endsWith('.json'));
          const ol2 = ol || (epsIdx ? await readJson(path.join(dir, 'outline', epsIdx)) : null);
          await writeFile(metaPath(dir), JSON.stringify({
            name: projName, title: projName, legacy: true,
            genre: ol2?.params?.genre || null, style: null,
            aspect: '9:16', resolution: '720p',
            episodes: ol2?.params?.episodes || 1,
            secondsPerEpisode: ol2?.params?.minutesPerEpisode ? ol2.params.minutesPerEpisode * 60 : 120,
            createdAt: new Date().toISOString(),
          }, null, 2), 'utf8');
        }
      } catch {}
      const meta = await readMeta(dir);
      const wantEp = Number(body.episodes) || Number(meta.episodes) || 1;
      const wantSec = Number(body.seconds) || Number(meta.secondsPerEpisode) || 120;
      const aspect = body.aspect || meta.aspect || '9:16';
      const resolution = body.resolution || meta.resolution || '720p';
      const ac = new AbortController();
      currentProduce = { project: projName, dir, abort: ac, stage: '准备中', startedAt: Date.now() };
      await logProduce({ type: 'produce_start', project: projName, episodes: wantEp, seconds: wantSec, aspect, resolution, options: body.options, only: body.only || null });
      await saveProduceState({ project: projName, dir, episodes: wantEp, seconds: wantSec, aspect, resolution, options: body.options || {}, only: body.only || null, startedAt: Date.now(), stage: '准备中', scopeEps: body.scopeEps || null });
      const prov = await activeProvider();
      const stagesDone = [];
      const baseState = () => ({ project: projName, dir, episodes: wantEp, seconds: wantSec, genre: body.genre || meta.genre || '', style: body.style || meta.style || '', aspect, resolution, options: body.options || {}, only: body.only || null, startedAt: currentProduce ? currentProduce.startedAt : Date.now(), scopeEps: body.scopeEps || null, stagesDone: [...stagesDone] });
      const onEvent = (e) => {
        if (currentProduce) currentProduce.lastEventAt = Date.now();
        if (e.type === 'stage_start') { currentProduce.stage = e.label; saveProduceState({ ...baseState(), stage: e.label }); }
        if (e.type === 'stage_done') { if (!stagesDone.includes(e.id)) stagesDone.push(e.id); saveProduceState({ ...baseState(), stage: e.label, lastDone: e.id, autoResumes: 0 }); }
        if (e.type === 'produce_done') {
          currentProduce = null;
          logProduce({ project: projName, ...e });
          if (!e.error && !e.failed) clearProduceState();
        }
        if (['stage_start', 'stage_done', 'stage_error', 'stage_cancelled', 'stage_retry', 'log', 'stage_skip', 'agent_done'].includes(e.type)) logProduce({ project: projName, ...e });
        broadcast({ type: 'produce', event: e, project: projName });
      };
      produce({
        project: dir,
        novelPath: novelOf(dir),
        episodes: wantEp,
        seconds: wantSec,
        genre: body.genre || meta.genre || '国风奇幻',
        style: body.style || meta.style || '国风动画·赛璐璐（漫剧向）',
        aspect, resolution,
        options: body.options || {},
        only: body.only || null,
        scopeEps: Array.isArray(body.scopeEps) && body.scopeEps.length ? body.scopeEps : null,
        onEvent,
        signal: ac.signal,
        provider: prov,
      }).catch((err) => { logProduce({ type: 'produce_crash', project: projName, error: String(err?.message || err) }); broadcast({ type: 'produce', event: { type: 'produce_done', error: String(err?.message || err) }, project: projName }); })
        .finally(() => { currentProduce = null; });
      return json(res, 200, { ok: true, project: projName });
    }
    if (p === '/api/produce/last') {
      const st = await loadProduceState();
      return json(res, 200, st ? { interrupted: true, ...st } : { interrupted: false });
    }

    if (p === '/api/produce/resume' && req.method === 'POST') {
      const r = await resumeProduce();
      return json(res, r.code, r.body);
    }
    if (p === '/api/produce/plan' && req.method === 'POST') {
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      const projName = String(body.p || body.name || '').trim();
      if (!projName) return json(res, 400, { error: '缺少项目' });
      const dir = path.join(ROOT, projName);
      if (!existsSync(dir)) return json(res, 404, { error: '项目不存在' });
      const meta = await readMeta(dir);
      const wantEp = Number(body.episodes) || Number(meta.episodes) || 1;
      const wantSec = Number(body.seconds) || Number(meta.secondsPerEpisode) || 120;
      try {
        const plan = previewPlan({
          project: dir,
          novelPath: novelOf(dir),
          episodes: wantEp,
          seconds: wantSec,
          genre: body.genre || meta.genre || '国风奇幻',
          style: body.style || meta.style || '国风动画·赛璐璐（漫剧向）',
          aspect: body.aspect || meta.aspect || '9:16',
          resolution: body.resolution || meta.resolution || '720p',
          options: body.options || {},
          only: body.only || null,
          scopeEps: Array.isArray(body.scopeEps) && body.scopeEps.length ? body.scopeEps : null,
        });
        return json(res, 200, { ok: true, ...plan });
      } catch (e) {
        return json(res, 500, { error: String(e?.message || e) });
      }
    }
    if (p === '/api/produce/cancel' && req.method === 'POST') {
      if (!currentProduce) return json(res, 404, { error: '没有生产任务' });
      currentProduce.abort.abort();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/produce/state') {
      if (currentProduce) {
        const quietMs = Date.now() - (currentProduce.lastEventAt || currentProduce.startedAt);
        // Video inference may be silent for many minutes. Reading status never cancels it.
        return json(res, 200, { running: true, stopping: !!currentProduce.abort?.signal?.aborted, project: currentProduce.project, stage: currentProduce.stage, startedAt: currentProduce.startedAt, quietMs });
      }
      return json(res, 200, { running: false });
    }
    if (p === '/api/settings' && req.method === 'GET') {
      return json(res, 200, await publicProviders());
    }
    if (p === '/api/settings/workflow-defaults' && req.method === 'GET') {
      return json(res, 200, { workflows: getDefaultWorkflows() });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      const cur = await loadProviders();
      if (body.active) cur.active = body.active;
      if (Array.isArray(body.providers)) {
        for (const inP of body.providers) {
          const t = cur.providers.find((x) => x.id === inP.id);
          if (!t) continue;
          for (const k of ['label', 'protocol', 'baseUrl', 'model', 'keyEnv', 'reasoningEffort', 'maxTokens', 'note']) {
            if (inP[k] !== undefined) t[k] = inP[k];
          }
          if (inP.apiKey) t.apiKey = inP.apiKey;          // 空表示不改
          if (inP.clearKey) t.apiKey = '';
        }
      }
      await saveProviders(cur);
      if (body.comfy && typeof body.comfy === 'object') {
        try { COMFY = await saveComfyUrl(body.comfy.url, body.comfy.workflows); console.log('[settings] ComfyUI 配置已保存'); }
        catch (e) { return json(res, 200, { ok: false, error: `ComfyUI：${e.message}` }); }
      }
      return json(res, 200, { ok: true, ...(await publicProviders()) });
    }
    if (p === '/api/settings/test' && req.method === 'POST') {
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      const r = await testProvider(body.id);
      return json(res, 200, r);
    }
    if (p === '/api/settings/active') {
      const a = await activeProvider();
      return json(res, 200, { id: a.id, label: a.label, model: a.model, protocol: a.protocol, baseUrl: a.baseUrl });
    }
    if (p === '/api/novels') {
      const dl = path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
      let out = [];
      try {
        out = (await readdir(dl)).filter((f) => /\.(txt|md)$/i.test(f)).map((f) => ({ name: f, path: path.join(dl, f) })).slice(0, 40);
      } catch {}
      return json(res, 200, out);
    }
    if (p === '/api/presets') {
      const list = (arr, prefix = '') => arr.map(([id, label]) => ({ id, label, img: `/presets/${prefix}${id}.png` }));
      return json(res, 200, {
        genres: list(PRESETS.genres), styles: list(PRESETS.styles, 'style-'),
        aspects: PRESETS.aspects.map(([id, label]) => ({ id, label })),
        resolutions: PRESETS.resolutions.map(([id, label]) => ({ id, label })),
      });
    }
    if (p === '/api/parse-script' && req.method === 'POST') {
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      let text = String(body.text || '');
      if (!text && body.path) {
        const f = path.isAbsolute(body.path) ? body.path : path.join(ROOT, body.path);
        try { text = await readFile(f, 'utf8'); } catch {}
      }
      if (!text.trim()) return json(res, 200, { episodes: [], detected: false });
      const eps = splitEpisodes(text);
      return json(res, 200, { detected: eps.detected, total: eps.list.length, episodes: eps.list.map((e) => ({ no: e.no, title: e.title, chars: e.text.length, preview: e.text.slice(0, 60).replace(/\s+/g, ' ') })) });
    }
    if (p === '/api/projects' && req.method === 'POST') {
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      const title = String(body.title || '').trim();
      if (!title) return json(res, 400, { error: '缺少剧名' });
      const dir = await ensureProject(title, { novelText: body.novelText });
      // 梗概模式：单独存档，并作为“原文”喂给情节/大纲/剧本阶段
      if (body.brief) {
        await writeFile(path.join(dir, 'docs', 'story-brief.md'), `# 故事梗概\n\n${String(body.brief).trim()}\n`, 'utf8');
      }
      // 取正文：梗概 > 粘贴 > 文件
      let novel = String(body.brief || body.novelText || '');
      if (!novel && body.novelPath) {
        const src = path.isAbsolute(body.novelPath) ? body.novelPath : path.join(ROOT, body.novelPath);
        if (existsSync(src)) { await cp(src, path.join(dir, 'docs/编剧-原稿.txt')); novel = await readFile(path.join(dir, 'docs/编剧-原稿.txt'), 'utf8'); }
      }
      if (!novel) { try { novel = await readFile(path.join(dir, 'docs/编剧-原稿.txt'), 'utf8'); } catch {} }
      // 自动分集
      const parsed = novel.trim() ? splitEpisodes(novel) : { detected: false, list: [] };
      const eps = parsed.list.length ? parsed.list : [{ no: 1, title: '全篇', text: '' }];
      const srcDir = path.join(dir, 'docs', 'sources');
      await mkdir(srcDir, { recursive: true });
      for (const e of eps) {
        await writeFile(path.join(srcDir, `E${String(e.no).padStart(2, '0')}.txt`), e.text || novel, 'utf8');
      }
      const meta = {
        name: title, title,
        genre: body.genre || null, style: body.style || null,
        aspect: body.aspect || '9:16',
        resolution: body.resolution || '720p',
        episodes: parsed.detected ? eps.length : (Number(body.episodes) || 1),
        secondsPerEpisode: Number(body.seconds) || 120,
        autoSplit: parsed.detected,
        source: body.source || (body.brief ? 'brief' : 'text'),
        createdAt: new Date().toISOString(),
        cover: body.cover || (body.style ? `/presets/style-${body.style}.png` : null),
      };
      await writeFile(metaPath(dir), JSON.stringify(meta, null, 2), 'utf8');
      return json(res, 200, { ok: true, project: meta, detected: parsed.detected, episodes: eps.length });
    }
    if (p === '/api/episodes') {
      const name = url.searchParams.get('p');
      const rows = name ? await episodeRows(name) : null;
      return rows ? json(res, 200, rows) : json(res, 404, { error: '项目不存在' });
    }
    if (p === '/api/episode/synopsis' && req.method === 'PUT') {
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      const dir = path.join(ROOT, body.p || '');
      if (!existsSync(dir)) return json(res, 404, { error: '项目不存在' });
      const epTag = `E${String(body.ep || 1).padStart(2, '0')}`;
      const synDir = path.join(dir, 'docs', 'synopses');
      await mkdir(synDir, { recursive: true });
      await writeFile(path.join(synDir, `${epTag}.md`), `# 第 ${body.ep} 集梗概\n\n${String(body.text || '')}\n`, 'utf8');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/episode/generate' && req.method === 'POST') {
      if (currentProduce) return json(res, 409, { error: '已有任务在跑' });
      const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b || '{}')); }));
      const dir = path.join(ROOT, body.p || '');
      if (!existsSync(dir)) return json(res, 404, { error: '项目不存在' });
      const ac = new AbortController();
      const meta = await readMeta(dir);
      const wantEp = Number(body.ep) || 1;
      if (wantEp > (Number(meta.episodes) || 0)) {
        meta.episodes = wantEp;
        await writeFile(metaPath(dir), JSON.stringify(meta, null, 2), 'utf8');
      }
      currentProduce = { project: body.p, dir, abort: ac, stage: `${body.action === 'continue' ? '续写' : '写剧本'} E${String(body.ep).padStart(2, '0')}`, startedAt: Date.now() };
      const send = (event) => broadcast({ type: 'produce', event, project: body.p });
      send({ type: 'produce_start', total: 1, project: body.p });
      runEpisodeAction({
        project: dir, ep: Number(body.ep) || 1,
        action: body.action === 'continue' ? 'continue' : 'script',
        synopsisText: body.synopsis || '',
        seconds: Number(body.seconds) || meta.secondsPerEpisode || 120,
        onEvent: send, signal: ac.signal,
      }).then((r) => send({ type: 'produce_done', ms: r?.ms || 0, done: 1, total: 1 }))
        .catch((err) => send({ type: 'produce_done', error: String(err?.message || err) }))
        .finally(() => { currentProduce = null; });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/active') return json(res, 200, active ? { id: active.id, label: active.label, project: active.project } : {});
    if (p === '/api/run/last') {
      try { return json(res, 200, JSON.parse(readFileSync(MANUAL_LAST, 'utf8'))); } catch { return json(res, 200, null); }
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
});

// 收到终止信号时记录，避免“生产跑着跑着没了”且无迹可查
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try {
      await logProduce({ type: 'server_stop', signal: sig, produce: currentProduce?.project || null, stage: currentProduce?.stage || null });
      const st = await loadProduceState();
      if (st && st.project) await saveProduceState({ ...st, interruptedAt: Date.now(), interruptedStage: currentProduce?.stage || st.stage || null });
    } catch {}
    try { currentProduce?.abort?.abort(); } catch {}
    try { currentChat?.abort?.abort(); } catch {}
    setTimeout(() => process.exit(0), 300);
  });
}


function rotateIfBig(file, limitBytes) {
  try {
    if (existsSync(file) && statSync(file).size > limitBytes) {
      const bak = file + '.1';
      try { if (existsSync(bak)) unlinkSync(bak); } catch {}
      renameSync(file, bak);
      console.log(`[log] ${path.basename(file)} 超过 ${Math.round(limitBytes / 1048576)}MB，已轮转为 ${path.basename(bak)}`);
    }
  } catch {}
}
rotateIfBig(path.join(LOG_DIR, 'produce.log'), 8 * 1048576);
rotateIfBig(path.join(LOG_DIR, 'crash.log'), 2 * 1048576);

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[fatal] 端口 ${PORT} 已经被占用：多半是已经有一个 Studio 实例在跑（launchd 和 restart.sh 各起了一个）。`);
    console.error('[fatal] 本进程直接退出，不再进入 launchd 重启循环。要重启请用 studio/restart.sh。');
    process.exit(0);
  }
  console.error('[fatal] 服务启动失败：', err);
  process.exit(1);
});

function killOrphanWorkers() {
  let killed = 0;
  try {
    const out = execSync('ps -axo pid=,command=', { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]); const cmd = m[2];
      if (!pid || pid === process.pid) continue;
      if (!cmd.includes(__dirname)) continue;
      if (!/\/(gen_(scenes|characters|frames|videos|upscale)|report)\.mjs/.test(cmd)) continue;
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
      killed++;
      console.log(`[boot] 清理上次遗留的子进程 pid=${pid}`);
    }
  } catch {}
  return killed;
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`漫剧工坊 Studio → http://127.0.0.1:${PORT}`);
  const orphans = process.env.DSH_DESKTOP === '1' ? 0 : killOrphanWorkers();
  if (orphans) {
    // 上一次崩溃留下的出图/出片任务不清掉会一直霸占 ComfyUI 队列
    fetch(`${COMFY}/interrupt`, { method: 'POST' }).catch(() => {});
    fetch(`${COMFY}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clear: true }) }).catch(() => {});
    logProduce({ type: 'boot_orphans_cleared', count: orphans });
  }
  console.log(`项目根目录: ${ROOT}`);
  console.log(`ComfyUI: ${COMFY}`);
  if (process.send) process.send({ type: 'ready', port: server.address().port });
  // 开机自动接着跑：服务崩溃/重启后不需要人再点一次。
  // 最多自动续 3 次（记录在 state 里），连续失败就停下等人工，避免无限重启循环。
  if (process.env.STUDIO_AUTO_RESUME !== '0') setTimeout(() => { autoResumeOnBoot().catch(() => {}); }, 6000);
});

async function autoResumeOnBoot() {
  const st = await loadProduceState().catch((e) => { console.error('[resume] state read failed:', e.message); return null; });
  if (!st || !st.project) return;
  const n = Number(st.autoResumes || 0);
  if (n >= 3) { await logProduce({ type: 'auto_resume_giveup', project: st.project, tries: n, stage: st.stage || null }); console.log('[resume] 已自动续跑 3 次仍失败，等人工处理'); return; }
  await saveProduceState({ ...st, autoResumes: n + 1 });
  await logProduce({ type: 'auto_resume', project: st.project, stage: st.stage || null, try: n + 1 });
  console.log(`[resume] 检测到未完成生产（${st.project} · ${st.stage || '准备中'}），自动续跑第 ${n + 1} 次`);
  broadcast({ type: 'produce', project: st.project, event: { type: 'log', line: `↻ 服务重启后自动续跑（上次停在：${st.stage || '准备中'}，第 ${n + 1} 次）` } });
  try {
    const r = await resumeProduce();
    if (r.code !== 200) { console.log('[resume] 续跑未启动：', JSON.stringify(r.body)); await logProduce({ type: 'auto_resume_rejected', project: st.project, body: r.body }); }
  } catch (e) {
    console.log('[resume] 自动续跑异常：', String(e?.stack || e));
    await logProduce({ type: 'auto_resume_error', project: st.project, error: String(e?.stack || e).slice(0, 800) });
  }
}
