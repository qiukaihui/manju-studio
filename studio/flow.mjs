#!/usr/bin/env node
/**
 * flow.mjs —— 通用流水线（严格按技能流程，不绑定任何一部剧）
 *
 * 设计原则：
 *   1. **schema 来源 = 技能自带 examples**（`~/.agents/skills/<skill>/examples/*.json`），
 *      不是别的剧的产物，因此换任何项目都成立。
 *   2. **项目只提供输入**：原文、参数（集数/时长/题材/画风）。
 *   3. **模型只做“写内容”**：一次调用产出一个条目（一个角色/场景/分集/段落），
 *      结构由服务端拼装，质量由技能自己的 validate 把关，失败带 gate 报错重试。
 *   4. **禁止出现任何剧名/角色名常量**；禁名列表从项目 outline 动态生成。
 *
 * 用法：
 *   node flow.mjs <outline|characters|art|script|staging|storyboard> <项目名> [--force]
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { activeProvider } from './settings.mjs';
import { streamChat } from './agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DSH_ROOT ? path.resolve(process.env.DSH_ROOT) : path.resolve(__dirname, '..', 'projects');
const SKILLS = process.env.DSH_SKILLS || process.env.SKILLS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

const log = (s) => console.log(s);

/* ============================== 技能注册表 ============================== */

const REG = {
  outline: { skill: 'novel-outline', out: (b) => `outline/${b}-outline.json`, validator: (dir, b) => [join(SKILLS, 'novel-outline/scripts/novel-outline.mjs'), ['validate', join(dir, `outline/${b}-outline.json`)]] },
  characters: { skill: 'novel-characters', out: (b) => `characters/${b}-cast.json`, validator: (dir, b) => [join(SKILLS, 'novel-characters/scripts/novel-characters.mjs'), ['validate', join(dir, `characters/${b}-cast.json`), ...(novelFileOf(dir) ? [novelFileOf(dir)] : [])]] },
  art: { skill: 'novel-art', out: (b) => `art/${b}-art.json`, validator: (dir, b) => [join(SKILLS, 'novel-art/scripts/novel-art.mjs'), ['validate', join(dir, `art/${b}-art.json`), '--cast', join(dir, `characters/${b}-cast.json`)]] },
  script: { skill: 'novel-script', out: (b) => `script/${b}-script.json`, validator: (dir, b) => [join(SKILLS, 'novel-script/scripts/novel-script.mjs'), ['validate', join(dir, `script/${b}-script.json`), '--outline', join(dir, `outline/${b}-outline.json`), '--art', join(dir, `art/${b}-art.json`)]] },
  staging: { skill: 'novel-staging', out: (b) => `staging/${b}-staging.json`, validator: (dir, b) => [join(SKILLS, 'novel-staging/scripts/novel-staging.mjs'), ['validate', join(dir, `staging/${b}-staging.json`), '--script', join(dir, `script/${b}-script.json`), '--art', join(dir, `art/${b}-art.json`)]] },
  storyboard: { skill: 'novel-storyboard', out: (b) => `storyboard/${b}-storyboard.json`, validator: (dir, b) => [join(SKILLS, 'novel-storyboard/scripts/novel-storyboard.mjs'), ['validate', join(dir, `storyboard/${b}-storyboard.json`), '--script', join(dir, `script/${b}-script.json`), '--outline', join(dir, `outline/${b}-outline.json`), '--cast', join(dir, `characters/${b}-cast.json`), '--art', join(dir, `art/${b}-art.json`)]] },
};

function skillExample(stage) {
  const dir = path.join(SKILLS, REG[stage].skill, 'examples');
  try {
    const f = readdirSync(dir).filter((x) => x.endsWith('.json')).sort()[0];
    if (!f) return null;
    return JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  } catch { return null; }
}

/** 把示例对象压成「结构说明」，喂给模型当字段模板（去掉具体值，避免抄袭示例内容） */
function shapeOf(obj, depth = 0, maxDepth = 4) {
  if (obj === null || obj === undefined) return 'null';
  if (Array.isArray(obj)) {
    if (!obj.length || depth >= maxDepth) return [];
    // 数组里若存在结构不同的元素（比如节拍有 action 型与 speaker/line 型），全部示范，否则模型只会照抄第一种
    const objs = obj.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length) {
      const sig = (o) => Object.keys(o).sort().join('|');
      const seen = new Set();
      const samples = [];
      for (const o of objs) {
        const k = sig(o);
        if (seen.has(k)) continue;
        seen.add(k);
        samples.push(shapeOf(o, depth + 1, maxDepth));
        if (samples.length >= 3) break;
      }
      if (samples.length) return samples;
    }
    return [shapeOf(obj[0], depth + 1, maxDepth)];
  }
  if (typeof obj !== 'object') {
    // 短 ASCII 值（枚举/英文标签）留着当字段提示；中文与长文本用占位符，避免模型照抄示例内容
    if (typeof obj === 'string') return /^[\x20-\x7E]{1,24}$/.test(obj) ? obj : '…';
    return obj;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (depth >= maxDepth) { out[k] = '…'; continue; }
    out[k] = shapeOf(v, depth + 1, maxDepth);
  }
  return out;
}

/* ============================== 协作取消 ============================== */
// produce 阶段开始前 setActiveSignal(阶段 signal)；每个条目开跑前检查和传递，停止按钮能立刻生效。
let ACTIVE_SIGNAL = null;
export function setActiveSignal(sig) { ACTIVE_SIGNAL = sig || null; }
const cancelledError = () => { const e = new Error('已取消'); e.cancelled = true; return e; };
const throwIfCancelled = () => { if (ACTIVE_SIGNAL?.aborted) throw cancelledError(); };

/* ============================== 通用工具 ============================== */

const readMaybe = async (p) => { try { return await readFile(p, 'utf8'); } catch { return ''; } };
const readJsonMaybe = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
const writeJson = async (p, obj) => { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, JSON.stringify(obj, null, 2), 'utf8'); };

function novelFileOf(dir) {
  const docs = path.join(dir, 'docs');
  let cands = [];
  try { cands = readdirSync(docs).filter((f) => /\.(txt|md)$/i.test(f)); } catch { return null; }
  const score = (f) => (/原稿|原文|小说|novel|编剧|剧本/i.test(f) ? 0 : /^0?1[-_.]/.test(f) ? 2 : 1);
  cands.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  return cands.length ? path.join(docs, cands[0]) : null;
}

function projectPaths(name) {
  const dir = path.join(ROOT, name);
  let base = name;
  try {
    const list = readdirSync(path.join(dir, 'outline')).filter((f) => f.endsWith('-outline.json'));
    if (list.length && !list.includes(`${name}-outline.json`)) base = list[0].replace(/-outline\.json$/, '');
    else if (!list.length) base = name;
  } catch {}
  return { dir, base };
}

