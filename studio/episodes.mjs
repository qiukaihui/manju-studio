import { fileURLToPath } from 'node:url';
/**
 * episodes.mjs —— 按集 AI 操作：梗概 → 剧本、续写分集
 *
 * 用项目内的技能规范与校验脚本，让 Agent 只为「第 X 集」改 outline/script，
 * 其它集原样保留，最后跑 validate 到通过。
 */
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { runAgent } from './agent.mjs';

const SKILLS = process.env.DSH_SKILLS || process.env.SKILLS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

const SYS = `你是「漫剧工坊」的分集编剧 Agent。你只改一部剧的「某一集」，其它集一个字都不许动。

规则：
1. 只读任务里列出的文件；不要探索目录、不要读其他项目、不要读 studio/。
2. 修改 JSON 前先读原文，按 skill 的 schema 精确改；写回时保持其它集的字段原样。
3. 每次改完必须跑对应的 validate 脚本，报错就改，直到 exit code 0；不许绕过质量门。
4. 大文件分段写（先 write_file 主体，再用 bash heredoc 追加）。
5. 产物是中文；台词要口语、可演、带语气；不要把对白写成叙述。`;

async function readMaybe(p) { try { return await readFile(p, 'utf8'); } catch { return ''; } }

export async function runEpisodeAction({ project, ep, action, synopsisText = '', seconds = 120, onEvent, signal }) {
  const dir = path.resolve(project);
  const name = path.basename(dir);
  const epTag = `E${String(ep).padStart(2, '0')}`;
  const synDir = path.join(dir, 'docs', 'synopses');
  await mkdir(synDir, { recursive: true });
  const synPath = path.join(synDir, `${epTag}.md`);

  // 梗概落盘（若有输入）
  if (synopsisText && synopsisText.trim()) {
    await writeFile(synPath, `# 第 ${ep} 集梗概\n\n${synopsisText.trim()}\n`, 'utf8');
    onEvent?.({ type: 'log', line: `✓ 已保存梗概 → docs/synopses/${epTag}.md` });
  }

  const outlinePath = path.join(dir, 'outline', `${name}-outline.json`);
  const scriptPath = path.join(dir, 'script', `${name}-script.json`);
  const novelPath = path.join(dir, 'docs', '编剧-原稿.txt');
  const plotPath = path.join(dir, 'docs', '01-情节梳理.md');
  const synopsis = await readMaybe(synPath);

  const outlineText = await readMaybe(outlinePath);
  const scriptText = await readMaybe(scriptPath);

  const hasOutline = !!outlineText;
  const hasScript = !!scriptText;

  const task = `项目：${name}（工作目录 ${dir}）
集数序号：第 ${ep} 集（标签 ${epTag}），单集目标 ${seconds} 秒。

【输入】
- 原稿：${novelPath}
- 情节梳理（若有）：${plotPath}
- 本集梗概（若有）：${synPath}${synopsis ? '\n\n梗概正文：\n' + synopsis.slice(0, 4000) : ''}
- 大纲 outline.json：${hasOutline ? outlinePath : '（尚不存在）'}
- 剧本 script.json：${hasScript ? scriptPath : '（尚不存在）'}

【任务】${action === 'continue'
    ? `续写第 ${ep} 集：先补齐大纲里第 ${ep} 集的分集梗概（synopsis/hook/suspense/场景人物道具认领），再把第 ${ep} 集的剧本 scenes 写进 script.json。`
    : `为第 ${ep} 集写剧本：确保大纲里有第 ${ep} 集，再把本集 scenes 写进 script.json（其它集不动）。`}

【必须遵循】
1. 剧本规范读这个 skill：${SKILLS}/novel-script/SKILL.md 及其点名的 references；大纲规范：${SKILLS}/novel-outline/SKILL.md。
2. 若 outline.json 不存在或没有第 ${ep} 集：先创建/补齐（schema 见技能 references），跑
   node ${SKILLS}/novel-outline/scripts/novel-outline.mjs validate ${outlinePath}
3. 若 script.json 不存在：按 novel-script 的 schema 新建，只含第 ${ep} 集也要能通过校验所需的字段。
4. 写/改 script.json 时：只替换第 ${ep} 集的 scenes，其它集原样保留；台词要有说话人(Cxx)与 delivery；每场 ≤${seconds} 秒（可用 params 调整容忍度但不要超）。
5. 跑校验到通过：
   node ${SKILLS}/novel-script/scripts/novel-script.mjs validate ${scriptPath} --outline ${outlinePath}
6. 完成后用 3 行汇报：本集场数、总时长估算、你做了哪些取舍。`;

  onEvent?.({ type: 'stage_start', id: `ep${ep}`, label: `${epTag} ${action === 'continue' ? '续写' : '写剧本'}`, kind: 'ai', index: 1, total: 1 });
  const t0 = Date.now();
  const r = await runAgent({
    systemPrompt: SYS,
    task,
    workdir: dir,
    maxTurns: 50,
    maxTokens: 24000,
    onEvent: (e) => onEvent?.(e),
    signal,
    label: `${epTag} 剧本`,
  });
  onEvent?.({ type: 'stage_done', id: `ep${ep}`, label: `${epTag} 完成`, ms: Date.now() - t0, index: 1, total: 1 });
  return r;
}
