#!/usr/bin/env node
/**
 * produce.mjs —— 一键生产编排器
 *
 * 两类阶段：
 *  - ai  ：交给内置 Agent（agent.mjs）读 skill 文档、写 JSON、跑 validate 到通过
 *  - cmd ：跑确定性脚本（出图/出片/超分/拼接/报告），日志逐行推送
 *
 * 所有事件通过 onEvent 抛给 server → SSE → 界面：
 *   stage_start / stage_done / stage_error / stage_skip
 *   ai_delta / ai_message / tool_call / tool_result / turn
 *   log
 */
import { runCommand as runCmd } from './lib/command-runner.mjs';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.mjs';
import { customWorkflowFor, runCustomProduction } from './lib/custom-production.mjs';
import { genPlot, genOutline, genCharacters, genArt, genScript, genStaging, genStoryboard, setActiveSignal } from './flow.mjs';

const SKILLS = process.env.DSH_SKILLS || process.env.SKILLS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

const BASE_SYSTEM = `你是「漫剧工坊」流水线的执行 Agent，负责把一部小说做成竖屏 AI 漫剧的前期资产。

工作方式：
1. 先读技能文档（read_file），严格按其中的步骤、字段结构、质量门执行；不要凭记忆臆造 schema。
2. 用 write_file 把产物写到指定路径；用 bash 跑技能自带的 validate 脚本。
3. validate 不通过就按报错逐条修，改完重跑，**直到 exit code 0**。不允许绕过质量门、不允许改脚本、不允许把校验关掉。
4. **只在工作目录内写产物**：write_file 的 path 一律用相对路径（如 outline/xxx.json）。技能目录（~/.agents/skills/...）与其 scripts **只读**——validate 怎么调用任务里已经写好，你不需要读脚本源码、不要在技能目录里 grep/sed/临时建文件、不要调查校验器实现。除任务列出的输入与技能文档外不读任何文件；不要浏览 其它磁盘、主目录、别的项目、studio/。**跳过一切探索，读完指定输入立刻开始产出。**
5. bash 也只允许：跑任务里给定的 validate/render/export 命令、以及往**本项目目录**里追加文件（cat >> 相对路径）。不要在技能目录建临时文件、不要 p1.md/p2.md 这类中间稿落在别处。
6. **大文件必须分段写**：工具单次输出上限约 8K token。任何超过 5KB 的产物，拆成 3–6 次写入——第一次 write_file 写骨架/前段，之后用 bash 追加（cat >> 文件 配 heredoc）；JSON 分段时按数组元素切，最后一段补齐括号。**每写完一段就用 bash 跑一次 JSON.parse 自检（node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' 文件名），报错就继续补下一段，绝不允许交出一个解析不过的文件。**
5. 关键决策（砍了什么线、合了哪些人、爆点落在哪）在最终回复里用 3–5 行说清。

风格与语言：
- 输出物为中文（除技能的英文提示词字段外）。
- 画风统一：国风动画·赛璐璐漫剧向（漫剧）。
- 项目工作目录就是你的 cwd，相对路径都以它为准。`;

function readSkill(skill) {
  if (!skill) return null;
  const p = path.join(SKILLS, skill, 'SKILL.md');
  return existsSync(p) || existsSync(p + '.enc') ? p : null;
}


function relay(e, onEvent, label) {
  if (e.type === 'ai_message') onEvent({ type: 'log', line: `· ${String(e.text).replace(/\n/g, ' ').slice(0, 220)}` });
  else if (e.type === 'tool_call') onEvent({ type: 'log', line: `▸ ${e.name} ${truncateArgs(e.args)}` });
  else if (e.type === 'tool_result') onEvent({ type: 'log', line: `← ${String(e.brief || e.result || '').replace(/\n/g, ' ').slice(0, 150)}` });
  else if (e.type === 'turn') onEvent({ type: 'log', line: `… ${label}：第 ${e.turn} 轮` });
  else if (e.type === 'agent_done') onEvent({ type: 'log', line: `✓ ${label}：模型结束（${e.turns} 轮 / ${(e.ms / 1000).toFixed(0)}s）` });
  else onEvent(e);
}

function truncateArgs(a) { try { const j = typeof a === 'string' ? JSON.parse(a || '{}') : (a || {}); if (j.content) j.content = `<${String(j.content).length} 字>`; if (j.command) j.command = String(j.command).slice(0, 100); return JSON.stringify(j).slice(0, 160); } catch { return ''; } }


