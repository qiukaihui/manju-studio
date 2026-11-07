#!/usr/bin/env node
/**
 * ui2api.mjs — ComfyUI UI(workflow) → API(prompt) 格式转换器
 *
 * 零依赖（Node >= 18，内置 fetch / crypto / zlib）。
 *
 * 用法：
 *   node ui2api.mjs <workflow.json> --list
 *   node ui2api.mjs <workflow.json> --out api.json [--set K=V]... [--seed random|123] [--no-prune]
 *   node ui2api.mjs <workflow.json> --print --set KSampler.seed=42
 *
 * 覆盖参数 K 的写法（优先级从高到低匹配）：
 *   "459:452.prompt=..."   扁平 node id（子图内部节点是 <实例id>:<内部id>）
 *   "452.prompt=..."       子图内部局部 id，全局唯一时可用
 *   "TextEncodeQwenImage21.prompt=..."   class_type
 *   "*seed=..."            class_type 通配（给所有含 seed 的节点）
 * 值写法：
 *   =768          数字 / true / false / JSON 数组对象 会走 JSON.parse
 *   =hello world  JSON.parse 失败则当字符串
 *   =@prompt.txt  从文件读文本（去掉末尾单个换行）—— 长提示词用这个
 *   =$RANDOM      随机 48bit 整数（seed 用）
 *
 * --set 还会自动把 value 的 JSON 化失败当字符串；--overrides-file 支持一次性给大堆覆盖：
 *   { "KSampler.seed": 42, "SaveImageAdvanced.filename_prefix": "abc" }
 *
 * 其它选项：
 *   --prune / --no-prune   只保留输出节点(SaveImage、PreviewImage 等)的祖先链（默认 prune，减少服务器加载无用模型）
 *   --keep K               强制保留某节点（可重复，支持 class_type 或 id）
 *   --seed S               等价于 --set "*seed=S"（S 可为 random）
 *   --list                 列出展开后的所有节点、class_type、可覆盖字段（含当前值）
 *   --object-info URL      从服务器取 /object_info，用于 widgets_values(位置数组) 无 named 时的字段名推断，
 *                          以及 --validate 时的字段/枚举校验
 *   --validate             用 object_info 校验每个节点的输入名与枚举值（只警告，不阻断）
 *   --quiet                少打印
 *
 * 也作为库使用：
 *   import { loadWorkflow, convert } from './ui2api.mjs';
 *   const { api, warnings, nodes } = convert(uiWorkflow, { overrides: {...}, prune: true });
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

// UI 里存在、但不是真实节点、不进 API 图的东西
const UI_ONLY_TYPES = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode', 'Comment']);

// 输出节点的 class_type 前缀/全名：给 prune 做根
const OUTPUT_CLASS_RE = /^(SaveImage|SaveVideo|SaveAudio|PreviewImage|PreviewVideo|PreviewAudio|SaveAnimatedWEBP|SaveWEBM|VHS_|SaveLatent)/;

// 只服务于 UI 交互、进 API 图只会惹校验告警（"Required input is missing — compare_view"）的节点
const UI_ONLY_OUTPUT_TYPES = new Set(['ImageCompare']);

// 只影响 UI 交互、不属于 API 输入的 widget
const DROP_WIDGET_KEYS = new Set(['control_after_generate']);
const DROP_WIDGET_SUFFIX = '.control_after_generate';

// mode: 0 正常, 2 静音(从不执行), 4 旁路(bypass)
const MODE_NEVER = new Set([2, 4]);

const log = (...a) => console.log(...a);
const warnTo = (warnings, msg) => { if (!warnings.includes(msg)) warnings.push(msg); };

/* ------------------------------------------------------------------ *
 * 读文件
 * ------------------------------------------------------------------ */

export function loadWorkflow(path) {
  const raw = readFileSync(path, 'utf8');
  let wf;
  try {
    wf = JSON.parse(raw);
  } catch (e) {
    throw new Error(`工作流不是合法 JSON: ${path} — ${e.message}`);
  }
  // 兼容直接拿 API 格式当输入（幂等）
  if (!Array.isArray(wf.nodes) && typeof wf === 'object') {
    const keys = Object.keys(wf);
    if (keys.length && keys.every(k => wf[k] && wf[k].class_type)) {
      return { alreadyApi: true, api: wf };
    }
  }
  if (!Array.isArray(wf.nodes)) throw new Error(`不是 UI 格式 workflow（缺 nodes 数组）: ${path}`);
  return { alreadyApi: false, workflow: wf };
}