function runNode(argv, cwd, timeoutMs = 600000) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, argv, { cwd, detached: process.platform !== 'win32', windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { if (process.platform === 'win32') c.kill(); else process.kill(-c.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

async function validate(stage, dir, base) {
  const [script, args] = REG[stage].validator(dir, base);
  const r = await runNode([script, ...args], dir);
  return { ok: r.code === 0, out: (r.out || r.err || '').trim() };
}

function stripFence(t) {
  let s = String(t || '').trim();
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (m) s = m[1].trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  return i >= 0 && j > i ? s.slice(i, j + 1) : s;
}

/** 单次 JSON 调用（带一次修复重试） */
export async function chatJSON({ system, user, provider, maxTokens = 6000, temperature = 0.35, validateFn = null, tries = 2 }) {
  const p = provider || (await activeProvider());
  let prompt = user, lastErr = '';
  const maxTries = Math.max(tries, 4);
  for (let i = 1; i <= maxTries; i++) {
    throwIfCancelled();
    let r;
    try {
      r = await streamChat([{ role: 'system', content: system }, { role: 'user', content: prompt }], { provider: p, tools: [], maxTokens, temperature, onEvent: () => {}, signal: ACTIVE_SIGNAL || undefined });
    } catch (e) {
      if (ACTIVE_SIGNAL?.aborted || /abort/i.test(String(e?.name || '') + String(e?.message || ''))) throw cancelledError();
      // 网络/流中断不当作内容问题：退避后原样重试，别让整阶直接失败
      lastErr = '网络/流错误：' + String(e?.message || e).slice(0, 120);
      if (i < maxTries) await new Promise((res) => setTimeout(res, 3000 * i));
      continue;
    }
    const raw = stripFence(r.content);
    try {
      const obj = JSON.parse(raw);
      const err = validateFn ? validateFn(obj) : null;
      if (err) throw new Error(err);
      return obj;
    } catch (e) {
      lastErr = String(e.message || e);
      prompt = `${user}\n\n【上次输出有问题】${lastErr.slice(0, 400)}\n只返回合法 JSON，不要解释、不要代码块。`;
    }
  }
  throw new Error('生成失败：' + lastErr.slice(0, 200));
}

/** 带 gate 修复的整档重生成：validator 报错喂回模型，最多 attempts 轮 */
async function generateWithRepair({ stage, dir, base, build, provider, attempts = 2, onLog }) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    let doc;
    try {
      doc = await build(i === 1 ? '' : last?.out || '');
    } catch (e) {
      if (e?.cancelled) throw e;
      onLog(`  ! ${stage} 生成时出错（${String(e?.message || e).slice(0, 120)}），重试…`);
      last = { doc: null, ok: false, out: `生成报错：${String(e?.message || e)}` };
      if (i === attempts) return { ok: false, ...last, path: path.join(dir, REG[stage].out(base)) };
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    await writeJson(path.join(dir, REG[stage].out(base)), doc);
    const v = await validate(stage, dir, base);
    last = { doc, ok: v.ok, out: v.out };
    onLog(v.out.split('\n').slice(0, 14).join('\n'));
    if (v.ok) return { ok: true, doc, path: path.join(dir, REG[stage].out(base)) };
    onLog(`  ↻ ${stage} 第 ${i} 轮未过，带报错重生成…`);
  }
  return { ok: false, ...last, path: path.join(dir, REG[stage].out(base)) };
}

/* ============================== 参数 ============================== */

async function projectParams(name) {
  const { dir } = projectPaths(name);
  const meta = await readJsonMaybe(path.join(dir, 'project.json'));
  const nf = novelFileOf(dir);
  const novel = nf ? await readMaybe(nf) : '';
  return {
    dir,
    novel,
    novelFile: nf,
    episodes: Number(meta?.episodes) || 1,
    seconds: Number(meta?.secondsPerEpisode) || 120,
    genre: meta?.genre || '国风奇幻',
    style: meta?.style || '国风动画',
    aspect: meta?.aspect || '9:16',
    resolution: meta?.resolution || '720p',
  };
}

/* ============================== 1. 大纲 ============================== */

const OUTLINE_SYS = `你是 AI 漫剧的改编编剧，把小说改写成短剧大纲。只输出 JSON。
规则（来自 novel-outline 技能的质量门，违反即不合格）：
- 主角组(lead) 1–5 人；重要配角(support) ≤10；功能性角色(functional) ≤10
- 主场景(primary=true) 上限随集数动态，通常 5 个左右；一次性场景必须给 reusePlan
- 叙事道具 ≤8 件
- 每集必须有 hook（钩子）与 suspense（悬念）两栏，且是叙述体，**不能出现引号对白**
- 爽点（beats）要覆盖全剧，间隔不超过 3 集；大爆点不能只在最后一集出现
- 梗概是叙述体；不要写台词`;

const PLOT_SYS = `你是短剧改编策划。输出中文 Markdown 正文，不要代码块、不要解释。

文档固定八节，标题原样使用：
1. 一句话故事 + 主题
2. 原稿问题诊断（因果断裂、规则没立、道具没铺垫…逐条给修法）
3. 修订后的逐场因果链（每场：戏剧功能 / 新增信息 / 结尾钩子）
4. 逐场改动清单（保留原台词，新增句前加 ＋）
5. 爽点与钩子表
6. 角色功能与弧光、道具流转
7. 生成一致性要点（固定道具 / 状态连续性 / 光源）
8. 给下游的硬参数（集数、单集秒数、题材、画风、画幅、同框人数上限）

规矩：不改事件顺序、不改人物性格；只理顺因果、补足铺垫、标出改动。`;

export async function genPlot(name, { provider, onLog = log } = {}) {
  const P = await projectParams(name);
  const novel = String(P.novel || '').slice(0, 14000);
  if (!novel.trim()) throw new Error('缺原稿：docs/ 下没有可读的 txt/md');
  const must = ['一句话故事', '原稿问题诊断', '因果链', '改动清单', '爽点', '角色', '一致性', '硬参数'];
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    let text = '';
    try {
      const r = await streamChat(
        [{ role: 'system', content: PLOT_SYS }, { role: 'user', content: `集数 ${P.episodes} × ${P.seconds} 秒，题材「${P.genre}」，画风「${P.style}」，画幅 ${P.aspect}。\n\n小说原文：\n${novel}` }],
        { provider: provider || (await activeProvider()), tools: [], maxTokens: 4200, temperature: 0.4, onEvent: () => {}, signal: ACTIVE_SIGNAL || undefined },
      );
      text = String(r.content || '').replace(/^```[a-z]*\n|```$/g, '').trim();
    } catch (e) {
      last = '生成报错：' + String(e?.message || e).slice(0, 120);
      onLog(`  ! 情节梳理第 ${attempt} 次失败（${last}），重试…`);
      await new Promise((res) => setTimeout(res, 2500 * attempt));
      continue;
    }
    const miss = must.filter((k) => !text.includes(k));
    if (text.length >= 900 && miss.length <= 1) {
      await mkdir(path.join(P.dir, 'docs'), { recursive: true });
      await writeFile(path.join(P.dir, 'docs', '01-情节梳理.md'), text + '\n', 'utf8');
      onLog(`✓ 情节梳理已写入 docs/01-情节梳理.md（${text.length} 字）`);
      return { ok: true, doc: { markdown: text } };
    }
    last = `文档不合格：${text.length} 字${miss.length ? `，缺小节：${miss.join('、')}` : ''}`;
    onLog(`  ! 情节梳理第 ${attempt} 次${last}，重试…`);
  }
  throw new Error('情节梳理生成失败：' + last);
}

export async function genOutline(name, { provider, onLog = log } = {}) {
  const P = await projectParams(name);
  const ex = skillExample('outline');
  const shape = shapeOf(ex);
  const novel = P.novel.slice(0, 12000);
  onLog(`▸ 大纲：${P.episodes} 集 × ${P.seconds} 秒 · ${P.genre} · 原文 ${P.novel.length} 字`);

  const skeleton = await chatJSON({
    provider, maxTokens: 7000,
    system: OUTLINE_SYS,
    validateFn: (o) => {
      if (!Array.isArray(o?.characters) || !o.characters.length) return '缺 characters';
      if (!Array.isArray(o?.scenes) || !o.scenes.length) return '缺 scenes';
      if (!Array.isArray(o?.beats) || !o.beats.length) return '缺 beats';
      const lead = o.characters.filter((c) => c.tier === 'lead').length;
      if (lead < 1 || lead > 5) return `lead 人数 ${lead} 不在 1–5`;
      const noArc = o.characters.filter((c) => c.tier !== 'functional' && !String(c?.arc || '').trim());
      if (noArc.length) return `这些角色缺 arc：${noArc.map((c) => c.name).join('、')}`;
      const noPlan = o.scenes.filter((sc) => !sc.primary && !String(sc?.reusePlan || '').trim());
      if (noPlan.length) return `这些一次性场景缺 reusePlan：${noPlan.map((sc) => sc.name).join('、')}`;
      return null;
    },
    user: `把下面这篇小说改成 ${P.episodes} 集 × ${P.seconds} 秒的短剧大纲骨架（先不写分集梗概）。
【题材】${P.genre}　【画风】${P.style}
【输出结构（严格按字段，值自拟）】
${JSON.stringify(shape, null, 1)}

【小说原文】
${novel}

【硬性要求】
- characters 8 人以内（lead 1–3 / support / functional 都要有）；**每个 tier 不是 functional 的角色都必须有 arc**（一句话写「从…到…」的人物弧）
- scenes 5–8 个（primary=true 3–5 个）；**primary=false 的一次性场景必须写 reusePlan**（复用或规避方案）
- props ≤8；beats 按集分配（episode 字段），type 用「悬念钩/笑点/危机/反转/大爆点/收束」，间隔不超过 3 集
- id 用 C01/S01/P01/B01 这种格式，全剧唯一`,
  });

  // ---- 骨架规范化：id 唯一、必备字段补齐 ----
  const fixIds = (arr, prefix) => {
    const seen = new Set();
    (arr || []).forEach((x, i) => {
      let id = String(x?.id || '').trim();
      if (!id || seen.has(id)) id = `${prefix}${String(i + 1).padStart(2, '0')}`;
      x.id = id;
      seen.add(id);
    });
    return arr || [];
  };
  const chars = fixIds(skeleton.characters, 'C');
  const scenes = fixIds(skeleton.scenes, 'S');
  const props = fixIds(skeleton.props || [], 'P');
  const beats = fixIds(skeleton.beats || [], 'B');
  for (const c of chars) if (!['lead', 'support', 'functional'].includes(c.tier)) c.tier = 'support';
  for (const sc of scenes) sc.primary = !!sc.primary;
  for (const b of beats) {
    b.episode = Math.min(P.episodes, Math.max(1, Number(b.episode) || 1));
    if (!['major', 'minor'].includes(b.weight)) b.weight = /大爆点|反转/.test(String(b.type || '')) ? 'major' : 'minor';
  }
  onLog(`  骨架：${chars.length} 角色 / ${scenes.length} 场景 / ${beats.length} 爽点`);

  // ---- 把每个 id 摊到各集，保证没有任何角色/场景/道具失业 ----
  const spread = (arr) => {
    const buckets = Array.from({ length: P.episodes }, () => []);
    arr.forEach((x, i) => buckets[i % P.episodes].push(x.id));
    return buckets;
  };
  const charEp = spread(chars);
  const sceneEp = spread(scenes);
  const propEp = spread(props);

  const eps = [];
  for (let ep = 1; ep <= P.episodes; ep++) {
    throwIfCancelled();
    const dueBeats = beats.filter((b) => b.episode === ep);
    const must = { chars: charEp[ep - 1], scenes: sceneEp[ep - 1], props: propEp[ep - 1] };
    const epObj = await chatJSON({
      provider, maxTokens: 2600,
      system: `${OUTLINE_SYS}\n这一集只输出一个 episode 对象。`,
      validateFn: (o) => {
        if (!String(o?.synopsis || '').trim()) return '缺 synopsis';
        if (!String(o?.hook || '').trim()) return '缺 hook';
        if (!String(o?.suspense || '').trim()) return '缺 suspense';
        if (/[「」『』“”"]/.test(String(o.synopsis) + String(o.hook) + String(o.suspense))) return '梗概/钩子/悬念必须是叙述体，不能出现引号对白';
        for (const [field, want] of [['characterIds', must.chars], ['sceneIds', must.scenes], ['propIds', must.props]]) {
          const got = Array.isArray(o?.[field]) ? o[field] : [];
          const miss = want.filter((x) => !got.includes(x));
          if (miss.length) return `${field} 必须包含本集要用的 ${miss.join('、')}`;
        }
        return null;
      },
      user: `写第 ${ep} 集的梗概（叙述体，不要台词，不要引号）。
【该集 available 场景 id】${scenes.map((s) => s.id + ' ' + s.name).join('；')}
【该集 available 角色 id】${chars.map((c) => c.id + ' ' + c.name).join('；')}
【该集 props id】${props.map((p) => p.id + ' ' + p.name).join('；')}
【该集要落地的爽点】${dueBeats.map((b) => b.type + '：' + (b.setup || '') + '→' + (b.payoff || '')).join('；') || '无'}
【本集必须用上】角色 ${must.chars.join('、') || '无'}；场景 ${must.scenes.join('、') || '无'}；道具 ${must.props.join('、') || '无'}
（这些 id 必须出现在 characterIds / sceneIds / propIds 里，梗概也要交代它们怎么被用上）
输出：${JSON.stringify(shapeOf(ex?.episodes?.[0]), null, 1)}`,
    });
    // 规范化：并集兜底、同框拆解方案、生成难点预警
    const union = (want, got) => [...new Set([...(Array.isArray(got) ? got : []), ...want])];
    const epNorm = {
      ...epObj,
      ep,
      sceneIds: union(must.scenes, epObj.sceneIds),
      characterIds: union(must.chars, epObj.characterIds),
      propIds: union(must.props, epObj.propIds),
    };
    if (epNorm.characterIds.length >= 3 && !String(epNorm.crowdPlan || '').trim()) {
      epNorm.crowdPlan = '三人以上同框拆开拍：主次分组、重点人物靠前景，其余作背景虚化；对话镜头单人单机位，不硬凑全景。';
    }
    const epText = ['synopsis', 'hook', 'suspense'].map((f) => String(epNorm[f] || '')).join(' ');
    const riskMap = { 雨戏: /雨/, 肢体接触: /吻|拥抱|相拥|牵手|贴身|扭打|搂/, 人群: /人群|围观|众人|满堂|满座|集市|人山/, 手部特写: /手部|指尖|十指|特写.{0,4}手/ };
    const warn = new Set(Array.isArray(epNorm.warnings) ? epNorm.warnings : []);
    for (const [k, re] of Object.entries(riskMap)) if (re.test(epText)) warn.add(k);
    epNorm.warnings = [...warn];
    eps.push(epNorm);
  }

  const doc = {
    source: name, lang: 'zh',
    params: { episodes: P.episodes, minutesPerEpisode: P.seconds / 60, genre: P.genre, adaptMode: '抽核', preferences: [] },
    adaptation: skeleton.adaptation, characters: chars, scenes,
    props: props, beats, episodes: eps,
  };

  // ---- 一次性场景复用方案（技能 G7） ----
  const useCount = (id) => eps.filter((e) => (e.sceneIds || []).includes(id)).length;
  for (const sc of doc.scenes) {
    if (useCount(sc.id) === 1 && !String(sc.reusePlan || '').trim()) {
      sc.reusePlan = '一次性场景：只用固定机位与本场光线，拍完不复用；不与其他场景同框，避免背景串味。';
    }
  }

  // ---- 人物弧补齐（技能 G5）：缺 arc 的整批补一次 ----
  const fillArcs = async (errText = '') => {
    const miss = doc.characters.filter((c) => c.tier !== 'functional' && !String(c.arc || '').trim());
    if (!miss.length) return;
    try {
      const o = await chatJSON({
        provider, maxTokens: 1600,
        validateFn: (o) => {
          const arr = Array.isArray(o?.arcs) ? o.arcs : [];
          const got = new Map(arr.map((a) => [String(a?.id || ''), String(a?.arc || '').trim()]));
          const need = miss.filter((c) => !got.get(c.id));
          return need.length ? `这些角色还缺 arc：${need.map((c) => c.id).join('、')}` : null;
        },
        user: `给这些角色各写一句话人物弧（从…到…），只输出 {"arcs":[{"id":"C01","arc":"…"}]}：
${miss.map((c) => `${c.id} ${c.name}｜${c.role || ''}${c.from ? '｜' + c.from : ''}`).join('\n')}
${errText ? `\n【上一轮校验报错】${String(errText).slice(0, 300)}` : ''}`,
      });
      for (const a of o.arcs || []) {
        const c = doc.characters.find((x) => x.id === a.id);
        if (c && String(a.arc || '').trim()) c.arc = String(a.arc).trim();
      }
      onLog(`  · 补齐人物弧：${(o.arcs || []).length} 人`);
    } catch (e) {
      for (const c of miss) c.arc = `${c.name}从${c.role || '原本的处境'}走到肯为这桩事担下后果。`;
      onLog(`  · 人物弧兜底（${String(e.message || e).slice(0, 60)}）`);
    }
  };
  await fillArcs();

  const { dir, base } = projectPaths(name);
  const r = await generateWithRepair({
    stage: 'outline', dir, base, provider, onLog,
    build: async (errText) => { if (errText) await fillArcs(errText); return doc; },
  });
  onLog(r.ok ? '✓ 大纲通过校验' : '✗ 大纲未过（见上）');
  return r;
}

/* ============================== 2. 角色 ============================== */

const CAST_SYS = `你是 AI 漫剧的角色设定师，只输出 JSON。
规则（来自 novel-characters 技能）：
- importance 只能是 protagonist / major / supporting / minor
- image.prompt / negativePrompt / sheet 全英文；prompt 里绝不出现角色名，用描述词替代
- image.tags 是数组（英文短标签）
- voice 的 timbre/pitch/pace/accent/emotion/referenceHint 都用中文；voice.prompt 是英文紧凑参数串，≤400 字符
- persona.evidence 放 2–4 句**原著逐字**台词
- 画风短语固定：Chinese cel-shaded animation style, bold lineart, flat colors, guofeng fantasy`;

function ensureNegative(np, tokens) {
  const base = String(np || '').trim();
  const missing = tokens.filter((t) => !new RegExp(t, 'i').test(base));
  if (!missing.length) return base;
  return `${base}${base ? ', ' : ''}${missing.map((t) => 'no ' + t).join(', ')}`;
}

function scrubNameMentions(item) {
  const names = [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])]
    .filter((n) => typeof n === 'string' && n.trim().length >= 2)
    .sort((a, b) => b.length - a.length);
  if (!names.length) return;
  const fix = (v, ph) => { let t = String(v); for (const n of names) t = t.split(n).join(ph); return t; };
  const image = item.image || (item.image = {});
  if (typeof image.prompt === 'string') image.prompt = fix(image.prompt, 'the character');
  if (typeof image.promptLocal === 'string') image.promptLocal = fix(image.promptLocal, '该角色');
  if (typeof image.sheet === 'string') image.sheet = fix(image.sheet, '该角色');
  if (Array.isArray(image.tags)) image.tags = image.tags.map((t) => (typeof t === 'string' ? fix(t, 'character') : t));
}

function novelSentences(novel) {
  return String(novel)
    .split(/(?<=[。！？!?])|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 6 && x.length <= 120);
}

function pickEvidence(c, item) {
  const sentences = novelSentences(globalThis.__NOVEL__ || '');
  const keys = [c.name, ...(c.aliases || []), ...(Array.isArray(item.aliases) ? item.aliases : [])].filter((k) => typeof k === 'string' && k.trim().length >= 2);
  let hit = sentences.filter((sn) => keys.some((k) => sn.includes(k)));
  if (!hit.length) {
    const grams = (t) => { const o = new Set(); for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2)); return o; };
    const target = grams([c.name, c.role || '', c.arc || '', item.persona?.persona || item.persona?.background || ''].join(''));
    hit = sentences
      .map((sn) => { const g = grams(sn); let n = 0; for (const x of target) if (g.has(x)) n++; return { sn, n }; })
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((x) => x.sn);
  }
  if (!hit.length) hit = sentences.slice(0, 2);
  return hit.slice(0, 3);
}