/** 按集范围取该集的段号（用于 --seg / --only 过滤）；scope 为空返回 null */
export function scopeSegIds(project, base, scopeEps) {
  if (!scopeEps || !scopeEps.length) return null;
  try {
    const sb = JSON.parse(readFileSync(path.join(project, 'storyboard', `${base}-storyboard.json`), 'utf8'));
    const ids = [];
    for (const ep of sb.episodes || []) if (scopeEps.includes(ep.ep)) for (const sg of ep.segments || []) ids.push(sg.id);
    return ids.length ? ids : null;
  } catch { return null; }
}

/* --------------------------------- 阶段定义 -------------------------------- */
export function buildStages({ project, novelPath, episodes, seconds, genre, style, options = {}, novelText = '', aspect = '9:16', resolution = '720p', provider = null, scopeEps = null }) {
  const P = (rel) => path.join(project, rel);
  const out = (stage, file) => P(`${stage}/${file}`);
  // 沿用项目已有文件前缀（老项目可能叫 渡口-outline.json，而目录名是 样例-渡口）
  const dirName = path.basename(project);
  let base = dirName;
  try {
    const od = P('outline');
    const list = readdirSync(od).filter((f) => f.endsWith('-outline.json'));
    if (!list.includes(`${dirName}-outline.json`) && list.length) base = list[0].replace(/-outline\.json$/, '');
  } catch {}
  const paths = {
    outline: out('outline', `${base}-outline.json`),
    cast: out('characters', `${base}-cast.json`),
    art: out('art', `${base}-art.json`),
    script: out('script', `${base}-script.json`),
    staging: out('staging', `${base}-staging.json`),
    storyboard: out('storyboard', `${base}-storyboard.json`),
    plot: P('docs/01-情节梳理.md'),
    novel: P('docs/编剧-原稿.txt'),
  };

  const ai = (id, label, skill, taskText, outFile) => ({
    id, label, kind: 'ai', outFile,
    run: async ({ onEvent, signal }) => {
      const skillPath = readSkill(skill);
      const system = `${BASE_SYSTEM}\n\n【本阶段技能】${skillPath ? skillPath : '（无独立 skill，按下述要求执行）'}\n只读这一个 SKILL.md 以及它明确点名的 references；不要读别的目录、别的项目、示例工程。`;
      const r = await runAgent({
        systemPrompt: system,
        task: taskText,
        workdir: path.resolve(project),
        maxTurns: 60,
        maxTokens: 8000,
        onEvent: (e) => relay(e, onEvent, label),
        signal,
        label,
        provider,
      });
      return r;
    },
  });

  const ai2 = (id, label, fn, outFile) => ({
    id, label, kind: 'aigen', outFile,
    run: async ({ onEvent, signal }) => {
      setActiveSignal(signal);
      try {
        const r = await fn(path.basename(path.resolve(project)), { provider, signal, onLog: (line) => onEvent({ type: 'log', line }) });
        if (signal?.aborted) { const e = new Error(`${label} 已取消`); e.cancelled = true; throw e; }
        if (!r.ok) throw new Error(`${label} 校验未通过（见上方日志）`);
        return r;
      } catch (e) {
        if (signal?.aborted || e?.cancelled) { const x = new Error(`${label} 已取消`); x.cancelled = true; throw x; }
        throw e;
      } finally {
        setActiveSignal(null);
      }
    },
  });

  const cmd = (id, label, cwdRel, cmdFile, args, extra = {}) => ({
    id, label, kind: 'cmd',
    run: async ({ onEvent, signal }) => {
      const task = { images: 'scenes', images2: 'characters', images3: 'frames', videos: 'videos', concat: 'videos' }[id];
      if (task && customWorkflowFor(task)) {
        return runCustomProduction({ project: path.resolve(project), task, args, signal,
          onLog: (line) => onEvent({ type: 'log', line }) });
      }
      if (process.env.DSH_DESKTOP === '1' && task) throw new Error('请先在设置中配置并保存出图／出视频工作流');
      const r = await runCmd({ cmd: cmdFile, args, cwd: path.resolve(project, cwdRel || '.'), onEvent, signal, ...extra });
      if (r.cancelled) { const e = new Error(`${label} 已取消`); e.cancelled = true; throw e; }
      if (r.timedOut) throw new Error(`${label} 超时（并非用户取消，可重试）`);
      if (r.code !== 0) throw new Error(`${label} 退出码 ${r.code}（日志里有具体报错）`);
      return r;
    },
  });

  const stages = [];
  const segIds = scopeSegIds(project, base, scopeEps);
  const segArgs = segIds ? segIds.join(',') : null;

  if (options.plot !== false) stages.push(ai2('plot', '理顺情节', genPlot, paths.plot));

  stages.push(ai2('outline', '改编大纲', genOutline, paths.outline));
  stages.push(ai2('characters', '角色设定', genCharacters, paths.cast));

  stages.push(ai2('art', '美术设定', genArt, paths.art));

    stages.push(ai2('script', '剧本', genScript, paths.script));


    stages.push(ai2('staging', '开场站位', genStaging, paths.staging));


    stages.push(ai2('storyboard', '分镜', genStoryboard, paths.storyboard));


  if (options.images !== false) {
    stages.push(cmd('images', '出图片（场景/角色/关键帧）', 'scripts', 'gen_scenes.mjs', []));
    stages.push(cmd('images2', '出角色锚点图', 'scripts', 'gen_characters.mjs', []));
    stages.push(cmd('images3', '出分镜关键帧', 'scripts', 'gen_frames.mjs', segArgs ? ['--seg', segArgs] : []));
  }
  if (options.videos !== false) stages.push(cmd('videos', '生成视频段（H3）', 'scripts', 'gen_videos.mjs', segArgs ? ['--only', segArgs] : []));
  if (options.upscale !== false) stages.push(cmd('upscale', `SeedVR2 超分（${resolution}）`, 'scripts', 'gen_upscale.mjs', ['--res', resolution === '1080p' ? '1080' : '720'].concat(segArgs ? ['--only', segArgs] : [])));
  if (options.concat !== false) {
    // 开了超分就拼超分目录的段，并且成片名带上清晰度；没开就拼原始段
    const upDir = resolution === '1080p' ? 'upscale1080' : 'upscale720';
    const upName = `${path.basename(path.resolve(project))}-成片-${resolution}.mp4`;
    const concatArgs = options.upscale !== false ? ['--concat-only', '--concat-from', upDir, '--concat-out', upName] : ['--concat-only'];
    stages.push(cmd('concat', options.upscale !== false ? `拼接成片（${resolution}）` : '拼接成片', 'scripts', 'gen_videos.mjs', concatArgs));
  }
  if (options.report !== false) stages.push(cmd('report', '合成总报告', 'scripts', null, [], {}));

  const OUTS = {
    plot: paths.plot, outline: paths.outline, characters: paths.cast,
    art: paths.art, script: paths.script, staging: paths.staging, storyboard: paths.storyboard,
  };
  for (const st of stages) if (['ai', 'aigen'].includes(st.kind) && OUTS[st.id]) st.outFile = OUTS[st.id];
  return { stages, paths };
}

