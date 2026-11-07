import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { executeWorkflow } from './custom-workflow.mjs';
import { getComfyUrl, getWorkflows } from '../settings.mjs';
import { concatLocal } from './concat-local.mjs';

const safe = (name) => {
  const s = String(name || '');
  if (!s || /[<>:"/\\|?*\x00-\x1f]/.test(s) || s === '.' || s === '..') throw new Error('资产名称包含不支持的文件名字符');
  return s;
};
async function dataFile(project, dir, suffix) {
  const files = (await readdir(path.join(project, dir))).filter((n) => n.endsWith(suffix)).sort();
  const name = files.find((n) => n.startsWith(path.basename(project))) || files[0];
  if (!name) throw new Error(`缺少 ${dir}/${suffix} 数据，请先完成前期阶段`);
  return JSON.parse(await readFile(path.join(project, dir, name), 'utf8'));
}
async function mediaFile(project, relative) {
  const full = path.join(project, relative);
  const stem = full.slice(0, -path.extname(full).length);
  for (const ext of ['.png', '.webp', '.jpg', '.jpeg', '.mp4', '.webm', '.mov', '.mkv']) {
    try { if ((await stat(stem + ext)).size > 0) return stem + ext; } catch {}
  }
  return null;
}

export function customWorkflowFor(task) {
  const workflows = getWorkflows();
  return (task === 'frames' ? workflows.frame || workflows.image : workflows[task === 'videos' ? 'video' : 'image']) && ['scenes', 'characters', 'frames', 'videos'].includes(task);
}

export async function productionJobs(project, task, { referenceMode } = {}) {
  if (task === 'scenes' || task === 'characters') {
    const items = task === 'scenes' ? (await dataFile(project, 'art', '-art.json')).scenes : (await dataFile(project, 'characters', '-cast.json')).characters;
    return (items || []).flatMap((item) => (task === 'scenes' ? ['sheet'] : ['full', 'bust']).map((variant) => ({
      id: item.id || item.name, name: item.name, prompt: item.image?.prompt ? item.image.prompt + (task === 'characters' ? (variant === 'full' ? '\nFull body character reference, head to feet visible.' : '\nHead and shoulders character portrait.') : '') : null,
      negative: item.image?.negativePrompt || '',
      out: `${task === 'scenes' ? 'art' : 'characters'}/images/${safe(item.name)}-${variant}.png`,
      refs: [], variant,
    })));
  }
  const storyboard = await dataFile(project, 'storyboard', '-storyboard.json');
  const art = await dataFile(project, 'art', '-art.json');
  const cast = await dataFile(project, 'characters', '-cast.json');
  const script = await dataFile(project, 'script', '-script.json');
  const names = new Map((cast.characters || []).map((c, i) => [c.id || `C${String(i + 1).padStart(2, '0')}`, c.name]));
  const jobs = [];
  for (const ep of storyboard.episodes || []) {
    const scenes = (script.episodes || []).find((e) => e.ep === ep.ep)?.scenes || [];
    for (const seg of ep.segments || []) {
      const id = safe(seg.id);
      const characters = [...new Set((seg.cuts || []).flatMap((c) => c.characters || []))];
      const characterFiles = characters.map((c) => `characters/images/${safe(names.get(c) || c)}-full.png`);
      if (task === 'videos') {
        jobs.push({ id, prompt: seg.h3Prompt, seconds: (seg.cuts || []).reduce((n, c) => n + Number(c.seconds || 0), 0),
          refs: referenceMode === 'cuts' ? (seg.cuts || []).slice(0, 4).map((_, i) => `frames/${id}/f${i + 1}.png`)
            : [`frames/${id}/f1.png`, ...characterFiles].slice(0, 4), out: `renders/segments/${id}.mp4` });
      } else {
        const sceneId = scenes[seg.sceneIndex - 1]?.sceneId;
        const scene = (art.scenes || []).find((s) => s.id === sceneId) || art.scenes?.[seg.sceneIndex - 1];
        for (const [index, cut] of (seg.cuts || []).entries()) {
          const charFiles = (cut.characters || []).map((c) => `characters/images/${safe(names.get(c) || c)}-full.png`);
          jobs.push({ id, frame: index + 1, prompt: cut.frame,
            refs: [...(scene ? [`art/images/${safe(scene.name)}-sheet.png`] : []), ...charFiles].slice(0, 4),
            out: `frames/${id}/f${index + 1}.png` });
        }
      }
    }
  }
  return jobs;
}

export async function runCustomProduction({ project, task, args = [], signal, onLog = () => {} }) {
  const kind = task === 'videos' ? 'video' : 'image';
  const workflows = getWorkflows();
  const workflow = task === 'frames' ? workflows.frame || workflows.image : workflows[kind];
  if (!workflow) throw new Error('尚未配置自定义工作流');
  if (task === 'videos' && args.includes('--concat-only')) {
    const files = [];
    for (const job of await productionJobs(project, 'videos')) {
      const file = await mediaFile(project, job.out);
      if (!file) throw new Error(`缺少视频段：${job.id}`);
      files.push(file);
    }
    await concatLocal({ files, output: path.join(project, 'renders', `${path.basename(project)}-成片-v1.mp4`), signal, onLog });
    return { code: 0 };
  }
  const getArg = (key) => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
  const only = (getArg('--only') || getArg('--seg'))?.split(',');
  const frames = getArg('--frames')?.split(',');
  const variant = getArg('--variant');
  const jobs = (await productionJobs(project, task, { referenceMode: workflow.referenceMode })).filter((job) =>
    (!only || only.some((id) => [job.id, job.name].includes(id))) &&
    (!frames || frames.includes(`${job.id}/f${job.frame}`)) && (!variant || job.variant === variant));
  if (!jobs.length) throw new Error('没有匹配到待生成的资产');
  for (const [index, job] of jobs.entries()) {
    signal?.throwIfAborted();
    if (!job.prompt || typeof job.prompt !== 'string') throw new Error(`${job.id} 缺少提示词`);
    if (!args.includes('--force') && await mediaFile(project, job.out)) { onLog(`跳过已有文件：${job.out}`); continue; }
    const refs = [];
    for (const [i, ref] of job.refs.entries()) {
      if (!workflow.bindings?.[i ? `image${i + 1}` : 'image']) continue;
      const file = await mediaFile(project, ref);
      if (!file) throw new Error(`缺少参考图：${ref}，请先生成对应图片`);
      refs[i] = file;
    }
    const configured = (key, fallback) => { const target = workflow.bindings?.[key]; return target ? workflow.graph[target[0]].inputs[target[1]] : fallback; };
    const fps = Number(configured('fps', 24));
    const values = { prompt: job.prompt, negative: job.negative || '', seed: randomInt(0, 2147483647),
      width: configured('width', 480), height: configured('height', 864), seconds: job.seconds || 5, frames: Math.round((job.seconds || 5) * fps), fps,
      prefix: `studio_${task}_${index + 1}` };
    onLog(`[${index + 1}/${jobs.length}] ${job.out} · ${workflow.name}`);
    const output = await executeWorkflow({ workflow, values, refs, kind, baseUrl: getComfyUrl(),
      out: path.join(project, job.out), signal, onLog });
    onLog(`已保存：${path.relative(project, output)}`);
  }
  return { code: 0 };
}
