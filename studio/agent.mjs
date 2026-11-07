import { fileURLToPath } from 'node:url';
/**
 * agent.mjs —— 系统内置的轻量 Agent 运行时（OpenAI 兼容 + 流式 + 工具调用）
 *
 * 作用：让 Studio 不依赖外部会话，自己驱动 skill 写大纲/角色/剧本/分镜，
 *      并把「assistant 文本增量 / 工具调用 / 工具结果」实时抛给上层（SSE 给界面）。
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
const readProtectedText = (file) => readFile(file, 'utf8');

const BASE = process.env.LLM_BASE_URL || '';
const MODEL = process.env.LLM_MODEL || '';
const keyRef = () => process.env.LLM_API_KEY || '';
const MAX_TOOL_CHARS = 24000;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取一个文本文件。返回完整内容（过长的会被截断）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径。优先用相对工作目录的路径（如 docs/01-情节梳理.md）；只有读技能文档时才允许绝对路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入（覆盖）一个文本文件，自动创建上级目录。用于产出 JSON/Markdown。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列目录（最多两层），用于确认产物是否已生成。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, pattern: { type: 'string', description: '可选正则，过滤文件名' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: '在工作目录执行 shell 命令（node/python/校验脚本等）。返回 stdout+stderr。用于跑 skill 的 validate/render。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } },
        required: ['command'],
      },
    },
  },
];

function truncate(s, n = MAX_TOOL_CHARS) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + `\n…[截断，共 ${t.length} 字符]` : t;
}

function runBash(command, cwd, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = win
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ' + command], { cwd, windowsHide: true })
      : spawn('/bin/bash', ['-lc', 'exec 0</dev/null; ' + command], { cwd, detached: true });
    let out = '', err = '', done = false;
    const killTree = () => {
      if (win && child.pid) { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); return; }
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => { if (!done) { done = true; killTree(); resolve({ code: -1, out, err: err + '\n[超时终止：整个命令进程组已被杀掉]' }); } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: e.message }); } });
    child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); killTree(); resolve({ code, out, err }); });
  });
}

async function execTool(name, args, workdir) {
  try {
    if (name === 'read_file') {
      const p = path.isAbsolute(args.path) ? args.path : path.join(workdir, args.path);
      const t = await readProtectedText(p);
      if (t.length <= 4096) return `【read_file ${p} · ${t.length} 字符 · 完整内容如下】\n${t}`;
      return `【read_file ${p} · ${t.length} 字符 · 超长已截断（前 24000）】\n${truncate(t)}`;
    }
    if (name === 'write_file') {
      const p = path.isAbsolute(args.path) ? args.path : path.join(workdir, args.path);
      const inside = path.resolve(p).startsWith(path.resolve(workdir) + path.sep) || path.resolve(p) === path.resolve(workdir);
      if (!inside) return `被拒绝：只能往工作目录（${workdir}）里写产物。请把 path 改成相对路径，例如 outline/xxx.json、docs/01-情节梳理.md。技能目录是只读的。`;
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, args.content ?? '', 'utf8');
      const back = await readFile(p, 'utf8');
      const want = String(args.content ?? '').length;
      if (back.length !== want) return `【write_file 异常】期望 ${want} 字符，实际落盘 ${back.length} 字符——你的 arguments 在传输中被截断了。不要重试同样的写法：改用 bash heredoc 分段落盘（cat >> 文件 <<'EOF' … EOF），每段 ≤3000 字符。`;
      return `【write_file 成功】已写入 ${p}（${Buffer.byteLength(back)} 字节）校验一致`;
    }
    if (name === 'list_files') {
      const base = path.isAbsolute(args.path) ? args.path : path.join(workdir, args.path);
      if (!existsSync(base)) return `目录不存在：${base}`;
      const rows = [];
      const re = args.pattern ? new RegExp(args.pattern) : null;
      async function walk(d, depth) {
        if (depth > 2 || rows.length > 300) return;
        for (const e of await readdir(d, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) await walk(full, depth + 1);
          else if (!re || re.test(e.name)) {
            const st = await stat(full);
            rows.push(`${path.relative(workdir, full)}  ${st.size}B`);
          }
        }
      }
      await walk(base, 0);
      return rows.length ? rows.join('\n') : '（空目录）';
    }
    if (name === 'bash') {
      const cmdStr = String(args.command || '');
      const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills') + path.sep;
      // 拦截：在技能目录里创建文件 / 重定向到工作目录之外
      if (new RegExp(skillDir + '[^\\s;&|)]*\\s*(>>?|tee)').test(cmdStr.replace(/validate|render|checkup|export|seed|blocking|chunk|merge|assemble|assets|slug|selftest/g, ''))) {
        return `被拒绝：技能目录只读，禁止在其中创建或修改文件。校验命令请直接按任务给定形式执行（node <绝对脚本路径> validate <本项目相对产物>），中间稿请写到本工作目录内。`;
      }
      const wantMs = Number(args.timeoutMs) || 300000;
      const useMs = Math.max(300000, Math.min(wantMs, 900000));
      const r = await runBash(args.command, workdir, useMs);
      const so = (r.out || '').trim(), se = (r.err || '').trim();
      let head = `【bash 完成 exit=${r.code}】`;
      if (r.code === -1) head = `【bash 被终止（超过 ${Math.round(useMs / 60000)} 分钟）】` + (wantMs < 300000 ? `注意：你传的 timeoutMs=${wantMs} 太小，系统已按最低 5 分钟执行。若这条命令确实需要更久，请传 timeoutMs=600000；若是卡住，不要原样重试，改成拆开跑或加 </dev/null。` : '不要原样重试整条命令——先判断它是否其实已完成大部分工作（看产物文件），再决定补哪一步。');
      else if (!so && !se) head += r.code === 0 ? '（无输出且 exit=0：正常，很多命令本来就没输出，不必重复试探）' : `（无输出且 exit=${r.code}：命令失败了，看 stderr 或换写法）`;
      return `${head}\nstdout:\n${truncate(so, 16000)}\nstderr:\n${truncate(se, 8000)}`;
    }
    return `未知工具：${name}`;
  } catch (e) {
    return `工具执行失败：${e.message}`;
  }
}

/** 把内部消息（OpenAI 风格）转成 Anthropic Messages 格式 */
function toAnthropic(messages, systemPrompt, tools) {
  const sys = [systemPrompt].filter(Boolean).join('\n\n');
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }] });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '（继续）' }] });
      continue;
    }
    out.push({ role: 'user', content: [{ type: 'text', text: String(m.content ?? '') }] });
  }
  const at = (tools || []).map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  return { system: sys, messages: out, tools: at };
}