/* --------------------------------- 开工前预览 -------------------------------- */
/** 动工前算清楚：哪些阶段会真跑、哪些跳过、重跑前期会让什么失效。只用文件状态，不启动任何生成。 */
export function previewPlan(params) {
  const { stages, paths } = buildStages(params);
  const only = Array.isArray(params.only) ? params.only : null;
  const sel = only && only.length ? stages.filter((s) => only.includes(s.id)) : stages;
  const forcePre = !!params.options?.forcePre;
  const PRE = ['outline', 'characters', 'art', 'script', 'staging', 'storyboard'];

  const countJson = (p, pick) => { try { const d = JSON.parse(readFileSync(p, 'utf8')); return pick(d); } catch { return null; } };
  const sbPath = paths.storyboard;
  const sbSums = countJson(sbPath, (d) => {
    const sgs = (d.episodes || []).flatMap((e) => e.segments || []);
    return { cuts: sgs.reduce((m, s) => m + (s.cuts || []).length, 0), segs: sgs.length };
  });
  const cutCount = sbSums?.cuts || null;
  const planSegs = countJson(path.join(path.dirname(sbPath), 'video-plan.json'), (d) => (d.segments || d.items || []).length);
  const segCount = planSegs || sbSums?.segs || null;

  const rows = sel.map((s) => {
    let willRun = true, reason = '';
    if (['ai', 'aigen'].includes(s.kind) && s.outFile && existsSync(s.outFile)) {
      let usable = true;
      if (/\.json$/i.test(s.outFile)) { try { JSON.parse(readFileSync(s.outFile, 'utf8')); } catch { usable = false; } }
      else if (/\.md$/i.test(s.outFile)) { try { if (statSync(s.outFile).size < 500) usable = false; } catch { usable = false; } }
      if (!usable) { willRun = true; reason = /\.json$/i.test(s.outFile) ? '现有产物不是合法 JSON（上次写坏），必须重跑' : '现有文档过短（上次写坏），必须重跑'; }
      else if (forcePre) { willRun = true; reason = '勾了「重跑前期」：会覆盖现有产物'; }
      else { willRun = false; reason = '已有产物，跳过'; }
    }
    if (!reason && ['ai', 'aigen'].includes(s.kind) && s.outFile && !existsSync(s.outFile)) reason = '还没有产物，会从头生成';
    if (!reason && s.kind === 'cmd' && willRun) reason = '会启动脚本；脚本内部会跳过已存在的单张/单段产物';
    return { id: s.id, label: s.label, kind: s.kind, willRun, reason, outFile: s.outFile || null };
  });

  const rerunPre = rows.filter((r) => r.willRun && PRE.includes(r.id)).map((r) => r.id);
  const warnings = [];
  if (rerunPre.length) {
    const fixed = ['outline', 'characters', 'art', 'script', 'staging'].filter((x) => rerunPre.includes(x));
    const sb = rerunPre.includes('storyboard');
    const parts = [];
    if (fixed.length) parts.push(`大纲/角色/美术/剧本/站位（${fixed.join('、')}）`);
    if (sb) parts.push('分镜');
    warnings.push(`这一次会重跑前期：${parts.join(' + ')}。前期一改，后面的关键帧计划、视频计划就作废${cutCount ? `（分镜 ${cutCount} 切` : '（'}${segCount ? `／视频 ${segCount} 段` : ''}${cutCount || segCount ? '）' : ''}；已存在的关键帧与视频默认仍会跳过，成片可能和新分镜对不上。只想补视频就别勾「重跑前期」。`);
  }
  if (rows.some((r) => r.willRun && r.id === 'images3') && cutCount) warnings.push(`出关键帧：${cutCount} 张，按单张约 20 秒、4 并发估算约 ${Math.ceil((cutCount * 20) / 4 / 60)} 分钟。`);
  if (rows.some((r) => r.willRun && r.id === 'videos')) warnings.push(`生成视频段：${segCount ? segCount + ' 段' : '全部段'}，每段约 5–10 分钟${segCount ? `，全跑约 ${Math.round((segCount * 7) / 60)} 小时（已存在的段会跳过）` : ''}。`);
  if (rows.some((r) => r.willRun && r.id === 'upscale')) warnings.push('SeedVR2 超分比出片慢得多（720p 约 40 分钟/段），别和高清需求一起点。');
  if (!rows.some((r) => r.willRun)) warnings.push('按当前选项，所有阶段都会跳过；要重出就勾「重跑前期」或只选框里某几个阶段。');
  return { rows, warnings, summary: { total: rows.length, willRun: rows.filter((r) => r.willRun).length, skip: rows.filter((r) => !r.willRun).length } };
}