/* ------------------------------------------------------------------ *
 * links 归一化：外层是数组 [id, o, os, t, ts, type]，子图内是对象
 * ------------------------------------------------------------------ */

function normalizeLinks(links, warnings, scopeName) {
  if (!Array.isArray(links)) return [];
  return links.map((l) => {
    if (Array.isArray(l)) {
      return { id: l[0], origin: l[1], originSlot: l[2], target: l[3], targetSlot: l[4], type: l[5] };
    }
    if (l && typeof l === 'object') {
      return {
        id: l.id ?? l.link_id,
        origin: l.origin_id ?? l.originId,
        originSlot: l.origin_slot ?? l.originSlot,
        target: l.target_id ?? l.targetId,
        targetSlot: l.target_slot ?? l.targetSlot,
        type: l.type,
      };
    }
    warnTo(warnings, `${scopeName}: 无法识别的 link 结构 ${JSON.stringify(l)}`);
    return null;
  }).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * widget 取值
 * ------------------------------------------------------------------ */

/** 从 node.widgets_values_named 取；没有 named 时按 objectInfo 的 input_order 位置映射 */
function nodeWidgets(node, ctx, warnings) {
  const out = {};
  const named = node.widgets_values_named;
  if (named && typeof named === 'object' && !Array.isArray(named)) {
    for (const [k, v] of Object.entries(named)) {
      if (DROP_WIDGET_KEYS.has(k) || k.endsWith(DROP_WIDGET_SUFFIX)) continue;
      out[k] = v;
    }
    return out;
  }
  const vals = node.widgets_values;
  if (Array.isArray(vals) && vals.length) {
    const order = widgetOrder(node.type, ctx);
    if (order) {
      vals.forEach((v, i) => {
        const key = order[i];
        if (!key) return;
        if (DROP_WIDGET_KEYS.has(key) || key.endsWith(DROP_WIDGET_SUFFIX)) return;
        out[key] = v;
      });
    } else {
      warnTo(warnings, `节点 ${node.id} (${node.type}) 只有位置式 widgets_values 且缺少 --object-info，字段名无法确定`);
    }
  }
  return out;
}

/**
 * 判断 object_info 里一个输入是否会被前端渲染成 widget（决定它是否占 widgets_values 的一个位置）。
 * 规则：forceInput 一定是 socket；INT/FLOAT/STRING/BOOLEAN/COMBO 和 COMFY_* 动态控件是 widget；
 * 其余全大写单词类型（MODEL/CLIP/IMAGE/VIDEO/AUDIO/LATENT/MASK…）是 socket。
 */
function isWidgetType(t, opts = {}) {
  if (opts.forceInput) return false;
  if (Array.isArray(t)) return true;
  if (['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(t)) return true;
  if (typeof t === 'string' && t.startsWith('COMFY_')) return true;
  if (typeof t === 'string' && /^[A-Z0-9_]+$/.test(t) && t.length >= 3) return false; // 全大写=socket
  return false;
}

/** 用 /object_info 推出该 class 的 widget 顺序（与前端 widgets_values 位置对齐） */
function widgetOrder(classType, ctx) {
  const oi = ctx.objectInfo?.[classType];
  if (!oi) return null;
  const order = [];
  const push = (name) => {
    const spec = oi.input?.required?.[name] ?? oi.input?.optional?.[name];
    if (!spec) return;
    const t = spec[0];
    const opts = spec[1] || {};
    if (!isWidgetType(t, opts)) return;
    if (opts?.socketless) return; // 纯预览用的假 widget，不进 values
    order.push(name);
    if (opts?.control_after_generate) order.push(`${name}.control_after_generate`);
  };
  const io = oi.input_order || {};
  for (const group of ['required', 'optional']) {
    for (const name of (io[group] || [])) push(name);
  }
  return order.length ? order : null;
}

/* ------------------------------------------------------------------ *
 * 图展开（子图递归）
 * ------------------------------------------------------------------ */

function buildScope({ nodes, links, sg, parent, prefix, subgraphIndex, warnings, name }) {
  const scope = {
    name,
    prefix,
    parent,            // { scope, instNode } | null
    sg,                // subgraph definition | null
    inputNodeId: sg?.inputNode?.id ?? null,
    outputNodeId: sg?.outputNode?.id ?? null,
    nodes: nodes || [],
    links: normalizeLinks(links, warnings, name),
    nodeById: new Map(),
    linkMap: new Map(),
    children: new Map(), // localNodeId -> childScope
    outputs: new Map(),  // outputSlotIdx -> ref
  };
  for (const n of scope.nodes) scope.nodeById.set(n.id, n);
  for (const l of scope.links) scope.linkMap.set(l.id, l);

  if (!subgraphIndex) return scope;

  for (const n of scope.nodes) {
    const def = subgraphIndex.get(n.type);
    if (!def) continue;
    const child = buildScope({
      nodes: def.nodes,
      links: def.links,
      sg: def,
      parent: { scope, instNode: n },
      prefix: `${prefix}${n.id}:`,
      subgraphIndex,
      warnings,
      name: `${name} > ${def.name || n.type}`,
    });
    scope.children.set(n.id, child);
  }
  return scope;
}

/** 子图内部某输入槽（-10）取到的值：往父作用域追 */
function resolveParam(scope, sgInputIdx, ctx) {
  const sgIn = scope.sg?.inputs?.[sgInputIdx];
  if (!sgIn) return { t: 'unresolved', why: `子图输入下标 ${sgInputIdx} 不存在` };
  const parent = scope.parent;
  if (!parent) return { t: 'unresolved', why: `根作用域出现 -10 输入` };

  const inst = parent.instNode;
  const pscope = parent.scope;
  const instInputs = inst.inputs || [];
  // 实例节点上的槽位名 == 子图输入名（前端会做重名后缀，如 scheduler_1）
  let slot = instInputs.findIndex((x) => x.name === sgIn.name);
  if (slot < 0) slot = instInputs.findIndex((x) => x.label === sgIn.label && x.name === sgIn.name);
  if (slot < 0) {
    // 该子图输入没有暴露成实例 socket → 值存在实例的 widgets_values_named 里
    const w = nodeWidgets(inst, ctx, ctx.warnings);
    if (sgIn.name in w) return { t: 'lit', v: w[sgIn.name] };
    const alt = Object.keys(w).find((k) => k === sgIn.label);
    if (alt) return { t: 'lit', v: w[alt] };
    return { t: 'unresolved', why: `子图输入 ${sgIn.name} 既没连线也没 widget 值` };
  }
  const inp = instInputs[slot];
  if (inp.link != null) {
    const outerLink = pscope.linkMap.get(inp.link);
    if (!outerLink) return { t: 'unresolved', why: `父作用域缺 link ${inp.link}` };
    return resolveRef(pscope, outerLink.origin, outerLink.originSlot, ctx);
  }
  // 有 socket 但没连 → 用实例 widget 值（widget 提升的情形）
  const wname = inp.widget?.name ?? sgIn.name;
  let v = nodeWidgets(inst, ctx, ctx.warnings)[wname];
  if (v === undefined) v = nodeWidgets(inst, ctx, ctx.warnings)[sgIn.name];
  if (v !== undefined) return { t: 'lit', v };
  return { t: 'unresolved', why: `子图输入 ${sgIn.name} 无链接且无 widget 值` };
}

/** 解析本作用域里 (originId, originSlot) 指向的上游 */
function resolveRef(scope, originId, originSlot, ctx) {
  if (scope.inputNodeId != null && originId === scope.inputNodeId) {
    return resolveParam(scope, originSlot, ctx);
  }
  if (scope.outputNodeId != null && originId === scope.outputNodeId) {
    return { t: 'unresolved', why: 'link 的 origin 是子图输出节点（异常）' };
  }
  const node = scope.nodeById.get(originId);
  if (!node) return { t: 'unresolved', why: `作用域 ${scope.name} 中找不到节点 ${originId}` };

  // Reroute: 透传
  if (node.type === 'Reroute') {
    const inp = (node.inputs || [])[0];
    if (!inp || inp.link == null) return { t: 'unresolved', why: `Reroute ${originId} 没有输入` };
    const l = scope.linkMap.get(inp.link);
    if (!l) return { t: 'unresolved', why: `Reroute ${originId} 缺 link ${inp.link}` };
    return resolveRef(scope, l.origin, l.originSlot, ctx);
  }
  // PrimitiveNode: 常量
  if (node.type === 'PrimitiveNode') {
    const vals = node.widgets_values;
    if (Array.isArray(vals) && vals.length) return { t: 'lit', v: vals[0] };
    return { t: 'lit', v: nodeWidgets(node, ctx, ctx.warnings).value };
  }
  // 子图实例的输出 → 子图内部的真实来源
  const child = scope.children.get(originId);
  if (child) {
    const ref = child.outputs.get(originSlot);
    if (!ref) return { t: 'unresolved', why: `子图实例 ${originId} 输出槽 ${originSlot} 没接内部节点` };
    return ref;
  }
  return { t: 'node', id: `${scope.prefix}${originId}`, slot: originSlot };
}

/** 后序遍历：先算子图的输出映射，再算父的（支持嵌套/兄弟互联） */
function computeOutputs(scope, ctx) {
  for (const child of scope.children.values()) computeOutputs(child, ctx);
  if (scope.outputNodeId == null) return;
  for (const l of scope.links) {
    if (l.target === scope.outputNodeId) {
      scope.outputs.set(l.targetSlot, resolveRef(scope, l.origin, l.originSlot, ctx));
    }
  }
}

/* ------------------------------------------------------------------ *
 * 序列化
 * ------------------------------------------------------------------ */

function serializeScope(scope, ctx, out) {
  for (const child of scope.children.values()) serializeScope(child, ctx, out);

  for (const node of scope.nodes) {
    if (UI_ONLY_TYPES.has(node.type)) continue;
    if (UI_ONLY_OUTPUT_TYPES.has(node.type)) {
      warnTo(ctx.warnings, `节点 ${scope.prefix}${node.id} (${node.type}) 是 UI 专属对比节点，已从 API 图剔除`);
      continue;
    }
    const flatId = `${scope.prefix}${node.id}`;
    if (scope.children.has(node.id)) continue; // 子图实例本身不进图，内部节点已展开
    const mode = node.mode ?? 0;
    if (MODE_NEVER.has(mode)) {
      warnTo(ctx.warnings, `节点 ${flatId} (${node.type}) mode=${mode} 被静音/旁路，已从 API 图移除`);
      continue;
    }
    const classType = node.type;
    const inputs = nodeWidgets(node, ctx, ctx.warnings);

    const slotNames = [];
    for (let i = 0; i < (node.inputs || []).length; i++) {
      const inp = node.inputs[i];
      if (!inp) continue;
      const key = inp.widget?.name ?? inp.name;
      if (inp.link != null) {
        const l = scope.linkMap.get(inp.link);
        if (!l) { warnTo(ctx.warnings, `${flatId}.${key}: link ${inp.link} 不存在`); continue; }
        const ref = resolveRef(scope, l.origin, l.originSlot, ctx);
        if (ref.t === 'node') {
          inputs[key] = [ref.id, ref.slot];
          slotNames.push(`${key}<-${ref.id}[${ref.slot}]`);
        } else if (ref.t === 'lit') {
          inputs[key] = ref.v;
          slotNames.push(`${key}=${short(ref.v)}`);
        } else {
          warnTo(ctx.warnings, `${flatId}.${key}: 上游无法解析（${ref.why}）`);
        }
      } else if (inp.widget && !(key in inputs)) {
        warnTo(ctx.warnings, `${flatId}.${key}: widget 无当前值`);
      }
    }

    const entry = { class_type: classType, inputs, _flatId: flatId, _localId: String(node.id), _scope: scope.name };
    out.push(entry);
  }
}

const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…(${s.length})` : s;
};

/* ------------------------------------------------------------------ *
 * 剪枝：只留输出节点的祖先
 * ------------------------------------------------------------------ */

function pruneGraph(entries, ctx) {
  const byId = new Map(entries.map((e) => [e._flatId, e]));
  const isOutput = (e) => OUTPUT_CLASS_RE.test(e.class_type);
  let roots = entries.filter(isOutput);
  if (!roots.length) {
    // 兜底：没有输出节点，就留所有“没有下游”的节点
    const hasDown = new Set();
    for (const e of entries) for (const v of Object.values(e.inputs)) if (Array.isArray(v) && byId.has(v[0])) hasDown.add(v[0]);
    roots = entries.filter((e) => !hasDown.has(e._flatId));
    warnTo(ctx.warnings, '剪枝：未找到 SaveImage/Preview 类输出节点，回退为保留所有叶子节点');
  }
  const keep = new Set();
  const stack = [];
  for (const e of roots) { keep.add(e._flatId); stack.push(e); }
  while (stack.length) {
    const e = stack.pop();
    for (const v of Object.values(e.inputs)) {
      if (Array.isArray(v) && typeof v[0] === 'string' && byId.has(v[0]) && !keep.has(v[0])) {
        keep.add(v[0]);
        stack.push(byId.get(v[0]));
      }
    }
  }
  // 显式保留
  for (const spec of ctx.keep) {
    for (const e of entries) {
      if (e._flatId === spec || e._localId === spec || e.class_type === spec) {
        if (!keep.has(e._flatId)) {
          // 连同祖先一起留
          const st = [e];
          keep.add(e._flatId);
          while (st.length) {
            const x = st.pop();
            for (const v of Object.values(x.inputs)) {
              if (Array.isArray(v) && typeof v[0] === 'string' && byId.has(v[0]) && !keep.has(v[0])) {
                keep.add(v[0]); st.push(byId.get(v[0]));
              }
            }
          }
        }
      }
    }
  }
  const removed = entries.filter((e) => !keep.has(e._flatId));
  if (removed.length) {
    warnTo(ctx.warnings, `剪枝掉 ${removed.length} 个不可达节点: ${removed.map((e) => `${e._flatId}(${e.class_type})`).join(', ')}`);
  }
  return entries.filter((e) => keep.has(e._flatId));
}

/* ------------------------------------------------------------------ *
 * 覆盖
 * ------------------------------------------------------------------ */

export function parseValue(raw) {
  let v = raw;
  if (v.startsWith('@')) {
    const text = readFileSync(v.slice(1), 'utf8');
    return text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  }
  if (v === '$RANDOM') return randomInt(1, 2 ** 48 - 1);
  if (v === '$UUID') return cryptoRandomHex(8);
  if (v === '$SEED' || v === 'random') return randomInt(1, 2 ** 48 - 1);
  try { return JSON.parse(v); } catch { return v; }
}

function cryptoRandomHex(n) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseOverrideString(s) {
  const eq = s.indexOf('=');
  if (eq <= 0) throw new Error(`--set 参数格式应为 K=V，收到: ${s}`);
  return { key: s.slice(0, eq).trim(), valueSrc: s.slice(eq + 1) };
}

/**
 * 把 overrides 应用到 entries。overrides 支持两种形态：
 *   { "KSampler.seed": 42 }            ← 值为最终值
 *   { "KSampler.seed": "@$RANDOM" }    ← 以 @ 开头表示“按 parseValue 解析源码串”，方便命令行传
 * 匹配：扁平 id > 局部 id > class_type > class_type 通配（*）
 */
function applyOverrides(entries, overrides, ctx) {
  const list = entries.map((e) => e._flatId);
  for (const [key0, rawVal] of Object.entries(overrides)) {
    // 支持 "seed=42" / "*seed=42" 这种不写节点的全局写法
    let key = key0;
    if (key.startsWith('*') && !key.includes('.') && key.length > 1) key = `*.${key.slice(1)}`;
    else if (!key.includes('.')) key = `*.${key}`;
    const dot = key.lastIndexOf('.');
    if (dot < 0) throw new Error(`覆盖键应为 <节点>.<输入> 或 <输入>(全局)，收到: ${key0}`);
    const target = key.slice(0, dot) || '*';
    const inputName = key.slice(dot + 1);
    const value = rawVal;

    let matched;
    let matchedBy = '';
    const exact = entries.filter((e) => e._flatId === target);
    if (exact.length) { matched = exact; matchedBy = 'id'; }
    else if (target === '*') { matched = entries; matchedBy = 'global'; }
    else {
      const local = entries.filter((e) => e._localId === target);
      if (local.length) { matched = local; matchedBy = 'local-id'; }
      else {
        const byClass = entries.filter((e) => e.class_type === target);
        if (byClass.length) { matched = byClass; matchedBy = 'class'; }
        else {
          // 允许 target 是扁平 id 的某一段，如 "452" 命中 "459:452"
          const fuzzy = entries.filter((e) => e._flatId.split(':').includes(target));
          if (fuzzy.length) { matched = fuzzy; matchedBy = 'id-segment'; }
          else throw new Error(`覆盖失败：找不到节点 "${target}"。现有节点: ${list.join(', ')}`);
        }
      }
    }

    // 全局 / class 通配时，只改真正拥有该输入的节点，避免给无关节点塞垃圾字段
    if (matchedBy === 'global' || matchedBy === 'class') {
      const before = matched.length;
      matched = matched.filter((e) => {
        if (inputName in e.inputs) return true;
        const oi = ctx.objectInfo?.[e.class_type];
        if (!oi) return false;
        return inputName in (oi.input?.required || {}) || inputName in (oi.input?.optional || {});
      });
      if (!matched.length) {
        warnTo(ctx.warnings, `覆盖 ${key0}: 没有任何 ${target} 节点拥有输入 ${inputName}（已跳过）`);
        continue;
      }
      if (before !== matched.length && ctx.objectInfo) {
        warnTo(ctx.warnings, `覆盖 ${key0}: 命中 ${matched.length} 个拥有该输入的节点`);
      }
    } else if (matched.length > 1 && !ctx.allowMulti) {
      throw new Error(`覆盖 ${key0} 命中多个节点 (${matched.map((m) => m._flatId).join(', ')})，请用扁平 id 精确指定，或加 --allow-multi`);
    }

    for (const e of matched) {
      e.inputs[inputName] = value;
      e._overridden = e._overridden || [];
      e._overridden.push(inputName);
    }
  }
}

/* ------------------------------------------------------------------ *
 * object_info 校验
 * ------------------------------------------------------------------ */

function validateAgainstObjectInfo(entries, objectInfo, ctx) {
  const problems = [];
  for (const e of entries) {
    const oi = objectInfo[e.class_type];
    if (!oi) { problems.push(`${e._flatId}: 服务器没有这个节点类型 ${e.class_type}`); continue; }
    const declared = new Set([
      ...Object.keys(oi.input?.required || {}),
      ...Object.keys(oi.input?.optional || {}),
      ...Object.keys(oi.input?.hidden || {}),
    ]);
    // 允许 V3 动态 widget 的 dotted 子键：父键存在即放行
    const unknown = Object.keys(e.inputs).filter((k) => !declared.has(k) && !declared.has(k.split('.')[0]));
    for (const k of unknown) problems.push(`${e._flatId}(${e.class_type}).${k}: 服务器端未声明该输入`);
    // 枚举校验
    for (const [k, v] of Object.entries(e.inputs)) {
      if (Array.isArray(v)) continue; // 连线
      const spec = oi.input?.required?.[k] ?? oi.input?.optional?.[k];
      if (!spec) continue;
      const t = spec[0];
      if (Array.isArray(t) && typeof v === 'string' && !t.includes(v)) {
        const missed = `${e._flatId}(${e.class_type}).${k}="${v}" 不在可选值内`;
        // 文件名类枚举可能有上千项，别整坨打印
        const show = t.length > 8 ? `${t.slice(0, 8).join(' | ')} … 共 ${t.length} 项` : t.join(' | ');
        problems.push(`${missed}: ${show}`);
      }
      const opts = spec[1] || {};
      if (t === 'COMBO' && Array.isArray(opts.options) && typeof v === 'string' && !opts.options.includes(v)) {
        const o = opts.options;
        const show = o.length > 8 ? `${o.slice(0, 8).join(' | ')} … 共 ${o.length} 项` : o.join(' | ');
        problems.push(`${e._flatId}(${e.class_type}).${k}="${v}" 不在可选值内: ${show}`);
      }
    }
    // 必填缺失（COMFY_AUTOGROW_V3 这类动态组 min=0，可整组省略；有 dotted 子键也算给了）
    for (const k of Object.keys(oi.input?.required || {})) {
      if (k in e.inputs) continue;
      if (Object.keys(e.inputs).some((x) => x.split('.')[0] === k)) continue;
      const spec = oi.input.required[k] || {};
      const opts = spec[1] || {};
      if (spec[0] === 'COMFY_AUTOGROW_V3' || spec[0] === 'COMFY_MULTITYPE_LIST') continue;
      if (opts.min === 0 || opts.socketless) continue;
      problems.push(`${e._flatId}(${e.class_type}).${k}: 必填输入缺失`);
    }
  }
  if (problems.length) {
    ctx.warnings.push(...problems.map((p) => `校验: ${p}`));
    return problems;
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * 主转换
 * ------------------------------------------------------------------ */

/**
 * @param {object} uiWorkflow  UI 格式 workflow（或已 API 格式）
 * @param {object} opts
 *   overrides      { "节点.class输入": 值 }
 *   prune          boolean 默认 true
 *   keep           string[] 强制保留
 *   objectInfo     /object_info 结果（可选）
 *   validate       boolean 用 objectInfo 校验
 *   allowMulti     boolean
 *   quiet          boolean
 * @returns {{ api: object, nodes: array, warnings: string[], entries: array }}
 */
export function convert(uiWorkflow, opts = {}) {
  const warnings = [];
  const ctx = {
    warnings,
    objectInfo: opts.objectInfo || null,
    keep: opts.keep || [],
    allowMulti: !!opts.allowMulti,
  };

  if (uiWorkflow && uiWorkflow.alreadyApi) {
    // 已经是 API 格式：直接做覆盖
    const entries = Object.entries(uiWorkflow.api).map(([id, n]) => ({
      class_type: n.class_type,
      inputs: { ...n.inputs },
      _flatId: String(id),
      _localId: String(id),
      _scope: '<api>',
    }));
    applyOverrides(entries, opts.overrides || {}, ctx);
    const api = toApi(entries);
    return { api, entries, nodes: entries, warnings };
  }

  const wf = uiWorkflow?.workflow ?? uiWorkflow;
  const subgraphIndex = new Map();
  for (const sg of wf.definitions?.subgraphs || []) subgraphIndex.set(sg.id, sg);

  const root = buildScope({
    nodes: wf.nodes,
    links: wf.links,
    sg: null,
    parent: null,
    prefix: '',
    subgraphIndex,
    warnings,
    name: 'root',
  });

  computeOutputs(root, ctx);
  // 再跑一遍：处理“子图输出接到兄弟子图输入”这类需要先算完其它子图的情况
  computeOutputs(root, ctx);

  const entries = [];
  serializeScope(root, ctx, entries);

  // 先覆盖、后剪枝：把某个输入改成字面量会切断上游，上游随之被剪掉（例如跳过提示词增强 LLM）
  applyOverrides(entries, opts.overrides || {}, ctx);

  let finalEntries = entries;
  if (opts.prune !== false) {
    const overriddenIds = new Set(entries.filter((e) => e._overridden).map((e) => e._flatId));
    finalEntries = pruneGraph(entries, ctx);
    for (const id of overriddenIds) {
      if (!finalEntries.some((e) => e._flatId === id)) {
        warnTo(ctx.warnings, `节点 ${id} 的覆盖被剪枝丢弃（该节点不可达；用 --no-prune 或 --keep ${id} 保留）`);
      }
    }
  }

  if (opts.validate && opts.objectInfo) validateAgainstObjectInfo(finalEntries, opts.objectInfo, ctx);

  const api = toApi(finalEntries);
  return { api, entries: finalEntries, nodes: finalEntries, warnings };
}

function toApi(entries) {
  const api = {};
  for (const e of entries) api[e._flatId] = { class_type: e.class_type, inputs: e.inputs };
  return api;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { files: [], sets: [], keep: [], overridesFile: null, prune: true, quiet: false, list: false, print: false, out: null, seed: null, objectInfoUrl: null, validate: false, allowMulti: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--out': args.out = argv[++i]; break;
      case '--set': args.sets.push(argv[++i]); break;
      case '--set-from':
      case '--overrides-file': args.overridesFile = argv[++i]; break;
      case '--keep': args.keep.push(argv[++i]); break;
      case '--seed': args.seed = argv[++i]; break;
      case '--prune': args.prune = true; break;
      case '--no-prune': args.prune = false; break;
      case '--list': args.list = true; break;
      case '--print': args.print = true; break;
      case '--quiet': args.quiet = true; break;
      case '--allow-multi': args.allowMulti = true; break;
      case '--object-info': args.objectInfoUrl = argv[++i]; break;
      case '--validate': args.validate = true; break;
      case '-h':
      case '--help': args.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`未知参数 ${a}`);
        args.files.push(a);
    }
  }
  return args;
}

async function fetchObjectInfo(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`/object_info HTTP ${res.status}`);
  return res.json();
}

function printList(entries, objectInfo) {
  log(`共 ${entries.length} 个节点（已展开子图 / 已剪枝）\n`);
  for (const e of entries) {
    log(`● ${e._flatId}  ${e.class_type}${e._overridden ? `   [覆盖: ${e._overridden.join(',')}]` : ''}`);
    const oi = objectInfo?.[e.class_type];
    const declared = oi ? [...Object.keys(oi.input?.required || {}), ...Object.keys(oi.input?.optional || {})] : [];
    const keys = new Set([...Object.keys(e.inputs), ...declared]);
    if (!keys.size) { log('    (无输入)'); continue; }
    const rows = [];
    for (const k of [...keys].sort()) {
      const v = e.inputs[k];
      const isLink = Array.isArray(v);
      const spec = oi?.input?.required?.[k] ?? oi?.input?.optional?.[k];
      const t = Array.isArray(spec?.[0]) ? 'COMBO' : spec?.[0];
      let cur;
      if (isLink) cur = `<link ${v[0]}[${v[1]}]>`;
      else if (v === undefined) cur = oi && !(k in (oi.input?.required || {})) ? '(可选,未设置)' : '(未设置)';
      else cur = short(v);
      const enumHint = Array.isArray(spec?.[0]) ? ` 枚举(${spec[0].length}): ${spec[0].filter(x => typeof x === 'string').slice(0, 6).join(' | ')}${spec[0].length > 6 ? ' …' : ''}` : '';
      rows.push(`    - ${k}${t ? ` [${t}]` : ''} = ${cur}${enumHint}`);
    }
    log(rows.join('\n'));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.files.length && !args.overridesFile)) {
    log(`用法: node ui2api.mjs <workflow.json> [选项]

  --list                    列出展开后的节点 / class_type / 可覆盖字段与当前值
  --print                   打印 API JSON 到 stdout
  --out <file>              写 API JSON 到文件
  --set K=V                 覆盖（nodeId|class_type|局部id . input = value），可重复
  --set-from <file.json>    从 JSON 文件批量覆盖
  --seed <random|数字>      给所有含 seed 的输入设值
  --prune / --no-prune      只保留输出节点祖先链（默认开）
  --keep <nodeId|class>     强制保留某节点（含其祖先），可重复
  --object-info <url>       取服务器 /object_info（字段名推断 + 校验）
  --validate                校验输入名与枚举值
  --allow-multi             同名 class_type 命中多个节点时不报错
  --quiet
`);
    return;
  }

  const file = args.files[0];
  if (!file) throw new Error('缺 workflow 文件');
  const loaded = loadWorkflow(file);

  let objectInfo = null;
  if (args.objectInfoUrl) {
    try { objectInfo = await fetchObjectInfo(args.objectInfoUrl); }
    catch (e) { console.error(`[warn] 取 object_info 失败: ${e.message}`); }
  }

  const overrides = {};
  if (args.overridesFile) {
    const obj = JSON.parse(readFileSync(args.overridesFile, 'utf8'));
    for (const [k, v] of Object.entries(obj)) overrides[k] = typeof v === 'string' ? parseValue(v) : v;
  }
  for (const s of args.sets) {
    const { key, valueSrc } = parseOverrideString(s);
    // 命令行 --set 统一走 parseValue：@file / $RANDOM / JSON 字面量 / 字符串
    overrides[key] = parseValue(valueSrc);
  }
  if (args.seed != null) overrides['*seed'] = args.seed === 'random' ? randomInt(1, 2 ** 48 - 1) : Number(args.seed);

  const result = convert(loaded, {
    overrides,
    prune: args.prune,
    keep: args.keep,
    objectInfo,
    validate: args.validate,
    allowMulti: args.allowMulti,
  });

  if (!args.quiet) {
    for (const w of result.warnings) console.error(`[warn] ${w}`);
  }

  if (args.list) { printList(result.entries, objectInfo); return; }

  const json = JSON.stringify(result.api, null, 2);
  if (args.out) { writeFileSync(args.out, json); if (!args.quiet) console.error(`[ok] 写出 ${args.out}（${result.entries.length} 节点）`); }
  if (args.print || !args.out) log(json);
}

// 只有直接执行才跑 CLI（被 import 时不动）
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => { console.error(`[error] ${e.message}`); process.exit(1); });
}