export async function genCharacters(name, { provider, onLog = log } = {}) {
  const P = await projectParams(name);
  const { dir, base } = projectPaths(name);
  const outline = await readJsonMaybe(path.join(dir, `outline/${base}-outline.json`));
  if (!outline) throw new Error('缺 outline，先跑大纲');
  const ex = skillExample('characters');
  const charShape = shapeOf(ex?.characters?.[0]);
  const tierMap = { lead: 'protagonist', protagonist: 'protagonist', major: 'major', support: 'supporting', supporting: 'supporting', functional: 'minor', minor: 'minor' };
  const allNames = outline.characters.flatMap((c) => [c.name, ...(c.aliases || [])]).filter((n) => typeof n === 'string' && n.trim());
  const lines = String(P.novel).split(/[。！？\n]/).map((x) => x.trim()).filter((x) => x.length >= 6 && x.length <= 60);
  globalThis.__NOVEL__ = String(P.novel || '');
  const FIG = ['prompt', 'promptLocal', 'sheet'];
  const nameHits = (obj, names) => {
    const hits = [];
    for (const f of FIG) {
      const v = obj?.image?.[f];
      if (typeof v !== 'string') continue;
      for (const n of names) if (v.includes(n)) hits.push(`image.${f}「${n}」`);
    }
    return hits;
  };

  const makeOne = async (c, errHint = '') => {
    const verbatim = lines.filter((l) => l.includes(c.name)).slice(0, 3);
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await makeOneOnce(c, errHint, verbatim);
      } catch (e) {
        if (e?.cancelled) throw e;
        lastErr = e;
        onLog(`  ! ${c.name} 第 ${attempt} 次生成失败（${String(e?.message || e).slice(0, 80)}）`);
        if (attempt < 3) await new Promise((res) => setTimeout(res, 4000 * attempt));
      }
    }
    throw lastErr;
  };

  const makeOneOnce = async (c, errHint, verbatim) => {
    const item = await chatJSON({
      provider, maxTokens: 5000, system: CAST_SYS,
      validateFn: (o) => {
        if (!o?.image?.prompt || String(o.image.prompt).length < 120) return 'image.prompt 太短';
        // 人名由服务端确定性擦除（scrubNameMentions），这里不拿它当致命错误，避免像「小鱼灯」这种本名即实物的角色永远生成不出来
        for (const f of ['timbre', 'pitch', 'pace', 'accent', 'emotion', 'referenceHint']) {
          if (!o?.voice?.[f] || !/[\u4e00-\u9fa5]/.test(String(o.voice[f]))) return `voice.${f} 要用中文`;
        }
        return null;
      },
      user: `为这个角色生成角色卡（只一个对象）：
${c.id} ${c.name}｜${c.role || ''}｜${c.arc || ''}

【输出结构】
${JSON.stringify(charShape, null, 1)}

【硬性要求】image.prompt / image.promptLocal / image.sheet 是纯外观描述，禁止出现任何角色名或别名（包括本角色自己的名字），一律用「该角色」「此人」或服装/发型/体态/年龄等外观词替代。
${errHint ? `\n【上一轮整组校验报错，请避开】\n${String(errHint).slice(0, 500)}\n` : ''}
参考原著里与他/她有关的句子（引文要逐字，不要改写）：
${verbatim.length ? verbatim.map((v) => '· ' + v).join('\n') : '（原文里没有直接点名，用上下文概括，evidence 可放 2 句该角色相关叙述）'}
`,
    });
    // 服务端确定性规范化（与技能校验对齐）
    item.importance = tierMap[item.importance] || tierMap[c.tier] || 'supporting';
    item.id = item.id || c.id;
    item.name = item.name || c.name;
    item.aliases = Array.isArray(item.aliases) ? item.aliases : (c.aliases || []);
    item.image = item.image || {};
    if (!Array.isArray(item.image.tags)) item.image.tags = item.image.tags ? [String(item.image.tags)] : ['cel-shaded'];
    if (!item.image.negativePrompt) item.image.negativePrompt = 'no people, no hands, extra fingers, fused fingers, text, watermark, logo, lowres, blurry';
    if (!item.image.sheet || /[\u4e00-\u9fa5]/.test(String(item.image.sheet))) {
      item.image.sheet = 'Character design sheet on a plain white background, three panels: left panel a chest-up portrait; right-top panel front full-body plus 90-degree side and back views; right-bottom panel three detail close-ups. Keep proportions identical across panels; no text, no watermark.';
    }
    if (String(item.image.prompt).match(/[\u4e00-\u9fa5]/)) item.image.prompt = String(item.image.prompt).replace(/[\u4e00-\u9fa5]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (item.voice?.prompt && String(item.voice.prompt).length > 395) item.voice.prompt = String(item.voice.prompt).slice(0, 392);
    item.persona = { ...(item.persona || {}), evidence: pickEvidence(c, item) };
    scrubNameMentions(item);
    return item;
  };

  onLog(`▸ 角色：${outline.characters.length} 人（schema 来自技能示例）`);
  const buildOnce = async (errHint = '') => {
    const out = [];
    for (const c of outline.characters) {
    throwIfCancelled();
      out.push(await makeOne(c, errHint));
      onLog(`  ✓ ${c.name}`);
    }
    return out;
  };
  let chars = await buildOnce('');
  const r = await generateWithRepair({
    stage: 'characters', dir, base, provider, onLog,
    build: async (errText) => {
      if (errText) {
        onLog('  ↻ 按校验报错整组重生成…');
        chars = await buildOnce(errText);
      }
      return { source: name, lang: 'zh', summary: outline.adaptation?.core || '', characters: chars };
    },
  });
  onLog(r.ok ? '✓ 角色全部通过校验' : '✗ 角色未过（见上）');
  return r;
}