/** 流式调用模型：支持 openai / anthropic 两种协议 */
export async function streamChat(messages, { tools = TOOLS, temperature = 0.6, maxTokens = 8000, onEvent, signal, sessionId, provider } = {}) {
  const p = provider || { baseUrl: BASE, model: MODEL, apiKey: keyRef(), protocol: 'openai' };
  if (!p.baseUrl || !p.model) throw new Error('请先在设置中填写语言模型接口地址和模型名称');
  const apiKey = p.apiKey || keyRef();
  if (!apiKey) throw new Error(`接口 ${p.label || p.id || ''} 没有可用密钥`);
  const timeoutSignal = AbortSignal.timeout(Number(p.timeoutMs) || 360000);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const isAnthropic = String(p.protocol || 'openai') === 'anthropic';
  const maxTok = Math.max(256, Number(maxTokens) || Number(p.maxTokens) || 8000);
  let url, headers, body;
  if (isAnthropic) {
    const a = toAnthropic(messages, messages.find((m) => m.role === 'system')?.content || '', tools);
    url = `${String(p.baseUrl).replace(/\/$/, '')}/v1/messages`;
    headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    body = { model: p.model, max_tokens: maxTok, stream: true, temperature, system: a.system, messages: a.messages };
    if (a.tools.length) body.tools = a.tools;
  } else {
    url = `${String(p.baseUrl).replace(/\/$/, '')}/chat/completions`;
    headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
    body = { model: p.model, messages, stream: true, temperature, max_tokens: maxTok, tools };
    if (p.reasoningEffort) body.reasoning_effort = p.reasoningEffort;
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: combined });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`模型请求失败 ${res.status}（${p.label || p.id || ''}）: ${t.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  let lastByte = Date.now();
  let idleKilled = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastByte > 120000) { idleKilled = true; try { reader.cancel('idle-timeout'); } catch {} }
  }, 5000);

  try {
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    const calls = [];
    let finish = null;
    const takeLine = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') { if (payload === '[DONE]') finish = finish || 'stop'; return; }
      let j;
      try { j = JSON.parse(payload); } catch { return; }

      if (isAnthropic) {
        // 事件：content_block_start / content_block_delta / message_delta / message_stop
        if (j.type === 'content_block_start') {
          const cb = j.content_block || {};
          if (cb.type === 'tool_use') {
            calls[j.index] = { id: cb.id, name: cb.name, args: '' };
          } else if (cb.type === 'text' && cb.text) {
            content += cb.text;
            onEvent?.({ type: 'ai_delta', text: cb.text });
          }
        } else if (j.type === 'content_block_delta') {
          const d = j.delta || {};
          if (d.type === 'text_delta' && d.text) {
            content += d.text;
            onEvent?.({ type: 'ai_delta', text: d.text });
          } else if (d.type === 'input_json_delta') {
            const c = calls[j.index] || (calls[j.index] = { id: '', name: '', args: '' });
            c.args += d.partial_json || '';
          }
        } else if (j.type === 'message_delta') {
          if (j.delta?.stop_reason) finish = j.delta.stop_reason;
        } else if (j.type === 'message_stop') {
          finish = finish || 'stop';
        } else if (j.type === 'error') {
          throw new Error('接口返回错误：' + JSON.stringify(j.error || j).slice(0, 300));
        }
        return;
      }

      const ch = j.choices?.[0];
      if (!ch) return;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (d.content) {
        content += d.content;
        onEvent?.({ type: 'ai_delta', text: d.content });
      }
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          calls[i] = calls[i] || { id: '', name: '', args: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].args += tc.function.arguments;
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastByte = Date.now();
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        takeLine(line);
      }
    }
    if (buf.trim()) takeLine(buf);

    return { content, calls: calls.filter(Boolean), finish };
  } finally {
    clearInterval(watchdog);
    if (idleKilled) throw new Error('模型流空闲超时（120s 无数据），已断开重试');
  }
}


/**
 * 跑一个 Agent 任务：多轮「模型 → 工具 → 模型」，直到模型不再调工具。
 * onEvent 收到：ai_delta / ai_message / tool_call / tool_result / turn
 */
export async function runAgent({
  systemPrompt,
  task,
  workdir,
  maxTurns = 40,
  maxTokens = 8000,
  onEvent = () => {},
  signal,
  label = 'agent',
  history = [],
  provider = null,
}) {
  const messages = [
    { role: 'system', content: systemPrompt + (process.platform === 'win32' ? '\n当前运行于 Windows。bash 工具实际执行 PowerShell 命令；路径必须加双引号，不要使用 Bash heredoc、cat >> 或 /dev/null。追加内容可用 Add-Content -Encoding UTF8；校验仍使用 node。' : '') },
    ...history,
    { role: 'user', content: task },
  ];
  const started = Date.now();
  const sessionId = `manju-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) throw new Error('已取消');
    onEvent({ type: 'turn', turn, label });
    // 临近上限：提示模型收尾，避免一头撞死
    if (turn === Math.max(2, maxTurns - 2)) {
      messages.push({ role: 'system', content: '轮数即将用尽：停止继续探索文件，用已掌握的信息直接给出结论或完成当前修改。' });
    }
    let content = '', calls = [], finish = null;
    for (let attempt = 1; ; attempt++) {
      try {
        ({ content, calls, finish } = await streamChat(messages, { onEvent, signal, maxTokens, sessionId, provider }));
        onEvent({ type: 'log', line: `· [模型返回] finish=${finish || '?'} 正文=${content.length}字 工具=${calls.map((c) => `${c.name}:${String(c.args || '').length}B`).join(',')}` });
        break;
      } catch (err) {
        const msg = String(err?.message || err);
        if (signal?.aborted) throw new Error('已取消');
        if (attempt >= 3) throw new Error(`模型流中断（重试 3 次仍失败）：${msg}`);
        onEvent({ type: 'log', line: `模型流中断，${attempt}/3 重试：${msg.slice(0, 120)}` });
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (content?.trim()) onEvent({ type: 'ai_message', text: content });
    if (!calls.length) {
      onEvent({ type: 'agent_done', turns: turn, ms: Date.now() - started });
      return { content, turns: turn, ms: Date.now() - started };
    }
    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
    });
    for (const c of calls) {
      let args = null;
      try { args = JSON.parse(c.args || '{}'); } catch { args = null; }
      if (!args || typeof args !== 'object') {
        const bad = { type: 'tool_call', id: c.id, name: c.name, args: {}, bad: true };
        onEvent(bad);
        const msg = `参数不是合法 JSON（收到 ${String(c.args || '').length} 字符）。请重新调用工具，arguments 必须是合法 JSON；内容很长时请分段多次写入（先写主体，再用 bash 追加）。`;
        onEvent({ type: 'tool_result', id: c.id, name: c.name, result: msg });
        messages.push({ role: 'tool', tool_call_id: c.id, content: msg });
        continue;
      }
      onEvent({ type: 'tool_call', id: c.id, name: c.name, args });
      const result = await execTool(c.name, args, workdir);
      onEvent({ type: 'tool_result', id: c.id, name: c.name, result: truncate(result, 4000), brief: String(result).slice(0, 160) });
      messages.push({ role: 'tool', tool_call_id: c.id, content: result });
    }
  }
  // 到达轮数上限：强制一次「只出文本」的收尾调用，避免整个任务丢掉
  try {
    onEvent({ type: 'log', line: `工具轮数已达上限 ${maxTurns}，强制收尾` });
    const wrap = await streamChat([
      ...messages,
      { role: 'user', content: '工具调用轮数已用尽。请不要再调用工具，直接用中文总结：你已完成哪些修改（文件级别）、当前状态、还剩什么没做。' },
    ], { tools: [], onEvent, signal, maxTokens });
    return { content: wrap.content, turns: maxTurns, ms: Date.now() - started, truncated: true };
  } catch {
    return { content: `（本轮工具调用达到上限 ${maxTurns}，任务未完全收尾。可以继续追问让我接着做。）`, turns: maxTurns, ms: Date.now() - started, truncated: true };
  }
}

export { MODEL, BASE };