/* --------------------------------- 执行入口 -------------------------------- */
export async function produce({ project, novelPath, episodes, seconds, genre, style, options = {}, only = null, novelText = '', aspect = '9:16', resolution = '720p', onEvent, signal, provider = null, scopeEps = null }) {
  if (!novelText && novelPath) { try { novelText = await readFile(novelPath, 'utf8'); } catch {} }
  let { stages } = buildStages({ project, novelPath, episodes, seconds, genre, style, options, novelText, aspect, resolution, provider, scopeEps });
  if (Array.isArray(only) && only.length) stages = stages.filter((s) => only.includes(s.id));
  const total = stages.length;
  onEvent({ type: 'produce_start', total, project });
  let done = 0;
  const started = Date.now();
  for (const st of stages) {
    if (signal?.aborted) { onEvent({ type: 'produce_done', cancelled: true, done, total }); return { cancelled: true }; }
    // 已有产物默认跳过，避免覆盖（--forcePre 可强制重跑）
    if (['ai', 'aigen'].includes(st.kind) && st.outFile && existsSync(st.outFile)) {
      // JSON 产物先试解析：上次写到一半被截断的坏文件不能当「已完成」
      let usable = true;
      if (/\.json$/i.test(st.outFile)) {
        try { JSON.parse(await readFile(st.outFile, 'utf8')); } catch { usable = false; }
      } else if (/\.md$/i.test(st.outFile)) {
        try { if (statSync(st.outFile).size < 500) usable = false; } catch { usable = false; }
      }

      if (usable && !options.forcePre) {
        onEvent({ type: 'stage_skip', id: st.id, label: st.label, reason: '已有产物，跳过（强制重跑请勾选“重跑前期”）' });
        continue;
      }
      if (!usable) {
        // 产物坏了/太短：不要停下来等用户勾「重跑前期」，直接自动重跑这一阶
        const what = /\.json$/i.test(st.outFile) ? '不是合法 JSON（多半上次写到一半被截断）' : '内容过短（多半上次没写出来）';
        onEvent({ type: 'log', line: `⚠ ${st.label} 的旧产物${what}，自动重跑这一阶` });
        onEvent({ type: 'stage_repair', id: st.id, label: st.label, reason: what });
      }
    }
    // 阶段级自动重试：断网、GPU 抖动、子进程被杀这类「下一次就能过」的失败，不该让整条产线停下。
    // 重试是安全的：产物已存在的会被脚本/阶段跳过逻辑跳过，不会重复出图出片。
    const stageRetries = Number(options.stageRetries ?? 2);
    let attempt = 0;
    let finalErr = null;
    for (attempt = 0; attempt <= stageRetries; attempt++) {
      if (signal?.aborted) { onEvent({ type: 'produce_done', cancelled: true, done, total }); return { cancelled: true, done, total }; }
      if (attempt > 0) {
        const waitMs = Math.min(60000, 5000 * attempt * attempt);
        onEvent({ type: 'stage_retry', id: st.id, label: st.label, attempt, max: stageRetries, waitMs, error: String(finalErr?.message || finalErr || '').slice(0, 200) });
        await new Promise((r) => setTimeout(r, waitMs));
        if (signal?.aborted) { onEvent({ type: 'produce_done', cancelled: true, done, total }); return { cancelled: true, done, total }; }
      }
      onEvent({ type: 'stage_start', id: st.id, label: st.label, kind: st.kind, index: done + 1, total, attempt });
      const t0 = Date.now();
      const stageAc = new AbortController();
      const onParent = () => stageAc.abort();
      signal?.addEventListener('abort', onParent, { once: true });
      // A command stage is a whole batch, potentially many hours. Its scripts bound individual items.
      const stageMs = st.kind === 'cmd' ? 0 : (st.kind === 'ai' ? 40 * 60 * 1000 : 6 * 3600 * 1000);
      const hb = setInterval(() => onEvent({ type: 'heartbeat', id: st.id, label: st.label, elapsedMs: Date.now() - t0 }), 20000);
      let timedOut = false;
      const timer = stageMs > 0 ? setTimeout(() => { timedOut = true; stageAc.abort(); }, stageMs) : null;
      try {
        if (st.id === 'report') {
          const P = path.resolve(project);
          const code = await runCmd({
            cmd: path.join(SKILLS, '..', 'tools', 'report.mjs'),
            args: ['--from', P, '--out', path.join(P, 'report.html')],
            cwd: path.resolve(project), onEvent, signal: stageAc.signal,
          });
          if (code.cancelled) { const e = new Error('报告合成已取消'); e.cancelled = true; throw e; }
          if (code.code !== 0) throw new Error('报告合成失败');
        } else {
          await st.run({ onEvent, signal: stageAc.signal });
        }
        finalErr = null;
        break;
      } catch (err) {
        if ((err?.cancelled && !timedOut) || signal?.aborted) {
          clearInterval(hb); clearTimeout(timer); signal?.removeEventListener('abort', onParent);
          onEvent({ type: 'stage_cancelled', id: st.id, label: st.label });
          onEvent({ type: 'produce_done', cancelled: true, done, total });
          return { cancelled: true, done, total };
        }
        finalErr = err;
        const msg = timedOut ? `阶段超时（${Math.round(stageMs / 60000)} 分钟无完成）` : String(err?.message || err);
        onEvent({ type: 'stage_error', id: st.id, label: st.label, error: msg, attempt, willRetry: attempt < stageRetries });
        if (attempt >= stageRetries) {
          clearInterval(hb); clearTimeout(timer); signal?.removeEventListener('abort', onParent);
          onEvent({ type: 'produce_done', failed: st.id, error: msg, done, total });
          return { failed: st.id, error: msg, done, total };
        }
      } finally {
        clearInterval(hb); clearTimeout(timer);
        signal?.removeEventListener('abort', onParent);
      }
    }
    if (finalErr) { onEvent({ type: 'produce_done', failed: st.id, error: String(finalErr?.message || finalErr), done, total }); return { failed: st.id, error: String(finalErr?.message || finalErr), done, total }; }
    done++;
    onEvent({ type: 'stage_done', id: st.id, label: st.label, ms: 0, index: done, total, stagesDone: done });
  }
  const ms = Date.now() - started;
  onEvent({ type: 'produce_done', ms, done, total });
  return { ms, done, total };
}