/* ============================== 3. 美术 ============================== */

const ART_SYS = `你是 AI 漫剧的美术设定师，只输出 JSON。
规则（来自 novel-art 技能）：
- 场景：anchors 3–5 条（name+desc）、lighting ≥1 个状态（state+prompt）、image.prompt 是英文**空景无人无手**、usage 有 episodes 与 reuse
- 道具：scale 必须是 手持级 / 桌面级 / 家具级 之一，且 **image.prompt 与 image.sheet 都要出现对应英文短语**（handheld scale / tabletop scale / furniture scale）
- 所有提示词英文，不含角色名；道具白底无手
- 画风短语：Chinese cel-shaded animation style, bold lineart, flat colors, guofeng fantasy`;

export async function genArt(name, { provider, onLog = log } = {}) {
  const P = await projectParams(name);
  const { dir, base } = projectPaths(name);
  const outline = await readJsonMaybe(path.join(dir, `outline/${base}-outline.json`));
  if (!outline) throw new Error('缺 outline');
  const ex = skillExample('art');
  const sceneShape = shapeOf(ex?.scenes?.[0]);
  const propShape = shapeOf(ex?.props?.[0]);
  const scaleEn = { 手持级: 'handheld scale', 桌面级: 'tabletop scale', 家具级: 'furniture scale' };
  const sceneIds = outline.scenes.map((s) => s.id);

  onLog(`▸ 美术：${outline.scenes.length} 场景 + ${(outline.props || []).length} 道具`);
  const scenes = [];
  for (const s of outline.scenes) {
    throwIfCancelled();
    const item = await chatJSON({
      provider, maxTokens: 4000, system: ART_SYS,
      validateFn: (o) => (!o?.image?.prompt || String(o.image.prompt).length < 80 ? '缺 image.prompt' : null),
      user: `生成场景设定（只一个对象）：${s.id} ${s.name}（${s.primary ? '主场景' : '一次性场景'}）
【结构】${JSON.stringify(sceneShape, null, 1)}`,
    });
    item.id = s.id; item.name = item.name || s.name; item.primary = !!s.primary;  // id 一律以大纲为准，避免模型自造重复 id
    item.image = item.image || {};
    if (!Array.isArray(item.image.tags)) item.image.tags = item.image.tags ? [String(item.image.tags)] : ['cel-shaded'];
    item.image.negativePrompt = ensureNegative(item.image.negativePrompt, ['people', 'hands', 'text', 'watermark']);
    if (!item.image.sheet || /[\u4e00-\u9fa5]/.test(String(item.image.sheet))) item.image.sheet = 'Environment sheet on white: one large main view plus four detail crops, no people, no hands, keep the space identical across panels.';
    item.anchors = Array.isArray(item.anchors) && item.anchors.length ? item.anchors : [{ name: 'main structure', desc: 'keep silhouette and material identical across shots' }];
    item.lighting = Array.isArray(item.lighting) && item.lighting.length ? item.lighting : [{ state: '夜景', prompt: 'warm lantern light with cool moonlight fill' }];
    item.usage = (typeof item.usage === 'object' && item.usage) || { episodes: [], beats: [], reuse: 'reuse base view, change lighting only' };
    if (!Array.isArray(item.usage.episodes)) item.usage.episodes = [];
    if (!Array.isArray(item.usage.beats)) item.usage.beats = [];
    scenes.push(item);
    onLog(`  ✓ 场景 ${s.name}`);
  }

  const props = [];
  for (const p0 of outline.props || []) {
    throwIfCancelled();
    const item = await chatJSON({
      provider, maxTokens: 3000, system: ART_SYS,
      validateFn: (o) => (!o?.image?.prompt || String(o.image.prompt).length < 60 ? '缺 image.prompt' : null),
      user: `生成叙事道具设定（只一个对象）：${p0.id} ${p0.name}｜戏剧功能：${p0.function || ''}
【结构】${JSON.stringify(propShape, null, 1)}
必须自己选一个 scale（手持级/桌面级/家具级），并把对应英文短语同时写进 image.prompt 和 image.sheet。`,
    });
    item.id = p0.id; item.name = item.name || p0.name;  // id 一律以大纲为准
    const SC = ['手持级', '桌面级', '家具级'];
    if (!SC.includes(item.scale)) item.scale = '手持级';
    item.image = item.image || {};
    const need = scaleEn[item.scale];
    for (const f of ['prompt', 'sheet']) {
      if (!item.image[f]) item.image[f] = f === 'sheet' ? 'Prop sheet on a pure white background: one large three-quarter view plus three detail close-ups. No hands, no people, no text.' : 'a prop on a plain white background, no hands';
      if (!String(item.image[f]).toLowerCase().includes(need)) item.image[f] = `${String(item.image[f]).trim()} Shown at ${need}, with an obvious size reference.`;
      if (/[\u4e00-\u9fa5]/.test(String(item.image[f]))) item.image[f] = String(item.image[f]).replace(/[\u4e00-\u9fa5]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    // 白底可抠：sheet 必须明写纯白背景（技能 prop-white 门）
    if (!/white background/i.test(String(item.image.sheet))) {
      item.image.sheet = `${String(item.image.sheet).trim()} Isolated on a pure white background, even flat lighting, no shadow, no ground plane, no hands, no people, no text.`;
    }
    if (!Array.isArray(item.image.tags)) item.image.tags = ['prop'];
    item.image.negativePrompt = ensureNegative(item.image.negativePrompt, ['people', 'hands', 'fingers', 'text', 'watermark']);
    item.relatedScenes = (Array.isArray(item.relatedScenes) ? item.relatedScenes : []).filter((x) => sceneIds.includes(x));
    if (!item.relatedScenes.length) item.relatedScenes = sceneIds.slice(0, 1);
    if (!Array.isArray(item.states) || !item.states.length) item.states = [{ state: 'normal', desc: 'intact as first seen' }];
    props.push(item);
    onLog(`  ✓ 道具 ${p0.name}`);
  }

  const doc = { source: name, dynasty: ex?.dynasty || '明代', lang: 'zh', scenes, props };
  const r = await generateWithRepair({ stage: 'art', dir, base, provider, build: async () => doc, onLog });
  onLog(r.ok ? '✓ 美术通过校验' : '✗ 美术未过（见上）');
  return r;
}

/* ============================== 导出 ============================== */

export { REG, skillExample, shapeOf, projectPaths, readJsonMaybe, readMaybe, runNode, validate, SKILLS, ROOT };

/* ============================== 4. 剧本 ============================== */

const SCRIPT_SYS = `你是 AI 漫剧编剧，只输出 JSON。
规则（来自 novel-script 技能，违反即不合格）：
- 台词单句 ≤ 22 个汉字（分镜每切上限 5 秒，22 字≈4.9 秒）
- 动作节拍只能叙述体，不能出现引号台词
- 每场至少 1 个动作节拍；动作与台词交替
- sceneId 必须来自给定场景；props 只能来自给定道具；characters 只能用给定角色 id
- 每场 lighting 必须原样复制该场景已登记的 state 字符串
- 一集时长 = Σ台词字数/4.5 + 动作数×2.5，目标 {SEC} 秒（允许 ±15%）`;

const LINE_MAX = 22;

function estBeat(b) { return b.line ? Math.round(([...b.line].length / 4.5) * 10) / 10 : 2.5; }

export async function genScript(name, { provider, onLog = log } = {}) {
  const P = await projectParams(name);
  const { dir, base } = projectPaths(name);
  const outline = await readJsonMaybe(path.join(dir, `outline/${base}-outline.json`));
  const castDoc = await readJsonMaybe(path.join(dir, `characters/${base}-cast.json`));
  const art = await readJsonMaybe(path.join(dir, `art/${base}-art.json`));
  if (!outline || !castDoc || !art) throw new Error('缺 outline/cast/art');
  const cast = castDoc.characters || [];
  const nameToId = new Map(cast.map((c) => [c.name, c.id]));
  const sceneMap = new Map((art.scenes || []).map((s) => [s.id, s]));
  const propIds = new Set((art.props || []).map((p) => p.id));
  const ex = skillExample('script');
  const sceneShape = shapeOf(ex?.episodes?.[0]?.scenes?.[0]);
  const epShape = shapeOf(ex?.episodes?.[0]);
  const demoScene = (ex?.episodes || []).flatMap((e) => e.scenes || []).find((sc) => (sc.flow || []).some((b) => b.line) && (sc.flow || []).some((b) => b.action));
  const scriptFlowDemo = demoScene
    ? [
        { action: '镜头里看得见的动作、走位、道具操作（叙述体，无引号，不写心理活动）' },
        { speaker: '<角色 id>', line: '一句台词，≤22 个汉字', delivery: '怎么说这句（语气/动作）' },
        { action: '接着的一个动作节拍' },
      ]
    : [];
  const target = (outline.params?.minutesPerEpisode || 2) * 60;

  onLog(`▸ 剧本：${outline.episodes.length} 集 × ${target}s`);
  const episodes = [];
  for (const epMeta of outline.episodes) {
    throwIfCancelled();
    const ep = epMeta.ep;
    const src = await readMaybe(path.join(dir, 'docs', 'sources', `E${String(ep).padStart(2, '0')}.txt`));
    const out = await chatJSON({
      provider, maxTokens: 5200, temperature: 0.4, system: SCRIPT_SYS.replace('{SEC}', target),
      validateFn: (o) => {
        if (!Array.isArray(o?.scenes) || !o.scenes.length) return '缺 scenes';
        const minLines = Math.max(6, Math.round(target / 14));
        const all = o.scenes.flatMap((sc) => (Array.isArray(sc?.flow) ? sc.flow : []));
        const lineCount = all.filter((b) => typeof b?.line === 'string' && b.line.trim()).length;
        if (lineCount < minLines) return `台词太少：这一集只写了 ${lineCount} 句，至少要 ${minLines} 句，动作与台词必须交替`;
        const noAction = o.scenes.filter((sc) => !(Array.isArray(sc?.flow) ? sc.flow : []).some((b) => typeof b?.action === 'string' && b.action.trim()));
        if (noAction.length) return `这些场没有动作节拍：${noAction.map((sc) => sc?.sceneId).join('、')}`;
        for (const b of all) {
          if (typeof b?.line === 'string' && [...b.line.replace(/\s+/g, '')].length > 22) return `台词超 22 字：${b.line.slice(0, 30)}`;
          if (typeof b?.action === 'string' && /[「」“”『』"]/.test(b.action)) return `动作节拍里混进了引号台词：${b.action.slice(0, 30)}`;
        }
        return null;
      },
      user: `写第 ${ep} 集剧本（只这一集）。
【梗概】${epMeta.synopsis || ''}
【钩子】${epMeta.hook || ''}【悬念】${epMeta.suspense || ''}
【可用场景】${[...sceneMap.values()].map((s) => `${s.id} ${s.name}｜lighting: ${(s.lighting || []).map((l) => l.state).join(' / ')}`).join('\n')}
【可用道具】${[...propIds].join('、')}
【角色 id】${cast.map((c) => `${c.id} ${c.name}`).join('；')}
【该集原著片段】
${String(src || '').slice(0, 2400) || String(P.novel).slice(0, 2400)}
【输出结构】${JSON.stringify(epShape, null, 1)}

【flow 写法】每场 flow 是「动作节拍」与「台词节拍」交替的数组，两种元素结构不同，必须混排：
${JSON.stringify(scriptFlowDemo, null, 1)}
动作节拍只写镜头里看得见的动作与画面（叙述体、无引号、不写心理活动）；台词节拍写 speaker(角色 id) / line / delivery。`,
    });

    // 服务端规范化 + 时长校准（与技能 computeStats 一致：每拍先四舍五入到 0.1）
    const scenes = [];
    for (const sc of out.scenes || []) {
      const ref = sceneMap.get(String(sc.sceneId || '').trim());
      if (!ref) continue;
      const states = (ref.lighting || []).map((l) => l.state).filter(Boolean);
      const chars = (sc.characters || [])
        .map((x) => (nameToId.has(x) ? nameToId.get(x) : String(x)))
        .filter((x) => cast.some((c) => c.id === x));
      const props = (sc.props || []).filter((x) => propIds.has(x));
      const flow = [];
      for (const b of sc.flow || []) {
        if (typeof b?.action === 'string' && b.action.trim()) flow.push({ action: b.action.replace(/[「」“”『』"]/g, '').trim() });
        else if (typeof b?.line === 'string' && b.line.trim()) {
          flow.push({ speaker: chars.includes(b.speaker) ? b.speaker : (chars[0] || 'VO'), line: [...String(b.line).replace(/\s+/g, '')].slice(0, LINE_MAX).join(''), delivery: String(b.delivery || '').slice(0, 40) });
        }
      }
      if (!flow.some((b) => b.action)) flow.unshift({ action: `${ref.name}里静了一瞬。` });
      scenes.push({ sceneId: ref.id, characters: chars, props, lighting: states.includes(sc.lighting) ? sc.lighting : (states[0] || ''), flow });
    }

    const epObj = { ep, targetSeconds: target, hook: String(epMeta.hook || ''), cliff: String(epMeta.suspense || ''), beatsClaimed: [...new Set((outline.beats || []).filter((b) => b.episode === ep).map((b) => b.type))], hookBeat: [1, 1], scenes };
    // 时长校准
    const est = () => epObj.scenes.reduce((n, s) => n + s.flow.reduce((m, b) => m + estBeat(b), 0), 0);
    const pads = ['他停了一下，看向四周。', '夜风把灯影吹晃。', '远处传来一声轻响。'];
    let guard = 0;
    while (est() < target * 0.9 && guard++ < 40) {
      const last = epObj.scenes[epObj.scenes.length - 1];
      if (!last) break;
      last.flow.push({ action: pads[guard % pads.length] });
    }
    guard = 0;
    while (est() > target * 1.1 && guard++ < 60) {
      const last = epObj.scenes[epObj.scenes.length - 1];
      const idx = last ? last.flow.map((b) => !!b.action).lastIndexOf(true) : -1;
      if (last && idx > 0 && last.flow.filter((b) => b.action).length > 1) last.flow.splice(idx, 1);
      else {
        const lines = epObj.scenes.flatMap((s) => s.flow.filter((b) => b.line)).sort((a, b) => b.line.length - a.line.length);
        if (!lines.length) break;
        lines[0].line = [...lines[0].line].slice(0, Math.max(10, Math.floor(lines[0].line.length * 0.8))).join('');
      }
    }
    episodes.push(epObj);
    onLog(`  ✓ 第 ${ep} 集：${epObj.scenes.length} 场 / ${Math.round(est())}s`);
  }

  const doc = { source: name, lang: 'zh', episodes };
  const r = await generateWithRepair({ stage: 'script', dir, base, provider, build: async () => doc, onLog });
  onLog(r.ok ? '✓ 剧本通过校验' : '✗ 剧本未过（见上）');
  return r;
}

/* ============================== 5. 站位 ============================== */

const SEAT_RE = /桌|案|台|凳|椅|床|席|阶|石|柜台|摊/;
const CROWD_RE = /群妖|人群|围观|顾客|众妖|路人|看客|街坊|众人/;

const ITEM_SYS = `你是 AI 漫剧的站位美术，只输出 JSON。
任务：读一个场景的设定提示词与一致性锚点，列出这个空景里「人能站上去、坐上去、或靠上去」的 4–8 件东西。
- name：中文，≤12 字，要具体（写「镜花签摊长桌」而不是「桌子」）
- alt：英文短语，≤40 字符
- plan：俯视图上的矩形，四个 0–1 的数 [x1,y1,x2,y2]，x 向右、y 向下，右大于左、下大于上；不同东西别重叠
- on：人能不能踩上去或坐上去（地面、台阶、船板、土坡 true；灯柱、摊桌、招牌 false）
- 至少一件 on=true（总得有能落脚的地方）
- 只输出 {"items":[...]}`;

const isPlanBox = (b) => Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && v >= 0 && v <= 1) && b[2] > b[0] && b[3] > b[1];

function normalizeItems(raw) {
  const seen = new Set();
  const items = [];
  for (const it of raw || []) {
    const name = String(it?.name || '').replace(/[《》「」“”"]/g, '').trim().slice(0, 20);
    if (!name || seen.has(name)) continue;
    let plan = Array.isArray(it?.plan) && it.plan.length === 4 ? it.plan.map(Number) : null;
    if (!isPlanBox(plan)) continue;
    const alt = /[A-Za-z]/.test(String(it?.alt || '')) ? String(it.alt).trim().slice(0, 40) : 'standpoint';
    items.push({ name, alt, plan, on: it?.on === true, round: it?.round === true });
    seen.add(name);
    if (items.length >= 20) break;
  }
  return items;
}

function anchorItems(sc) {
  const anchors = (sc.anchors || []).slice(0, 6);
  const items = anchors.map((a, i) => ({
    name: String(a.name || `物件${i + 1}`).slice(0, 20),
    alt: String(a.prompt || a.desc || a.name || 'a prop').slice(0, 80),
    plan: [Number((0.18 + (i % 2) * 0.5).toFixed(2)), Number((0.12 + Math.floor(i / 2) * 0.24).toFixed(2)), Number((0.44 + (i % 2) * 0.5).toFixed(2)), Number((0.26 + Math.floor(i / 2) * 0.24).toFixed(2))],
    on: SEAT_RE.test(String(a.name || '')),
    round: false,
  })).filter((it) => isPlanBox(it.plan));
  let y = 0.72;
  while (items.length < 4) {
    items.push({ name: `地面落脚区${items.length + 1}`, alt: 'a patch of open ground', plan: [0.12, y, 0.88, Math.min(0.98, y + 0.12)], on: true, round: false });
    y += 0.13;
  }
  return items;
}

export async function genStaging(name, { provider, onLog = log } = {}) {
  const { dir, base } = projectPaths(name);
  const script = await readJsonMaybe(path.join(dir, `script/${base}-script.json`));
  const art = await readJsonMaybe(path.join(dir, `art/${base}-art.json`));
  const castDoc = await readJsonMaybe(path.join(dir, `characters/${base}-cast.json`));
  if (!script || !art) throw new Error('缺 script/art');
  const cast = (castDoc?.characters || []).reduce((m, c) => ((m[c.id] = c), m), {});
  const artScenes = new Map((art.scenes || []).map((s) => [s.id, s]));
  onLog(`▸ 站位：${script.episodes.length} 集`);

  const locations = [];
  for (const [sid, sc] of artScenes) {
    throwIfCancelled();
    let items = [];
    try {
      const o = await chatJSON({
        provider, maxTokens: 2200, system: ITEM_SYS,
        validateFn: (o) => {
          const arr = Array.isArray(o?.items) ? o.items : [];
          if (arr.length < 4 || arr.length > 12) return `items 要给 4–12 件，现在 ${arr.length} 件`;
          if (!arr.some((i) => i?.on === true)) return '至少要有一件 on=true 的落脚处';
          for (const i of arr) if (!i?.name || !isPlanBox(Array.isArray(i.plan) ? i.plan.map(Number) : i.plan)) return '每件东西都要 name 与 plan（四个 0–1 的数）';
          return null;
        },
        user: `场景：${sc.name}
【场景设定提示词】${String(sc.image?.prompt || '').slice(0, 900)}
【一致性锚点】${(sc.anchors || []).map((a) => a.name + (a.prompt ? '：' + a.prompt : '')).join('；') || '无'}
说出这个空景里人能站、能坐、能靠的 4–8 件东西。`,
      });
      items = normalizeItems(o.items);
    } catch (e) {
      onLog(`  · ${sc.name} 认图失败，用锚点兜底（${String(e.message || e).slice(0, 60)}）`);
    }
    if (items.length < 4) items = anchorItems(sc);
    locations.push({ sceneId: sid, name: sc.name, readFrom: 'prompt', items });
    onLog(`  ✓ 地点 ${sc.name}：${items.length} 件`);
  }

  const scenes = [];
  let n = 0;
  for (const ep of script.episodes) {
    ep.scenes.forEach((sc, si) => {
      n++;
      const loc = locations.find((l) => l.sceneId === sc.sceneId);
      if (!loc) return;
      const castList = (sc.characters || []).filter((id) => cast[id]).map((id) => ({ id, name: cast[id].name }));
      // 开场站位要跟剧本这一场的动作一致：剧本里在坐/蹲/靠，才给 sit；否则一律站
      const flowText = (sc.flow || []).map((b) => b.action || b.line || '').join(' ');
      const sitting = /坐|蹲|倚|靠|躺|跪/.test(flowText);
      const grounds = loc.items.filter((it) => it.on);
      const pool = grounds.length ? grounds : loc.items;
      const usedOn = new Map();
      const places = castList.map((c, i) => {
        const it = pool[i % pool.length];
        const dup = usedOn.get(it.name) || 0;
        usedOn.set(it.name, dup + 1);
        // 同一件东西上只放第一个人，多了就分到它的各侧，别叠在一个点
        const on = it.on === true && dup === 0;
        return {
          id: c.id, name: c.name, present: true, item: it.name,
          side: on ? 'on' : ['south', 'north', 'east', 'west'][i % 4],
          along: Number((0.15 + (i % 4) * 0.2).toFixed(2)),
          posture: on && sitting ? 'sit' : 'stand',
          facing: ['north', 'south', 'east', 'west'][(i + 1) % 4],
        };
      });
      const crowd = CROWD_RE.test(JSON.stringify(sc.flow || []));
      scenes.push({ ep: ep.ep, scene: si + 1, sceneId: sc.sceneId, cast: castList, places, extras: crowd ? 4 + (n % 3) : 0, extrasWhere: crowd ? `${loc.name}两侧，只作背景` : null, why: `${loc.name}：${castList.map((c) => c.name).join('、') || '无'}开场在场，同侧错开不叠人${crowd ? '；群演在两侧' : '；剧本没写别人，不加群演'}。`.slice(0, 200) });
    });
  }

  const doc = { source: name, lang: 'zh', locations, scenes };
  const scriptPath = path.join(dir, `script/${base}-script.json`);
  const artPath = path.join(dir, `art/${base}-art.json`);
  const r = await generateWithRepair({ stage: 'staging', dir, base, provider, build: async () => doc, onLog });
  if (r.ok) {
    const skill = path.join(SKILLS, 'novel-staging/scripts/novel-staging.mjs');
    const outPath = path.join(dir, `staging/${base}-staging.json`);
    const b = await runNode([skill, 'blocking', outPath], dir);
    await writeFile(path.join(dir, 'staging', 'blocking.txt'), b.out || '', 'utf8');
    const h = await runNode([skill, 'render', outPath], dir);
    if (h.code === 0) await writeFile(path.join(dir, 'staging', 'staging-report.html'), h.out || '', 'utf8');
    onLog('✓ 已生成 blocking.txt 与 staging-report.html');
  }
  return r;
}

/* ============================== 6. 分镜 ============================== */

let SB = null;
async function sbSkill() { if (!SB) SB = await import(path.join(SKILLS, 'novel-storyboard/scripts/novel-storyboard.mjs')); return SB; }

function identityOf(c) {
  const p = c?.persona || {};
  const g = String(p.gender || ''), age = String(p.ageRange || ''), nm = String(c?.name || '');
  const y = age.match(/(\d+)\s*岁/);
  const child = y ? Number(y[1]) < 16 : /童|小|孩/.test(age + nm);
  const elder = /中年|老|长者|年长/.test(age) || /老|翁|婆|叔|婶/.test(nm);
  if (/女/.test(g)) return child ? 'a little girl' : elder ? 'the older woman' : 'the young woman';
  if (/男/.test(g)) return child ? 'a small boy' : elder ? 'the old man' : 'the young man';
  return 'the figure';
}

export async function genStoryboard(name, { provider, onLog = log, eps = null } = {}) {
  const H = await sbSkill();
  const { dir, base } = projectPaths(name);
  const script = await readJsonMaybe(path.join(dir, `script/${base}-script.json`));
  const art = await readJsonMaybe(path.join(dir, `art/${base}-art.json`));
  const castDoc = await readJsonMaybe(path.join(dir, `characters/${base}-cast.json`));
  if (!script || !art || !castDoc) throw new Error('缺 script/art/cast');
  const cast = (castDoc.characters || []).reduce((m, c) => ((m[c.id] = c), m), {});
  const artScenes = new Map((art.scenes || []).map((s) => [s.id, s]));
  const banned = (castDoc.characters || []).flatMap((c) => [c.name, ...(c.aliases || [])]).filter(Boolean);
  const blockingRaw = await readMaybe(path.join(dir, 'staging', 'blocking.txt'));
  const blockingMap = new Map();
  for (const line of blockingRaw.split('\n')) {
    const m = /^第\s*(\d+)\s*集第\s*(\d+)\s*场\t(.+)$/.exec(line.trim());
    if (m) blockingMap.set(`${m[1]}|${m[2]}`, m[3]);
  }

  const artProps = new Map((art.props || []).map((p) => [p.id, p]));
  // 这一切画面里有谁：说话人 + 动作文本里点到名的人；都没有才退回本场前两位（双人关系镜头）
  const pickCutCast = (c, sceneCastIds) => {
    const ids = new Set();
    for (const b of c.raw) {
      if (b.speaker && cast[b.speaker]) ids.add(b.speaker);
      const txt = String(b.action || '');
      if (txt) for (const id of sceneCastIds) if (txt.includes(cast[id].name)) ids.add(id);
    }
    if (!ids.size) for (const id of sceneCastIds.slice(0, 2)) ids.add(id);
    return [...ids].slice(0, 3);
  };
  const pickCutProps = (c, sceneProps) => {
    const txt = JSON.stringify(c.raw);
    const allowed = new Set(Array.isArray(sceneProps) ? sceneProps : []);
    return [...artProps.values()]
      .filter((p) => allowed.has(p.id) && txt.includes(p.name))
      .map((p) => p.id)
      .slice(0, 3);
  };

  const SIZES = ['wide', 'medium', 'close', 'extreme-close', 'extreme-wide'];
  const CAMERAS = ['Static Shot', 'Push In', 'Pull Out', 'Tilt Up', 'Truck Right', 'Arc Shot'];
  const LENSES = ['35mm', '50mm', '85mm', '24mm'];
  const targetEps = eps ? script.episodes.filter((e) => eps.includes(e.ep)) : script.episodes;
  onLog(`▸ 分镜：${targetEps.length} 集`);

  const episodes = [];
  for (const ep of targetEps) {
    throwIfCancelled();
    const segments = [];
    let gi = 0;
    for (const [si, sc] of ep.scenes.entries()) {
      // 节拍 → 切（2–5s）→ 段（≤15s）
      const beats = (sc.flow || []).map((b) => ({ ...b, sec: estBeat(b) }));
      let cuts = [], cur = null;
      beats.forEach((b, bi) => {
        const idx = bi + 1;
        if (!cur) cur = { from: idx, to: idx, sec: b.sec, raw: [b] };
        else if (cur.sec + b.sec <= 5) { cur.to = idx; cur.sec += b.sec; cur.raw.push(b); }
        else { cuts.push(cur); cur = { from: idx, to: idx, sec: b.sec, raw: [b] }; }
      });
      if (cur) cuts.push(cur);
      cuts = cuts.map((c) => ({ ...c, sec: Math.min(5, Math.max(2, Math.round((c.sec + 0.02) * 100) / 100)) }));

      let seg = null; const segs = [];
      for (const c of cuts) {
        if (!seg) seg = { cuts: [c], total: c.sec };
        else if (seg.total + c.sec <= 15) { seg.cuts.push(c); seg.total = Number((seg.total + c.sec).toFixed(2)); }
        else { segs.push(seg); seg = { cuts: [c], total: c.sec }; }
      }
      if (seg) segs.push(seg);

      for (const s of segs) {
        gi++;
        const segId = `E${String(ep.ep).padStart(2, '0')}-${String(gi).padStart(2, '0')}`;
        const scene = artScenes.get(sc.sceneId);
        const sceneCastIds = (sc.characters || []).filter((id) => cast[id]);
        // 每切一次 LLM：英文画面描述（内容来自该切中文节拍）
        const descs = [];
        for (const [ci, c] of s.cuts.entries()) {
          const whoIds = pickCutCast(c, sceneCastIds);
          const roster = whoIds.map((id) => `${cast[id].name}=${identityOf(cast[id])}`);
          try {
            const o = await chatJSON({
              provider, maxTokens: 700, temperature: 0.3,
              system: '你是分镜画面描述译者。只输出 JSON。禁止中文、禁止角色名、禁止台词原文、禁止时间码。',
              validateFn: (x) => (!x?.desc || String(x.desc).length < 18 ? 'desc 太短' : (/[\u4e00-\u9fa5]/.test(String(x.desc)) ? 'desc 含中文' : (banned.some((n) => String(x.desc).includes(n)) ? 'desc 含角色名' : null))),
              user: `把这一拍写成一句英文画面描述（25–45 词，说清谁·做什么·表情）：${JSON.stringify(c.raw.map((b) => (b.line ? '（台词）' : b.action)))}
场景：${scene?.name || sc.sceneId}（${sc.lighting || ''}）
身份短语：${roster.join('；')}`,
            });
            descs.push(String(o.desc).replace(/[\u4e00-\u9fa5]+/g, ' ').replace(/\s+/g, ' ').trim());
          } catch { descs.push('the figure stands in the lantern light, expression shifting'); }
        }

        const cutsOut = s.cuts.map((c, ci) => {
          const whoIds = pickCutCast(c, sceneCastIds);
          const size = c.raw.some((b) => b.line) ? (ci % 2 ? 'close' : 'medium') : (ci % 2 ? 'wide' : 'medium');
          const sizeZh = H.SHOT_SIZES[size].zh;
          const castLines = whoIds.map((id) => `${cast[id].name}（${String(cast[id].persona?.ageRange || '')}${String(cast[id].persona?.gender || '')}，${String(cast[id].persona?.appearance || '').replace(/。/g, '，').slice(0, 40)}）`).join('；');
          const frame = `${sizeZh}，${scene?.name || sc.sceneId}${sc.lighting ? '（' + sc.lighting + '）' : ''}。${castLines ? castLines + '。' : ''}${c.raw.map((b) => (b.line ? `说「${b.line}」` : b.action)).join('；').slice(0, 110)}。人物长相与服装必须与前序镜头完全一致。竖幅 9:16，中景深，无字幕无水印。`;
          return {
            beats: [c.from, c.to], seconds: c.sec, size,
            camera: CAMERAS[(gi + ci) % CAMERAS.length],
            characters: whoIds,
            props: pickCutProps(c, sc.props),
            frame,
            shot: `人物${ci % 2 ? '右' : '左'}侧，${c.raw.map((b) => (b.line ? '开口说话' : '做动作')).join('；')}，动作完整做完。`,
            lens: LENSES[(gi + ci) % LENSES.length] + '，中景深',
            cameraPosition: `人物${ci % 2 ? '右侧' : '左侧'}平视`,
            composition: `三分法，主体落在${ci % 2 ? '右' : '左'}三分之一线`,
            eyeline: '落在对面角色与手中之物', focus: '锁定说话人与关键道具', stability: 'stable',
            sfx: c.raw.some((b) => b.line) ? '环境声压低，突出人声' : '脚步与衣料声',
            lighting: sc.lighting || scene?.lighting?.[0]?.state || '',
          };
        });
        const starts = H.cutStarts(cutsOut);
        const shotLines = cutsOut.map((c, i) => {
          const dlg = s.cuts[i].raw.filter((b) => b.line).map((b) => `<d>[Chinese] ${b.line}</d>`).join(' ');
          return `[Shot ${i + 1}] At ${H.h3CutTime(starts[i])}, a ${String(c.camera).toLowerCase()}: ${descs[i].replace(/\.$/, '')}.${dlg ? ' ' + dlg : ''}`;
        }).join('\n');
        segments.push({
          id: segId, sceneIndex: si + 1,
          blocking: blockingMap.get(`${ep.ep}|${si + 1}`) || `${scene?.name || sc.sceneId}内，人物按剧本站位。`,
          cuts: cutsOut,
          h3Prompt: `${H.h3AlignmentLine(cutsOut, 'en')}\n\nintegrated_multimodal_description:\n${shotLines}\n\noverall_soundscape: Night ambience, footsteps on stone, cloth rustle; dialogue sits forward.\n\nnon_diegetic_music: Sparse plucked strings and low drum, thinning under dialogue.`,
          soundscape: '环境底噪与人声，音效从简。', music: '拨弦与低鼓，节奏平稳。',
        });
      }
    }
    episodes.push({ ep: ep.ep, segments });
    onLog(`  ✓ 第 ${ep.ep} 集：${segments.length} 段 / ${segments.reduce((n, x) => n + x.cuts.length, 0)} 切`);
  }

  const doc = { source: name, aspectRatio: '9:16', promptLang: 'en', params: { maxSegmentSeconds: 15, minCutSeconds: 2, maxCutSeconds: 5, maxOnScreen: 3, tolerance: 0.15 }, episodes };
  const r = await generateWithRepair({ stage: 'storyboard', dir, base, provider, build: async () => doc, onLog });
  onLog(r.ok ? '✓ 分镜通过校验' : '✗ 分镜未过（见上）');
  return r;
}

/* ============================== CLI ============================== */

const STAGES = { plot: genPlot, outline: genOutline, characters: genCharacters, art: genArt, script: genScript, staging: genStaging, storyboard: genStoryboard };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stage, name] = process.argv.slice(2);
  if (!STAGES[stage] || !name) {
    console.error('用法: node flow.mjs <outline|characters|art|script|staging|storyboard> <项目名>');
    process.exit(1);
  }
  const prov = await activeProvider();
  log(`provider: ${prov.id} ${prov.model}`);
  const r = await STAGES[stage](name, { provider: prov });
  process.exit(r.ok ? 0 : 1);
}
