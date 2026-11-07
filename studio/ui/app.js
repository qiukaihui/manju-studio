/* 漫剧工坊 Studio —— 前端逻辑（零依赖） */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (n == null ? '—' : Number(n).toFixed(d));
const mb = (n) => (n == null ? '—' : (n / 1048576).toFixed(1) + ' MB');
const clock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

const state = { projects: [], project: null, data: null, view: 'projects', assetTab: 'scenes', scriptTab: 'outline', busy: false };

/* ------------------------------- 初始化 ------------------------------- */
async function boot() {
  await loadPresets();
  await loadProjects();
  bindNav();
  bindActions();
  bindSettings();
  bindWizard();
  initChat();
  renderProjects();
  const params = new URLSearchParams(location.search);
  const p = params.get('p');
  const h = location.hash.replace('#', '');
  const views = ['projects','workspace','script','assets','produce','settings'];
  if (p && state.projects.some((x) => x.name === p)) {
    await selectProject(p);
    if (views.includes(h) && h !== 'workspace') setView(h, false);
  } else if (views.includes(h)) setView(h, false);
  else setView('projects', false);
  if (!location.search.includes('nosse')) connectEvents();
  pollComfy();
  setInterval(pollComfy, 20000);
  setInterval(async () => {
    if (!state.produce.running) return;
    try {
      const st = await (await fetch('/api/produce/state', { cache: 'no-store' })).json();
      if (!st.running) {
        syncProduceUI(false);
        $('#ai-state').textContent = '已中断';
        $('#pf-start').disabled = false;
        $('#pf-stop').disabled = true;
        const log = $('#pf-log');
        if (log) log.textContent += '\n⚠ 服务端任务已结束/中断（可能是重启或报错）；有未完成记录时可点「继续上次生产」接着跑';
        // 刷新一次项目状态，让「继续上次生产」按钮按真实记录出现/更新
        refresh().catch(() => {});
      }
    } catch {}
  }, 15000);
  setInterval(pollActive, 15000);
  setInterval(syncProduceLogFromServer, 4000);
  syncProduceLogFromServer().catch(() => {});
  watchUiVersion().catch(() => {});
}


async function watchUiVersion() {
  const cur = async () => { try { return (await (await fetch('/api/version', { cache: 'no-store' })).json()).ui; } catch { return null; } };
  const base = await cur();
  if (!base) return;
  setInterval(async () => {
    const now = await cur();
    if (now && now !== base && !document.getElementById('ui-stale-bar')) {
      const bar = document.createElement('div');
      bar.id = 'ui-stale-bar';
      bar.className = 'ui-stale-bar';
      bar.innerHTML = '界面代码已更新，当前标签页还是旧版本（可能看不到最新日志/续跑） <button class="btn btn-accent" id="ui-stale-reload">立即刷新</button>';
      document.body.appendChild(bar);
      bar.querySelector('#ui-stale-reload').onclick = () => location.reload();
    }
  }, 20000);
}

async function loadProjects() {
  try { state.projects = await (await fetch('/api/projects')).json(); }
  catch { state.projects = []; }
  const sel = $('#project-select');
  if (sel) {
    sel.innerHTML = '<option value="">— 选择项目 —</option>' + state.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.title || p.name)}</option>`).join('');
    sel.value = state.project || '';
  }
  renderProjects();
}

async function selectProject(name) {
  const changed = state.project && state.project !== name;
  state.project = name;
  if (changed) {
    // 换项目 = 换工作现场：清空生产时间轴/日志/进程气泡，再按需恢复该项目自己的进行态
    state.produce.bubble = null;
    const tl = $('#pf-timeline'); if (tl) tl.innerHTML = '<div class="tl-empty">还没有开始<br /><small>左侧选好项目/范围，点「开始生成」</small></div>';
    const ac = $('#ai-chat'); if (ac) ac.innerHTML = '';
    const lg = $('#pf-log'); if (lg) lg.textContent = '等待任务…';
    const ai = $('#ai-state'); if (ai) ai.textContent = '空闲';
    try {
      const st = await (await fetch('/api/produce/state')).json();
      if (st.running && st.project === name) { state.produce.running = true; syncProduceUI(true, st.stage || '运行中'); }
      else state.produce.running = false;
    } catch {}
  }
  const sel = $('#project-select'); if (sel) sel.value = name;
  await refresh();
  await renderProjectDetail();
  setView('workspace');
  try {
    const u = new URL(location.href);
    u.searchParams.set('p', name);
    history.replaceState(null, '', u.toString());
  } catch {}
  loadChatHistory();
  const m = state.data?.meta || {};
  if (m.title) {
    $('#pf-name').value = m.title;
    if (m.episodes) $('#pf-episodes').value = m.episodes;
    if (m.secondsPerEpisode) $('#pf-seconds').value = m.secondsPerEpisode;
    if (m.genre) $('#pf-genre').value = m.genre;
    if (m.style) $('#pf-style').value = m.style;
  }
}

async function loadPresets() {
  if (state.presets) return;
  try { state.presets = await (await fetch('/api/presets?v=' + Date.now(), { cache: 'no-store' })).json(); } catch { state.presets = { genres: [], styles: [] }; }
}

async function refresh() {
  if (!state.project) return;
  const r = await fetch('/api/project?p=' + encodeURIComponent(state.project));
  if (!r.ok) return toast('项目读取失败');
  state.data = await r.json();
  renderHeader();
  renderOverview();
  renderScript();
  renderAssets();
  renderTaskList();
  if (typeof updateCorruptBanner === 'function') updateCorruptBanner();
  if (state.view === 'workspace') renderProjectDetail();
}

/* ------------------------------- 头部 / 概览 ------------------------------- */
function renderHeader() {
  const inProject = !!state.project && state.view !== 'projects';
  const sw = $('#project-switch-block'); if (sw) sw.hidden = !inProject;
  const sec = $('#nav-sec-project'); if (sec) sec.hidden = !inProject;
  $$('.nav-item[data-view=workspace],.nav-item[data-view=script],.nav-item[data-view=assets],.nav-item[data-view=produce]')
    .forEach((b) => (b.style.display = inProject ? '' : 'none'));
  if (!state.data || !inProject) {
    $('#proj-title').textContent = '项目库';
    $('#proj-sub').innerHTML = `<b>${state.projects.length}</b> 个项目 · 每部剧独立工作区`;
    $('#btn-validate').disabled = true;
    $('#btn-report').disabled = true;
    $('#btn-validate').style.display = 'none';
    $('#btn-report').style.display = 'none';
    return;
  }
  $('#btn-validate').disabled = false;
  $('#btn-report').disabled = false;
  $('#btn-validate').style.display = '';
  $('#btn-report').style.display = '';
  const d = state.data, s = d.stats;
  $('#proj-title').textContent = (d.meta && d.meta.title) || d.name;
  const bits = [];
  if (s.episodes) bits.push(`${s.episodes} 集 × ${s.minutes} 分钟`);
  if (s.genre) bits.push(s.genre);
  if (s.cuts) bits.push(`${s.segments} 段 / ${s.cuts} 切`);
  if (s.seconds) bits.push(`成片目标 ${fmt(s.seconds, 1)} 秒`);
  const m = d.meta || {};
  const g = presetLabel('genres', m.genre), st = presetLabel('styles', m.style);
  if (g && !bits.some((b) => b.includes(g) || g.includes(b))) bits.push(g);
  if (st && !bits.some((b) => b.includes(st))) bits.push(st);
  if (m.aspect || m.resolution) bits.push(`${m.aspect || '9:16'} · ${m.resolution || '720p'}`);
  $('#proj-sub').innerHTML = bits.map((b) => `<b>${esc(b)}</b>`).join('　·　') || '—';
}

function renderOverview() {
  const d = state.data, s = d.stats;
  // KPI
  const kpis = [
    ['集数', s.episodes ?? '—', s.minutes ? `× ${s.minutes} 分钟` : ''],
    ['角色', s.characters ?? '—', `${s.scenes ?? '—'} 场景`],
    ['剧本', s.scriptScenes ?? '—', `${s.scriptLines ?? '—'} 句台词`],
    ['分镜', s.cuts ?? '—', `${s.segments ?? '—'} 段`],
  ];
  $('#kpis').innerHTML = kpis.map(([k, v, n]) => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v">${esc(v)}${n ? `<small>· ${esc(n)}</small>` : ''}</div></div>`).join('');

  // 流水线
  const stageMap = Object.fromEntries(d.stages.map((x) => [x.key, x]));
  const order = [['outline', '改编大纲', 'outline.json'], ['characters', '角色设定', 'cast.json'], ['art', '美术设定', 'art.json'], ['script', '剧本', 'script.json'], ['staging', '开场站位', 'staging.json'], ['storyboard', '分镜', 'storyboard.json']];
  $('#pipeline').innerHTML = order.map(([k, cn, sub], i) => {
    const st = stageMap[k];
    const done = !!st?.json;
    const rep = st?.report ? `<a href="/media/${encodeURIComponent(d.name)}/${st.dir}/${encodeURIComponent(st.report)}" target="_blank" rel="noopener">报告</a>` : '';
    return `<div class="stage ${done ? 'done' : ''}"><span class="idx">${String(i + 1).padStart(2, '0')}</span>
      <span class="nm">${esc(cn)}<small>${esc(sub)}</small></span>
      <span class="st">${done ? '✓ 已产出' : '— 待生成'} ${rep}</span></div>`;
  }).join('');

  // 成片
  const finals = d.media.finals || [];
  const best = [...finals].sort((a, b) => (b.path.includes('v2') ? 1 : 0) - (a.path.includes('v2') ? 1 : 0) || b.size - a.size)[0];
  const v = $('#hero-video');
  if (best) {
    const poster = state.data.media.frames?.[0]?.url || '';
    const shotMode = location.search.includes('shot');
    if (shotMode) {
      // 截图模式：不加载视频，只显示封面，避免 headless 等待网络空闲
      const box = $('.hero-media');
      let img = box.querySelector('img.shot-poster');
      if (!img) { img = document.createElement('img'); img.className = 'shot-poster'; box.appendChild(img); }
      img.src = poster; img.alt = 'poster';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
      v.style.display = 'none';
    } else if (v.dataset.src !== best.url) {
      v.dataset.src = best.url; v.src = best.url;
      if (poster) v.poster = poster;
    }
    $('.hero-media').classList.add('has-video');
    $('#hero-badge').style.display = 'block' ;
    if (location.search.includes('shot')) { const e = document.querySelector('#hero-empty'); if (e) e.style.display = 'none'; }
    $('#hero-badge').textContent = best.path.split('/').pop();
  } else {
    $('.hero-media').classList.remove('has-video');
    $('#hero-badge').style.display = 'none';
    const box = $('.hero-media');
    let img = box.querySelector('img.hero-cover');
    const cover = (d.meta && d.meta.cover) || d.media.scenes?.[0]?.url || d.media.frames?.[0]?.url || '';
    if (cover) {
      if (!img) { img = document.createElement('img'); img.className = 'hero-cover'; box.appendChild(img); }
      img.src = cover;
    } else if (img) { img.remove(); }
  }

  // 底部条
  const strip = [
    ['场景设定图', d.media.scenes.length, 'art/images'],
    ['角色锚点', d.media.characters.length, 'characters/images'],
    ['分镜关键帧', d.media.frames.length, 'frames/'],
    ['视频段', d.media.segments.length, 'renders/segments'],
    ['成片 / 超分版', `${d.media.finals.length} / ${d.media.upscaled.length}`, 'renders/'],
  ];
  $('#strip').innerHTML = strip.map(([k, v, n]) => `<div class="cell"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="n">${esc(n)}</div></div>`).join('');
}

/* ------------------------------- 脚本视图 ------------------------------- */
const SCRIPT_TABS = [
  ['outline', '改编大纲'], ['characters', '角色设定'], ['art', '美术设定'],
  ['script', '剧本'], ['staging', '开场站位'], ['storyboard', '分镜'],
];

function renderScriptTabs() {
  $('#script-tabs').innerHTML = SCRIPT_TABS.map(([k, n]) => `<button class="tab ${k === state.scriptTab ? 'is-on' : ''}" data-stab="${k}">${n}</button>`).join('');
  $$('#script-tabs .tab').forEach((b) => (b.onclick = () => { state.scriptTab = b.dataset.stab; renderScript(); }));
}

function renderScript() {
  renderScriptTabs();
  const d = state.data, pane = $('#script-pane');
  const k = state.scriptTab;
  if (k === 'outline') pane.innerHTML = viewOutline(d);
  else if (k === 'characters') pane.innerHTML = viewCast(d);
  else if (k === 'art') pane.innerHTML = viewArt(d);
  else if (k === 'script') pane.innerHTML = viewScript(d);
  else if (k === 'staging') pane.innerHTML = viewStaging(d);
  else pane.innerHTML = viewStoryboard(d);
}

const sec = (cn, en) => `<div class="sec-title"><h2>${esc(cn)}</h2><span>${esc(en)}</span></div>`;

function viewOutline(d) {
  const o = d.outline;
  if (!o) return `<div class="empty">还没有大纲</div>`;
  const a = o.adaptation || {};
  const ch = (o.characters || []).map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.role)}</td><td><span class="tag ${c.tier === 'lead' ? 'verm' : c.tier === 'support' ? 'gold' : 'jade'}">${esc(c.tier)}</span></td><td>${esc(c.arc)}</td></tr>`).join('');
  const beats = (o.beats || []).map((b) => `<tr><td>${esc(b.id)}</td><td>${esc(b.type)}</td><td>${esc(b.weight || '')}</td><td>第 ${esc(b.episode)} 集</td><td>${esc(b.setup)} → ${esc(b.payoff)}</td></tr>`).join('');
  const eps = (o.episodes || []).map((e) => `<div class="ep"><div class="ep-head"><b>第 ${e.ep} 集</b><span class="meta">钩子：${esc(e.hook || '—')}</span></div>
    <div class="ep-body"><p style="color:var(--ink-2);line-height:1.9;margin:0 0 10px">${esc(e.synopsis || '')}</p>
    <div class="meta"><span>悬念：${esc(e.suspense || '—')}</span></div></div></div>`).join('');
  return `${sec('改编说明', 'ADAPTATION')}
    <div class="grid2">
      <div class="card"><h3>核心</h3><p>${esc(a.core || '—')}</p></div>
      <div class="card"><h3>取舍</h3><p>保留 ${esc((a.keep || []).length)} 条 · 合并 ${esc((a.merge || []).length)} 条 · 删除 ${esc((a.cut || []).length)} 条</p>
        <div class="meta">${(a.keep || []).map((x) => `<span>${esc(x.what || x)}</span>`).slice(0, 6).join('')}</div></div>
    </div>
    ${sec('人物表', 'CHARACTERS')}
    <table class="tbl"><thead><tr><th>角色</th><th>定位</th><th>分档</th><th>弧光</th></tr></thead><tbody>${ch}</tbody></table>
    ${sec('爽点表', 'BEATS')}
    <table class="tbl"><thead><tr><th>ID</th><th>类型</th><th>权重</th><th>落点</th><th>埋 → 兑现</th></tr></thead><tbody>${beats}</tbody></table>
    ${sec('分集梗概', 'EPISODES')}${eps}`;
}

function viewCast(d) {
  const list = d.cast?.characters || [];
  if (!list.length) return `<div class="empty">还没有角色设定</div>`;
  return `${sec('角色设定集', `${list.length} CHARACTERS`)}
    <div class="cast-grid">${list.map((c) => `<div class="cast-card">
      <div class="top"><b>${esc(c.name)}</b><span class="tag ${c.importance === 'protagonist' || c.importance === 'major' ? 'verm' : 'gold'}">${esc(c.importance || '')}</span></div>
      <p>${esc(c.oneLiner || '')}</p>
      <div class="voice">${esc((c.voice?.prompt || c.voice?.text || '').slice(0, 90))}${(c.voice?.prompt || '').length > 90 ? '…' : ''}</div>
    </div>`).join('')}</div>`;
}

function viewArt(d) {
  const a = d.art;
  if (!a) return `<div class="empty">还没有美术设定</div>`;
  const scenes = (a.scenes || []).map((s) => `<div class="card"><h3>${esc(s.name)} ${s.primary ? '<span class="tag gold">主场景</span>' : '<span class="tag">一次性</span>'}</h3>
    <div class="meta">锚点 ${esc((s.anchors || []).length)} 条 · 光照 ${esc((s.lighting || s.lightingStates || []).length)} 态</div></div>`).join('');
  const props = (a.props || []).map((p) => `<div class="card"><h3>${esc(p.name)}</h3><p>${esc((p.function || '').slice(0, 80))}</p></div>`).join('');
  return `${sec('场景', `${(a.scenes || []).length} SCENES`)}<div class="grid2">${scenes}</div>
    ${sec('叙事道具', `${(a.props || []).length} PROPS`)}<div class="grid2">${props}</div>`;
}

function viewScript(d) {
  const eps = d.script || [];
  if (!eps.length) return `<div class="empty">还没有剧本</div>`;
  return sec('分场剧本', 'SCREENPLAY') + eps.map((ep) => `<div class="ep">
    <div class="ep-head"><b>第 ${ep.ep} 集</b><span class="meta">目标 ${esc(ep.targetSeconds)} 秒 · ${ep.scenes.length} 场</span></div>
    <div class="ep-body">${ep.scenes.map((s, i) => `<div class="scene">
      <div class="scene-h"><b>${esc(s.sceneId)}</b><em>${esc(s.characters?.join(' · ') || '')}</em></div>
      <div class="flow">${s.flow.map((b) => b.line ? `<div class="beat dlg"><span class="who">${esc(b.who)}</span><span class="txt">${esc(b.line)} <span class="dl">${esc(b.delivery || '')}</span></span></div>`
        : `<div class="beat act"><span class="who">动作</span><span class="txt">${esc(b.action)}</span></div>`).join('')}</div>
    </div>`).join('')}</div></div>`).join('');
}

function viewStaging(d) {
  const st = d.staging;
  if (!st) return `<div class="empty">还没有站位</div>`;
  const cs = st.scenes || [];
  if (!cs.length) {
    return `${sec('开场站位', 'BLOCKING')}<div class="empty">staging.json 已存在，但结构未识别</div>`;
  }
  const rows = cs.map((s) => `<tr><td>${esc(s.sceneId || s.id || '')}</td><td>${esc(s.locationName || s.location || '')}</td>
    <td>${(s.characters || s.people || []).map((p) => esc(p.name || p.character || '')).join('、')}</td>
    <td>${esc(s.blocking || s.summary || '')}</td></tr>`).join('');
  return `${sec('开场站位', `${cs.length} SCENES`)}<table class="tbl"><thead><tr><th>场</th><th>地点</th><th>在场</th><th>走位</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function viewStoryboard(d) {
  const eps = d.storyboard || [];
  if (!eps.length) return `<div class="empty">还没有分镜</div>`;
  const total = eps.reduce((n, e) => n + e.segments.length, 0);
  return sec('分镜', `${total} SEGMENTS`) + eps.map((ep) => `<div class="ep">
    <div class="ep-head"><b>第 ${ep.ep} 集</b><span class="meta">${ep.segments.length} 段 · ${fmt(ep.segments.reduce((n, s) => n + s.seconds, 0), 1)} 秒</span></div>
    <div class="ep-body">${ep.segments.map((sg) => `<div class="seg">
      <div class="seg-h"><b>${esc(sg.id)}</b><span class="meta">${fmt(sg.seconds, 1)}s · ${sg.cuts.length} 切</span><span class="note">${esc((sg.note || '').slice(0, 42))}</span></div>
      <div class="cuts">${sg.cuts.map((c, i) => `<div class="cut"><span class="t">${fmt(c.seconds, 1)}s</span>
        <span class="s">${esc(c.size || '')}</span>
        <span class="f"><b>${esc(c.camera || '')}</b> · ${esc((c.shot || '').slice(0, 84))}${(c.shot || '').length > 84 ? '…' : ''}</span></div>`).join('')}</div>
      <details class="h3"><summary>H3 提示词</summary><pre>${esc(sg.h3Prompt || '')}</pre></details>
    </div>`).join('')}</div></div>`).join('');
}

/* ------------------------------- 素材视图（图片 + 视频） ------------------------------- */
const ASSET_TABS = [
  ['scenes', '场景设定图', 'image'], ['characters', '角色锚点', 'image'], ['frames', '分镜关键帧', 'image'],
  ['segments', '视频段', 'video'], ['finals', '成片', 'video'], ['upscaled', 'SeedVR2 超分', 'video'],
];

function renderAssets() {
  if (!state.data) return;
  const media = state.data.media || {};
  const tabs = $('#asset-tabs');
  if (tabs) {
    tabs.innerHTML = ASSET_TABS.map(([k, n]) =>
      `<button class="tab ${k === state.assetTab ? 'is-on' : ''}" data-atab="${k}">${n} <span style="color:var(--muted-2)">${(media[k] || []).length}</span></button>`).join('');
    $$('#asset-tabs .tab').forEach((b) => (b.onclick = () => { state.assetTab = b.dataset.atab; renderAssets(); }));
  }
  const kind = (ASSET_TABS.find((t) => t[0] === state.assetTab) || [])[2] || 'image';
  const files = media[state.assetTab] || [];
  const grid = $('#asset-grid');
  if (!grid) return;
  if (!files.length) { grid.innerHTML = `<div class="empty">这一组还没有内容</div>`; return; }
  if (kind === 'image') {
    grid.innerHTML = files.map((f) => `<div class="tile" data-url="${esc(f.url)}" data-cap="${esc(f.path)}">
        <img loading="lazy" src="${esc(f.url)}" alt="${esc(f.path)}" />
        <div class="cap"><b>${esc(f.path.split('/').slice(-1)[0])}</b><span>${mb(f.size)}</span></div>
      </div>`).join('');
    $$('#asset-grid .tile').forEach((t) => (t.onclick = () => openLightbox(t.dataset.url, t.dataset.cap)));
  } else {
    const posterOf = (seg) => (media.frames || []).find((x) => x.path.includes(`/${seg}/f1.png`))?.url || '';
    grid.innerHTML = files.map((f) => {
      const seg = f.path.match(/E\d\d-\d\d/)?.[0] || '';
      const poster = seg ? posterOf(seg) : (media.frames?.[0]?.url || '');
      const acts = seg && state.assetTab === 'segments' ? `<div class="acts">
        <button class="btn btn-ghost" data-run="videos" data-args='["--only","${seg}","--force"]'>重跑这段</button>
        <button class="btn btn-ghost" data-run="upscale" data-args='["--only","${seg}","--force"]'>超分</button></div>` : '';
      return `<div class="tile video"><video controls preload="metadata" ${poster ? `poster="${esc(poster)}"` : ''} src="${esc(f.url)}"></video>
        <div class="cap"><b>${esc(seg || f.path.split('/').pop())}</b><span>${mb(f.size)}</span></div>${acts}</div>`;
    }).join('');
    $$('#asset-grid [data-run]').forEach((b) => (b.onclick = () => runTask(b.dataset.run, JSON.parse(b.dataset.args || '[]'))));
  }
}

/* ------------------------------- 任务台 ------------------------------- */
// 手动补产的数字按当前项目的实际产物统计，别写死成某部剧
function taskDefs() {
  const st = state.data?.stats || {};
  const m = state.data?.meta || {};
  return [
    ['validate', '跑全部质量门', '六阶 validate'],
    ['scenes', '出场景设定图', st.scenes ? `${st.scenes} 张` : '场景'],
    ['characters', '出角色锚点图', st.characters ? `${st.characters} 人` : '角色'],
    ['frames', '出分镜关键帧', st.cuts ? `${st.cuts} 张` : '关键帧'],
    ['videos', '生成视频段', st.segments ? `${st.segments} 段 H3` : 'H3'],
    ['upscale', 'SeedVR2 超分', m.resolution === '1080p' ? '1080' : '720'],
  ];
}

function renderTaskList() {
  $('#task-list').innerHTML = taskDefs().map(([k, n, s]) => `<button class="task-btn" data-task="${k}"><span>${esc(n)}</span><small>${esc(s)}</small></button>`).join('');
  $$('#task-list .task-btn').forEach((b) => (b.onclick = () => runTask(b.dataset.task)));
}

async function runTask(task, args = []) {
  if (state.busy) return toast('已有任务在跑');
  const r = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p: state.project, task, args, scopeEps: scopeEpsSel() }) });
  const j = await r.json();
  if (!r.ok) return toast(j.error || '任务启动失败');
  state.busy = true;
  $('#btn-cancel').disabled = false;
  $('#job-title').textContent = `任务台 · ${j.job.label}`;
  setView('jobs');
  appendLog(`▶ 已启动：${j.job.label}`);
  toast('任务已启动');
}

async function restoreLastJob() {
  if (state.busy) return;
  try {
    const j = await (await fetch('/api/run/last', { cache: 'no-store' })).json();
    if (!j || !Array.isArray(j.lines) || !j.lines.length) return;
    if (j.project !== state.project) return;
    const el = $('#console') || $('#pf-log');
    if (!el) return;
    $('#job-title') && ($('#job-title').textContent = `任务台 · ${j.label}（上次）`);
    el.textContent = '';
    j.lines.forEach((l) => appendLog(l));
    appendLog(`—— 上次任务结束：${j.exitCode === 0 ? '成功' : '失败/未通过'}（${(j.doneAt || '').slice(11, 19)}）——`);
  } catch {}
}

function appendLog(line) {
  const el = $('#pf-log') || $('#console');
  const isErr = /^!|✗|失败|error|Error/.test(line);
  const div = document.createElement('div');
  if (isErr) div.className = 'ln-err';
  div.textContent = line;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function connectEvents() {
  try {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'chat' && (!m.project || m.project === state.project)) { state.produce.bubble = null; handleChatEvent(m.event); }
      if (m.type === 'produce') {
        // 只显示当前项目的生产；别的剧在后台跑不串台
        if (m.project && m.project !== state.project) return;
        handleProduceEvent(m.event);
      }
      if (m.type === 'log') appendLog(m.line);
      if (m.type === 'done') {
        state.busy = false;
        $('#btn-cancel').disabled = true;
        appendLog(`—— 任务结束（退出码 ${m.exitCode}）——`);
        refresh();
        pollComfy();
      }
    };
  } catch { /* SSE 不可用 */ }
}

async function pollActive() {
  try {
    const a = await (await fetch('/api/active')).json();
    if (a && a.id) { state.busy = true; $('#job-title').textContent = `任务台 · ${a.label}`; }
  } catch {}
}

async function pollComfy() {
  const panel = $('#comfy');
  if (panel && !panel.dataset.bound) {
    panel.dataset.bound = '1';
    panel.style.cursor = 'pointer';
    panel.title = '点击重试';
    panel.onclick = () => pollComfy();
  }
  try {
    const c = await (await fetch('/api/comfy', { cache: 'no-store' })).json();
    const dot = $('#comfy-dot');
    if (c.ok) {
      dot.className = 'dot ok';
      const short = (c.name || 'ComfyUI').replace(/^cuda:\d+\s*/, '').replace(/ : .*/, '').trim();
      $('#comfy-name').textContent = short.length > 18 ? short.slice(0, 17) + '…' : short;
      $('#comfy-name').title = c.name || '';
      const total = c.vramTotal ? (c.vramTotal / 1073741824).toFixed(0) : null;
      const used = c.vramTotal != null && c.vramFree != null
        ? ((c.vramTotal - c.vramFree) / 1073741824).toFixed(1)
        : null;
      const mem = used != null && total != null ? `${used}/${total}G` : '—';
      $('#comfy-meta').textContent = `运行 ${c.running} · 排队 ${c.pending} · 显存 ${mem} · ${c.latencyMs ?? '—'}ms`;
      $('#comfy-meta').title = c.name || '';
    } else {
      dot.className = 'dot bad';
      $('#comfy-meta').textContent = '连接失败 · 点击重试';
      $('#comfy-meta').title = `${c.error || '未知错误'}\n目标：${c.target || ''}`;
    }
  } catch (e) {
    $('#comfy-dot').className = 'dot bad';
    $('#comfy-meta').textContent = '连接失败 · 点击重试';
    $('#comfy-meta').title = String(e.message || e);
  }
}

/* ------------------------------- 交互绑定 ------------------------------- */
function bindNav() {
  $$('#nav .nav-item').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  $$('[data-view-jump]').forEach((b) => (b.onclick = () => setView(b.dataset.viewJump)));
}

function setView(v, syncHash = true) {
  const projectViews = ['workspace', 'script', 'assets', 'produce'];
  if (v === 'projects') {
    try { const u = new URL(location.href); u.searchParams.delete('p'); history.replaceState(null, '', u.toString()); } catch {}
  }
  if (projectViews.includes(v) && !state.project) { toast('先从项目库选一部剧'); v = 'projects'; }
  state.view = v;
  if (syncHash) history.replaceState(null, '', '#' + v);
  $$('#nav .nav-item').forEach((b) => b.classList.toggle('is-on', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('is-on', s.id === 'view-' + v));
  renderHeader();
  if (v === 'jobs') restoreLastJob();
  if (v === 'projects') renderProjects();
  if (v === 'workspace') renderProjectDetail();
  if (v === 'script') renderScript();
  if (v === 'assets') renderAssets();
  if (v === 'produce') initProduce();
  if (v === 'settings') renderSettings();
}

function bindActions() {
  bindChatTabs();   // 右侧栏「对话 / 生产」页签
  $('#btn-validate').onclick = () => { if (!state.project) return toast('先选项目'); runTask('validate'); };
  $('#btn-report').onclick = () => {
    const rep = state.data?.reports?.find((r) => r.key === 'storyboard') || state.data?.reports?.[0];
    if (!rep) return toast('还没有报告');
    window.open(rep.url, '_blank', 'noopener');
  };
  const bp = $('#back-projects'); if (bp) bp.onclick = (e) => { e.preventDefault(); setView('projects'); };
  const bh = $('#brand-home'); if (bh) bh.onclick = (e) => { e.preventDefault(); setView('projects'); };
  const wg = $('#ws-produce'); if (wg) wg.onclick = () => setView('produce');
  const wsc = $('#ws-script'); if (wsc) wsc.onclick = () => setView('script');
  const ar = $('#btn-asset-refresh'); if (ar) ar.onclick = () => refresh();
  $('#btn-clear-log') && ($('#btn-clear-log').onclick = () => { const el = $('#pf-log'); if (el) el.textContent = ''; });
  const stop = $('#pf-stop'); if (stop) stop.onclick = async () => {
    await fetch('/api/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }).catch(() => {});
    toast('已请求停止');
  };
  const rs = $('#btn-resume'); if (rs) rs.onclick = async () => {
    const r = await fetch('/api/produce/resume', { method: 'POST' });
    const j = await r.json();
    if (!r.ok) return toast(j.error || '续跑失败');
    setView('produce'); toast('已续跑上次生产');
  };
  $('#lightbox-close').onclick = closeLightbox;
  $('#lightbox').onclick = (e) => { if (e.target.id === 'lightbox') closeLightbox(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
}

function openLightbox(url, cap) {
  $('#lightbox-img').src = url;
  $('#lightbox-cap').textContent = cap || '';
  $('#lightbox').classList.add('on');
}
function closeLightbox() { $('#lightbox').classList.remove('on'); $('#lightbox-img').src = ''; }

let toastT;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('on'), 2600);
}


function updateCorruptBanner() {
  const d = state.data; if (!d) return;
  const b = $('#corrupt-banner'); if (!b) return;
  const cs = d.corruptStages || [];
  if (cs.length) {
    b.innerHTML = `⚠ 检测到 <b>${cs.map((x) => x.name).join('、')}</b> 的产物文件损坏（JSON 解析不过，多半是上次生成写到一半被截断）。勾选左下「重跑前期」再点开始生成即可重来；不勾的话流程会在这里停下提示。`;
    b.classList.add('on');
  } else b.classList.remove('on');
  const rb = $('#resume-bar');
  if (rb) {
    rb.style.display = (d.resumeAvailable && !state.produce.running) ? 'flex' : 'none';
    const btn = $('#btn-resume');
    if (btn) btn.textContent = d.resumeInfo?.stage ? `继续上次生产（上次停在：${d.resumeInfo.stage}）` : '继续上次生产';
  }
  // 产物过期：上游改过、下游没重出，明说别让人误会
  let sb = $('#stale-banner');
  if (!sb) {
    sb = document.createElement('div');
    sb.id = 'stale-banner';
    sb.className = 'corrupt-banner stale';
    const anchor = $('#corrupt-banner');
    anchor ? anchor.after(sb) : $('.produce-live')?.prepend(sb);
  }
  const st = d.stale || [];
  if (st.length) {
    sb.innerHTML = `⚠ 产物过期：${st.map((x) => `<b>${esc(x.label)}</b>`).join('、')}<div style="margin-top:6px;font-weight:400">${st.map((x) => esc(x.detail)).join('；')}。<br />处理办法：重出对应阶段（关键帧/视频），或勾「重跑前期」从头对齐。</div>`;
    sb.classList.add('on');
  } else sb.classList.remove('on');
}




function addProduceStage(ev) {
  const box = $('#ai-chat'); if (!box) return;
  const d = document.createElement('div');
  d.className = 'pstage';
  d.innerHTML = `<b>${String(ev.index).padStart(2, '0')}/${ev.total}</b> ${esc(ev.label)}`;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  chatTab('produce');
}
function addProduceLine(line, isErr = false) {
  const box = $('#ai-chat'); if (!box) return;
  const d = document.createElement('div');
  d.className = 'plog' + (isErr ? ' err' : '');
  d.textContent = String(line).slice(0, 400);
  box.appendChild(d);
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  if (state.view !== 'produce') { const bd = $('#produce-badge'); if (bd) bd.hidden = false; }
}

/* 右侧栏：对话 / 生产 页签 */
function chatTab(tab) {
  $$('#chat-tabs .chat-tab').forEach((b) => b.classList.toggle('is-on', b.dataset.ctab === tab));
  $$('.chat-pane').forEach((p) => p.classList.toggle('is-on', p.id === 'chat-pane-' + tab));
  if (tab === 'produce') { const bd = $('#produce-badge'); if (bd) bd.hidden = true; }
}
function bindChatTabs() {
  $$('#chat-tabs .chat-tab').forEach((b) => (b.onclick = () => chatTab(b.dataset.ctab)));
}

/* ------------------------------ 设置：模型接口 ------------------------------ */
let settingsCache = null;

function workflowMapping(kind) {
  const workflow = settingsCache.comfy?.workflows?.[kind];
  if (!workflow) return '';
  const options = Object.entries(workflow.graph).flatMap(([id, node]) => Object.entries(node.inputs)
    .filter(([, value]) => !Array.isArray(value) && (typeof value === 'string' || typeof value === 'number'))
    .map(([field]) => ({ value: JSON.stringify([id, field]), label: `${id} · ${node._meta?.title || node.class_type} · ${field}` })));
  const fields = { prompt: '提示词（必选）', negative: '负向提示词', seed: '随机种子', image: '参考图 1／视频首帧',
    image2: '参考图 2', image3: '参考图 3', image4: '参考图 4', seconds: '时长（秒）', frames: '帧数', fps: '帧率', prefix: '文件名前缀' };
  return `<div class="prov-grid">${Object.entries(fields).map(([key, label]) => `<label>${label}
    <select data-binding="${key}" data-kind="${kind}"><option value="">不替换，保留工作流设置</option>${options.map((o) => `<option value="${esc(o.value)}" ${JSON.stringify(workflow.bindings?.[key]) === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`).join('')}
    <label>输出节点（必选）<select data-output-node="${kind}"><option value="">请选择保存文件的节点</option>${Object.entries(workflow.graph).map(([id, node]) => `<option value="${esc(id)}" ${workflow.outputNode === id ? 'selected' : ''}>${esc(id + ' · ' + (node._meta?.title || node.class_type))}</option>`).join('')}</select></label></div>`;
}

async function renderSettings() {
  const box = $('#settings-panel');
  if (!box) return;
  box.innerHTML = '<div class="loading">加载中…</div>';
  try {
    settingsCache = await (await fetch('/api/settings')).json();
  } catch (e) {
    box.innerHTML = '<div class="empty">读取失败：' + esc(String(e.message || e)) + '</div>';
    return;
  }
  const ps = settingsCache.providers || [];
  box.innerHTML = ps.map((p) => `
    <div class="prov ${p.id === settingsCache.active ? 'prov-on' : ''}" data-id="${esc(p.id)}">
      <div class="prov-head">
        <label class="prov-pick"><input type="radio" name="prov-active" value="${esc(p.id)}" ${p.id === settingsCache.active ? 'checked' : ''} /> 作为当前接口</label>
        <span class="tag ${p.hasKey ? 'jade' : 'verm'}">${p.hasKey ? '密钥已配置 ' + esc(p.keyMask) : '缺密钥'}</span>
        <span class="tag">${esc(p.protocol)}</span>
        <button class="btn btn-ghost prov-test" data-test="${esc(p.id)}">测试连接</button>
        <span class="prov-result" data-res="${esc(p.id)}"></span>
      </div>
      <div class="prov-grid">
        <label>名称<input data-f="label" value="${esc(p.label)}" /></label>
        <label>模型<input data-f="model" value="${esc(p.model)}" /></label>
        <label>接口地址<input data-f="baseUrl" value="${esc(p.baseUrl)}" /></label>
        <label>协议<select data-f="protocol">
          <option value="openai" ${p.protocol === 'openai' ? 'selected' : ''}>openai（chat/completions）</option>
          <option value="anthropic" ${p.protocol === 'anthropic' ? 'selected' : ''}>anthropic（v1/messages）</option>
        </select></label>
        <label>密钥${p.hasKey ? '（留空=不修改）' : ''}<input data-f="apiKey" type="password" placeholder="${p.hasKey ? '•••• 已保存' : '粘贴 API Key'}" /></label>
        <label>max tokens<input data-f="maxTokens" type="number" value="${esc(p.maxTokens || 8000)}" /></label>
        <label>推理强度<input data-f="reasoningEffort" value="${esc(p.reasoningEffort || '')}" placeholder="low / medium / 留空" /></label>
        <label>密钥来源 env<input data-f="keyEnv" value="${esc(p.keyEnv || '')}" placeholder="如 ZAI_CODING_CN_API_KEY" /></label>
      </div>
      ${p.note ? `<div class="prov-note">${esc(p.note)}</div>` : ''}
    </div>`).join('') + `
    <div class="comfy-block">
      <div class="sec-title"><h3>ComfyUI</h3><span>出图出片的目标地址 · 改完点保存热更新 · 无需重启</span><button class="btn btn-ghost" id="workflow-restore-defaults">恢复内置工作流</button></div>
      <div class="comfy-row">
        <label>地址<input id="comfy-url" class="input" value="${esc((settingsCache.comfy && settingsCache.comfy.url) || '')}" placeholder="http://127.0.0.1:8188" />
        <button class="btn btn-ghost" id="comfy-test">测试连接</button>
        <span class="comfy-result" id="comfy-result"></span>
      </div>
      <div class="prov-note">使用自己的本机 ComfyUI，无需填写显卡或显存。工作流请从 ComfyUI 导出为 API 格式 JSON。</div>
      ${['image', 'frame', 'video'].map((kind) => `
        <div class="comfy-row">
          <label>${({ image: '场景／角色出图', frame: '关键帧出图（图生图，可选）', video: '出视频' })[kind]}工作流
            <input type="file" accept=".json,application/json" data-workflow="${kind}" />
          </label>
          <span data-workflow-name="${kind}">${esc(settingsCache.comfy?.workflows?.[kind]?.name || '未配置')}</span>
          <button class="btn btn-ghost" data-workflow-clear="${kind}">清除</button>
        </div><div data-workflow-mapping="${kind}">${workflowMapping(kind)}</div>`).join('')}
      <div class="prov-note">内置工作流已预设节点映射，也可导入自己的 API 工作流。图生图参考按场景图／角色图传入；内置 H3 视频按分镜切点顺序传入关键帧，最多 4 张。未映射的输入保留工作流原值，模型与尺寸由工作流决定。请使用本地计算节点，第三方云端节点可能自行联网。</div>
      ${settingsCache.comfy?.workflows === undefined ? '<div class="prov-note">服务仍在运行旧版本，请等生产任务结束后重启，再配置工作流。</div>' : ''}
    </div>`;
  if (settingsCache.comfy?.workflows === undefined) {
    $$('[data-workflow], [data-workflow-clear]').forEach((el) => { el.disabled = true; });
  }
  $('#workflow-restore-defaults').onclick = async () => {
    try {
      const response = await fetch('/api/settings/workflow-defaults');
      if (!response.ok) throw new Error('服务尚未加载内置工作流，请在任务结束后重启服务');
      const data = await response.json();
      if (!data.workflows || !Object.values(data.workflows).some(Boolean)) throw new Error('此版本没有内置工作流');
      settingsCache.comfy.workflows = data.workflows;
      for (const kind of ['image', 'frame', 'video']) {
        $(`[data-workflow="${kind}"]`).value = '';
        $(`[data-workflow-name="${kind}"]`).textContent = (data.workflows[kind]?.name || '未配置') + '（待保存）';
        $(`[data-workflow-mapping="${kind}"]`).innerHTML = workflowMapping(kind);
      }
      toast('内置工作流已恢复，点击顶部保存后生效');
    } catch (e) { toast(e.message); }
  };
  $$('#settings-panel [data-workflow]').forEach((input) => {
    input.onchange = async () => {
      const file = input.files[0]; if (!file) return;
      try {
        const graph = JSON.parse(await file.text());
        if (!graph || typeof graph !== 'object' || Array.isArray(graph) || !Object.keys(graph).length ||
            Object.values(graph).some((n) => !n || typeof n.class_type !== 'string' || !n.inputs || typeof n.inputs !== 'object' || Array.isArray(n.inputs))) {
          throw new Error('请使用 ComfyUI 导出的 API 格式工作流');
        }
        settingsCache.comfy.workflows ||= {};
        settingsCache.comfy.workflows[input.dataset.workflow] = { name: file.name, graph };
        $(`[data-workflow-name="${input.dataset.workflow}"]`).textContent = file.name + '（待保存）';
        $(`[data-workflow-mapping="${input.dataset.workflow}"]`).innerHTML = workflowMapping(input.dataset.workflow);
      } catch (e) { toast('导入失败：' + e.message); input.value = ''; }
    };
  });
  $$('[data-workflow-clear]').forEach((button) => {
    button.onclick = () => {
      const kind = button.dataset.workflowClear;
      settingsCache.comfy.workflows ||= {};
      settingsCache.comfy.workflows[kind] = null;
      $(`[data-workflow="${kind}"]`).value = '';
      $(`[data-workflow-name="${kind}"]`).textContent = '未配置（待保存）';
      $(`[data-workflow-mapping="${kind}"]`).innerHTML = '';
    };
  });
  const cu = $('#comfy-url'); if (cu) cu.addEventListener('input', () => { const r = $('#comfy-result'); if (r) { r.textContent = ''; r.className = 'comfy-result'; } });
  const ct = $('#comfy-test'); if (ct) ct.onclick = async () => {
    const url = (cu.value || '').trim();
    const r = $('#comfy-result'); if (!r) return;
    r.textContent = '测试中…'; r.className = 'comfy-result';
    try {
      const res = await (await fetch('/api/comfy/ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })).json();
      r.textContent = res.ok ? `✓ ${res.latencyMs}ms · 可达` : `✗ ${String(res.error || '').slice(0, 80)}`;
      r.className = 'comfy-result ' + (res.ok ? 'ok' : 'bad');
    } catch (e) { r.textContent = '✗ ' + e.message; r.className = 'comfy-result bad'; }
  };

  $$('.prov-test').forEach((b) => (b.onclick = async () => {
    const id = b.dataset.test;
    const out = $(`[data-res="${id}"]`);
    out.textContent = '测试中…';
    out.className = 'prov-result';
    try {
      const r = await (await fetch('/api/settings/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })).json();
      out.textContent = r.ok ? `✓ ${r.ms}ms · ${r.model} · ${r.text || '(空)'}` : `✗ ${r.ms}ms · ${String(r.error || '').slice(0, 90)}`;
      out.className = 'prov-result ' + (r.ok ? 'ok' : 'bad');
    } catch (e) { out.textContent = '✗ ' + e.message; out.className = 'prov-result bad'; }
  }));
}

async function saveSettings() {
  for (const kind of ['image', 'frame', 'video']) {
    const workflow = settingsCache.comfy?.workflows?.[kind];
    if (!workflow) continue;
    workflow.bindings = {};
    $$(`[data-binding][data-kind="${kind}"]`).forEach((el) => { if (el.value) workflow.bindings[el.dataset.binding] = JSON.parse(el.value); });
    workflow.outputNode = $(`[data-output-node="${kind}"]`).value;
    if (!workflow.bindings.prompt || !workflow.outputNode) return toast('请选择工作流的提示词输入和输出节点');
  }
  const ps = $$('.prov').map((el) => {
    const g = (f) => el.querySelector(`[data-f="${f}"]`);
    return {
      id: el.dataset.id,
      label: g('label').value.trim(),
      model: g('model').value.trim(),
      baseUrl: g('baseUrl').value.trim(),
      protocol: g('protocol').value,
      maxTokens: Number(g('maxTokens').value) || 8000,
      reasoningEffort: g('reasoningEffort').value.trim(),
      keyEnv: g('keyEnv').value.trim(),
      apiKey: g('apiKey').value.trim(),
    };
  });
  const active = $$('input[name="prov-active"]').find((x) => x.checked)?.value;
  const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providers: ps, active, comfy: { url: (($('#comfy-url') || {}).value || '').trim(), workflows: settingsCache.comfy?.workflows || {} } }) });
  const j = await r.json();
  if (!r.ok || j.ok === false) return toast(j.error || '保存失败');
  toast('已保存，下一次生产/对话生效');
  renderSettings();
}

function bindSettings() {
  const save = $('#btn-settings-save'); if (save) save.onclick = saveSettings;
  const re = $('#btn-settings-reload'); if (re) re.onclick = renderSettings;
}

/* ------------------------------ 一键生成（生产） ------------------------------ */
state.produce = { running: false, chips: new Map(), bubble: null, novelsLoaded: false };
state.chat = { sending: false, bubble: null, open: true, loadedFor: null };

async function loadNovels() {
  if (state.produce.novelsLoaded) return;
  try {
    const list = await (await fetch('/api/novels')).json();
    const opts = '<option value="">— 选择 Downloads 里的 txt/md —</option>' +
      list.map((n) => `<option value="${esc(n.path)}">${esc(n.name)}</option>`).join('');
    const sel = $('#pf-novel-file'); if (sel) sel.innerHTML = opts;
    const wz = $('#wz-novel-file'); if (wz) wz.innerHTML = opts;
    state.produce.novelsLoaded = true;
  } catch {}
}

function resetProduceUI() {
  $('#pf-timeline').innerHTML = '<div class="tl-empty">准备中…<br /><small>阶段会随执行逐条点亮</small></div>';
  $('#ai-chat').innerHTML = '';
  $('#pf-log').textContent = '';
  state.produce.chips.clear();
  state.produce.bubble = null;
  $('#ai-state').textContent = '启动中';
  $('#log-state').textContent = '—';
}

function tlChip(ev) {
  const chips = $('#pf-timeline');
  const empty = chips.querySelector('.tl-empty');
  if (empty) empty.remove();
  let el = chips.querySelector(`[data-stage="${ev.id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'tl-chip';
    el.dataset.stage = ev.id;
    el.innerHTML = `<i>${String(ev.index).padStart(2, '0')}</i><span>${esc(ev.label)}</span>`;
    el.dataset.label = ev.label;
    chips.appendChild(el);
    el.scrollIntoView({ block: 'nearest' });
  }
  el.classList.remove('running', 'done', 'error');
  el.classList.add(ev.status);
  if (ev.status === 'done') el.querySelector('i').textContent = '✓';
  if (ev.status === 'error') el.querySelector('i').textContent = '✗';
  chips.scrollTop = chips.scrollHeight;
}

function aiBubble() {
  const chat = $('#ai-chat');
  if (!state.produce.bubble) {
    const d = document.createElement('div');
    d.className = 'msg ai';
    chat.appendChild(d);
    state.produce.bubble = d;
  }
  return state.produce.bubble;
}

function newAiBubble() { state.produce.bubble = null; }

let _skipN = 0; const skipCount = () => _skipN;

function startProduceTicker() {
  if (startProduceTicker._t) return;
  startProduceTicker._t = setInterval(() => {
    const el = $('#produce-ticker');
    if (!el) return;
    const st = state.produce || {};
    if (!state.produce.running) { el.classList.remove('on'); return; }
    const started = Number(st.startedAt) || 0;
    const secs = started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0;
    const hh = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60;
    const dur = hh ? `${hh}h${String(mm).padStart(2, '0')}m` : mm ? `${mm}m${String(ss).padStart(2, '0')}s` : `${ss}s`;
    const stage = st.stage || $('#log-state')?.textContent || '准备中';
    const lastAt = Number(st.lastEventAt) || 0;
    const idle = lastAt ? Math.round((Date.now() - lastAt) / 1000) : null;
    el.textContent = `● 运行中 ${dur} · 当前阶段：${stage}${idle !== null ? ` · 最近一条日志 ${idle}s 前` : ''}`;
    el.classList.add('on');
  }, 1000);
}


// SSE 不稳时也能看到日志：轮询服务端最近的日志行，按行补齐（去重，只追加新行）
async function syncProduceLogFromServer() {
  if (!state.project) return;
  const el = $('#pf-log');
  if (!el) return;
  try {
    const j = await (await fetch('/api/produce/log?lines=300', { cache: 'no-store' })).json();
    const lines = (j.lines || []).filter((x) => x.project === state.project && x.line).map((x) => String(x.line));
    if (!lines.length) return;
    const have = el.textContent;
    // 找出服务端日志里、当前面板还没显示的尾部（按顺序匹配最后一条）
    const lastShown = have.split('\n').filter(Boolean).slice(-1)[0] || '';
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i] === lastShown || lines[i].includes(lastShown.slice(0, 40))) { idx = i; break; }
    const append = idx >= 0 ? lines.slice(idx + 1) : lines;
    if (!append.length) return;
    if (!have || have.includes('等待任务') || /^▶ 生产任务进行中/.test(have.trim())) el.textContent = '';
    for (const ln of append) {
      el.textContent += (el.textContent && !el.textContent.endsWith('\n') ? '\n' : '') + ln;
    }
    el.scrollTop = el.scrollHeight;
  } catch {}
}

function handleProduceEvent(ev) {
  if (!ev) return;
  state.produce.lastEventAt = Date.now();
  if (ev.type === 'stage_start' && ev.label) state.produce.stage = ev.label;
  if (ev.type === 'heartbeat' && ev.label) state.produce.stage = ev.label;
  const log = $('#pf-log');
  const pushLog = (line) => { log.textContent += (log.textContent && !log.textContent.endsWith('\n') ? '\n' : '') + line; log.scrollTop = log.scrollHeight; };
  switch (ev.type) {
    case 'produce_start':
      _skipN = 0;
      state.produce.running = true;
      state.produce.startedAt = Date.now();
      resetProduceUI();
      $('#pf-stop').disabled = false;
      $('#pf-start').disabled = true;
      $('#ai-state').textContent = '运行中';
      pushLog(`▶ 生产开始：${ev.project}（${ev.total} 个阶段）`);
      break;
    case 'stage_start':
      tlChip({ ...ev, status: 'running' });
      $('#log-state').textContent = ev.label;
      newAiBubble();
      pushLog(`\n━━ ${String(ev.index).padStart(2, '0')}/${ev.total} ${ev.label} ━━`);
      addProduceStage(ev);
      break;
    case 'stage_skip': {
      const chips0 = $('#pf-timeline'); const e0 = chips0.querySelector('.tl-empty'); if (e0) e0.remove();
      tlChip({ id: ev.id, index: (_skipN += 1), label: ev.label || ev.id, status: 'skipped' });
      pushLog(`↷ ${ev.label}：${ev.reason}`);
      break;
    }
    case 'stage_done':
      tlChip({ ...ev, status: 'done' });
      pushLog(`✓ ${ev.label} 完成（${(ev.ms / 1000).toFixed(1)}s）`);
      addProduceLine(`✓ ${ev.label} 完成（${(ev.ms / 1000).toFixed(1)}s）`);
      break;
    case 'stage_error':
      tlChip({ ...ev, status: 'error' });
      pushLog(`✗ ${ev.label} 失败：${ev.error}`);
      addProduceLine('✗ ' + ev.label + ' 失败：' + ev.error, true);
      break;
    case 'ai_delta': {
      // 助手正在回复时，这个 delta 属于对话，不属于生产进程——别混进来
      if (state.chat.sending) return;
      const b = aiBubble();
      b.textContent += ev.text;
      b.parentElement.scrollTop = b.parentElement.scrollHeight;
      break;
    }
    case 'ai_message': {
      const b = aiBubble();
      if (!b.textContent || b.textContent.length < ev.text.length) b.textContent = ev.text;
      newAiBubble();
      break;
    }
    case 'tool_call': {
      if (state.chat.sending) return;
      const chat = $('#ai-chat');
      const d = document.createElement('div');
      d.className = 'tool';
      const args = JSON.stringify(ev.args || {}).slice(0, 220);
      d.innerHTML = `<b>▸ ${esc(ev.name)}</b> ${esc(args)}`;
      chat.appendChild(d);
      chat.scrollTop = chat.scrollHeight;
      break;
    }
    case 'tool_result': {
      const chat = $('#ai-chat');
      const d = document.createElement('div');
      d.className = 'tool';
      d.innerHTML = `<span class="res">${esc(String(ev.result || '').slice(0, 600))}</span>`;
      chat.appendChild(d);
      chat.scrollTop = chat.scrollHeight;
      break;
    }
    case 'heartbeat': {
      const secs = Math.round((ev.elapsedMs || 0) / 1000);
      $('#ai-state').textContent = state.produce.running ? `运行中 ${secs}s` : '空闲';
      const box = $('#pf-timeline');
      const cur = box && (box.querySelector(`[data-stage="${ev.id}"]`) || box.querySelector('.tl-chip.running'));
      if (cur && cur.lastElementChild) cur.lastElementChild.textContent = `${ev.label || cur.dataset.label || ''} · ${secs}s`;
      break;
    }
    case 'stage_retry': {
      pushLog(`↻ ${ev.label || ev.id} 第 ${ev.attempt}/${ev.max} 次重试（等 ${Math.round((ev.waitMs || 0) / 1000)}s）：${String(ev.error || '').slice(0, 120)}`);
      break;
    }
    case 'stage_cancelled': {
      const box = $('#pf-timeline');
      const chip = box && box.querySelector(`[data-stage="${ev.id}"]`);
      if (chip) { chip.classList.remove('running'); chip.classList.add('cancelled'); }
      pushLog(`■ ${ev.label || ev.id} 已取消`);
      break;
    }
    case 'agent_done':
      pushLog(`· ${ev.label || '模型'} 本轮结束（${ev.turns} 轮 / ${(ev.ms / 1000).toFixed(0)}s）${ev.truncated ? ' ⚠ 未跑完就被轮数上限打断' : ''}`);
      break;
    case 'log':
      pushLog(ev.line);
      addProduceLine(ev.line);
      break;
    case 'produce_done': {
      state.produce.running = false;
      if (ev.error) toast('生产中断：' + String(ev.error).slice(0, 60));
      $('#pf-stop').disabled = true;
      $('#pf-start').disabled = false;
      $('#ai-state').textContent = ev.error ? '失败' : (ev.cancelled ? '已取消' : '完成');
      $('#log-state').textContent = '—';
      if (ev.error) pushLog(`\n✗ 生产中止：${ev.error}`);
      else if (ev.cancelled) pushLog('\n■ 已取消');
      else if (ev.done < ev.total) pushLog(`\n■ 生产结束：只完成 ${ev.done}/${ev.total} 阶段（后面被跳过或中断）。看上方红色提示定位原因。`);
      else pushLog(`\n✓ 生产完成：${ev.done}/${ev.total} 阶段，用时 ${(ev.ms / 60000).toFixed(1)} 分钟`);
      loadProjects().then(() => { if (state.projects.find((p) => p.name === $('#pf-name').value)) selectProject($('#pf-name').value); });
      break;
    }
  }
}

async function confirmProducePlan(body) {
  let plan = null;
  try {
    const r = await fetch('/api/produce/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) plan = await r.json();
  } catch {}
  if (!plan || !Array.isArray(plan.rows)) return true; // 预览失败不挡开工
  const run = plan.rows.filter((x) => x.willRun);
  const skip = plan.rows.filter((x) => !x.willRun);
  const row = (x, cls) => `<div class="prow ${cls}"><span>${esc(x.label)}</span><em>${esc(x.reason || '')}</em></div>`;
  return await new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'plan-modal';
    ov.innerHTML = `<div class="plan-card">
      <div class="plan-head"><b>开工前确认</b><span>${run.length} 个阶段会跑 · ${skip.length} 个跳过</span></div>
      <div class="plan-grid">
        <div class="plan-col"><div class="plan-col-h">会跑 ${run.length}</div>${run.map((x) => row(x, 'run')).join('') || '<div class="pempty">无</div>'}</div>
        <div class="plan-col"><div class="plan-col-h">跳过 ${skip.length}</div>${skip.map((x) => row(x, 'skip')).join('') || '<div class="pempty">无</div>'}</div>
      </div>
      ${plan.warnings && plan.warnings.length ? `<div class="plan-warn">${plan.warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
      <div class="plan-actions"><button class="btn btn-ghost" data-v="0">取消</button><button class="btn btn-accent" data-v="1">继续开工</button></div>
    </div>`;
    document.body.appendChild(ov);
    const close = (v) => { ov.remove(); resolve(v); };
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) return close(b.dataset.v === '1');
      if (e.target === ov) close(false);
    });
  });
}

function scopeEpsSel() {
  const v = $('#pf-scope')?.value;
  return v ? [Number(v)] : null;
}

function updateScopeHint() {
  const h = document.querySelector('.scope-hint');
  if (!h) return;
  const st = state.data?.stats || {};
  const eps = st.episodes || 1;
  const segs = st.segments || 0;
  const perEp = eps ? Math.max(1, Math.round(segs / eps)) : 0;
  const sel = scopeEpsSel();
  if (sel && sel.length) {
    const n = sel.length;
    h.textContent = `第 ${sel.join('、')} 集：约 ${perEp * n} 段视频，出片约 ${Math.round((perEp * n * 7) / 60)} 小时；跑完再跑下一集更稳`;
  } else {
    h.textContent = `全部 ${eps} 集：约 ${segs} 段视频，出片约 ${Math.round((segs * 7) / 60)} 小时（按每段 7 分钟估）`;
  }
}

async function startProduce() {
  if (state.produce.running) return toast('已有生产任务');
  if (!state.project) return toast('先从项目库选一部剧');
  const m = state.data?.meta || {};
  const options = {
    plot: $('#pf-opt-plot').checked,
    images: $('#pf-opt-images').checked,
    videos: $('#pf-opt-videos').checked,
    upscale: $('#pf-opt-upscale').checked,
    concat: $('#pf-opt-concat').checked,
    report: $('#pf-opt-report').checked,
    forcePre: $('#pf-opt-forcepre')?.checked || false,
  };
  const body = {
    p: state.project,
    scopeEps: scopeEpsSel(),
    episodes: Number(m.episodes) || Number($('#pf-episodes').value) || 1,
    seconds: Number(m.secondsPerEpisode) || Number($('#pf-seconds').value) || 120,
    genre: m.genre || '',
    style: m.style || '',
    aspect: m.aspect || '9:16',
    resolution: m.resolution || '720p',
    options,
  };
  if (!(await confirmProducePlan(body))) return;
  const r = await fetch('/api/produce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) return toast(j.error || '启动失败');
  resetProduceUI();
  syncProduceUI(true, '启动中');
  toast('已开始，进度在右侧直播');
}

async function stopProduce() {
  await fetch('/api/produce/cancel', { method: 'POST' });
  toast('已请求停止');
}

async function restoreProduceLog(name, force = false) {
  try {
    const lg = await (await fetch('/api/produce/log?lines=60')).json();
    const lines = (lg.lines || []).filter((x) => x.project === (name || state.project) || !x.project);
    if (lines.length) {
      const log = $('#pf-log');
      if (log && (force || !log.textContent || log.textContent === '等待任务…')) {
        log.textContent = lines.map((x) => {
          const t = (x.at || '').slice(11, 19);
          if (x.type === 'stage_start') return `${t} ━━ ${x.label} ━━`;
          if (x.type === 'stage_done') return `${t} ✓ ${x.label} 完成（${Math.round((x.ms || 0) / 1000)}s）`;
          if (x.type === 'stage_error') return `${t} ✗ ${x.label} 失败：${x.error}`;
          if (x.type === 'produce_done') return `${t} ${x.error ? '■ 中断：' + x.error : '✓ 生产结束'}`;
          if (x.type === 'produce_start') return `${t} ▶ 生产开始（${x.episodes} 集 × ${x.seconds}s）`;
          return null;
        }).filter(Boolean).join('\n');
      }
    }
  } catch {}
}

async function initProduce() {
  await loadNovels();
  await restoreProduceLog(state.project);
  // 状态以服务端为准：刷新后不再卡在“启动中/按钮禁用”
  try {
    const st = await (await fetch('/api/produce/state', { cache: 'no-store' })).json();
    if (st.running && st.startedAt) state.produce.startedAt = Number(st.startedAt);
    syncProduceUI(st.running, st.stage);
    if (!st.running && state.produce.running) {
      state.produce.running = false;
      $('#ai-state').textContent = '已中断';
      $('#pf-start').disabled = false;
      $('#pf-stop').disabled = true;
      const log = $('#pf-log');
      if (log) log.textContent += '\n\n⚠ 任务已不在运行（服务重启或被中断），可重新点「开始生成」';
      toast('上次生产已中断，可重新开始');
    }
  } catch {}
  const d = state.data, m = d?.meta || {};
  const sum = $('#pf-project-summary');
  const create = $('#pf-create-fields');
  if (state.project && d) {
    if (create) create.hidden = true;
    if (sum) {
      const eps = m.episodes || d.stats.episodes || 1;
      const sec = m.secondsPerEpisode || (d.stats.minutes ? d.stats.minutes * 60 : 120) || 120;
      const hasSrc = (d.media?.frames || []).length >= 0 && true;
      sum.innerHTML = `
        <div class="cell"><div class="k">项目</div><div class="v">${esc(m.title || d.name)}</div></div>
        <div class="cell"><div class="k">规格</div><div class="v">${eps} 集 × ${sec}s · ${esc(m.aspect || '9:16')} · ${esc(m.resolution || '720p')}</div></div>
        <div class="cell"><div class="k">题材</div><div class="v">${esc(presetLabel('genres', m.genre) || '—')}</div></div>
        <div class="cell"><div class="k">画风</div><div class="v">${esc(presetLabel('styles', m.style) || '—')}</div></div>`;
    }
    // 内部同步参数（不再显示给用户填）
    $('#pf-name').value = m.title || d.name;
    $('#pf-episodes').value = m.episodes || 1;
    $('#pf-seconds').value = m.secondsPerEpisode || 120;
    $('#pf-genre').value = m.genre || '';
    $('#pf-style').value = m.style || '';
  } else if (create) { create.hidden = false; }
  const scSel = $('#pf-scope');
  if (scSel) {
    const eps = Number(m.episodes) || Number(d?.stats?.episodes) || 1;
    const keep = scSel.value;
    scSel.innerHTML = '<option value="">全部集</option>' + Array.from({ length: eps }, (_, i) => `<option value="${i + 1}">第 ${i + 1} 集</option>`).join('');
    if ([...scSel.options].some((o) => o.value === keep)) scSel.value = keep;
    scSel.onchange = updateScopeHint;
    updateScopeHint();
  }
  if (!$('#produce-ticker')) {
    const box = document.querySelector('.produce-live');
    if (box) { const d = document.createElement('div'); d.className = 'produce-ticker'; d.id = 'produce-ticker'; box.prepend(d); }
  }
  startProduceTicker();
  bindChatTabs();
  $('#pf-start').onclick = startProduce;
  $('#pf-stop').onclick = stopProduce;
  $('#pf-novel-file').onchange = () => {
    const v = $('#pf-novel-file').value;
    if (v && !$('#pf-name').value) {
      const base = v.split('/').pop().replace(/\.(txt|md)$/i, '');
      $('#pf-name').value = base;
    }
  };
  try {
    const st = await (await fetch('/api/produce/state')).json();
    if (st.running) {
      state.produce.running = true;
      $('#pf-start').disabled = true;
      $('#pf-stop').disabled = false;
      $('#ai-state').textContent = '运行中';
      const tl = $('#pf-timeline');
      tl.innerHTML = '';
      tlChip({ id: 'current', index: 1, label: st.stage || '执行中', status: 'running' });
      $('#log-state').textContent = st.stage || '';
      $('#pf-log').textContent = `▶ 生产任务进行中：${st.project}`;
      toast('已有生产任务在进行，日志会继续推送');
    }
  } catch {}
}

/* ------------------------------ 项目首页 / 新建向导 ------------------------------ */
state.presets = null;
state.wizard = { step: 1, genre: null, style: null, mode: 'file', uploaded: null };

function presetLabel(kind, id) {
  if (!id) return '';
  const hit = (state.presets?.[kind] || []).find((x) => x.id === id);
  return hit ? hit.label : id;
}

function renderProjects() {
  const grid = $('#project-grid');
  if (!grid) return;
  const cards = (state.projects || []).map((p) => {
    const cover = p.cover ? `<img src="${esc(p.cover)}" alt="" />` : `<div class="ph">NO COVER</div>`;
    const tags = [
      p.genre ? `<span class="tag gold">${esc(presetLabel('genres', p.genre))}</span>` : '',
      p.style ? `<span class="tag">${esc(presetLabel('styles', p.style))}</span>` : '',
      p.episodes ? `<span class="tag jade">${esc(p.episodes)} 集</span>` : '',
    ].join('');
    return `<div class="pcard" data-p="${esc(p.name)}">
      <div class="cover">${cover}</div>
      <div class="body">
        <h3>${esc(p.title || p.name)}</h3>
        <div class="tags">${tags}</div>
        <div class="meta"><span>${p.seconds ? p.seconds + ' 秒/集' : '—'}</span><span>${p.progress || 0}% 前期</span></div>
        <div class="bar"><i style="width:${p.progress || 0}%"></i></div>
      </div>
    </div>`;
  }).join('');
  grid.innerHTML = cards + `<div class="pcard new" id="card-new">＋ 新建项目<br /><small style="color:var(--muted-2)">导入剧本 · 选题材画风</small></div>`;
  grid.querySelectorAll('.pcard[data-p]').forEach((el) => (el.onclick = () => selectProject(el.dataset.p)));
  const nw = $('#card-new');
  if (nw) nw.onclick = openWizard;
}

async function openWizard() {
  await loadNovels();
  state.wizard = { step: 1, genre: null, style: null, mode: 'file', uploaded: null };
  $('#wz-title').value = '';
  $('#wz-novel-text').value = '';
  $('#wz-episodes').value = 1;
  $('#wz-seconds').value = 120;
  $('#wz-novel-file').value = '';
  $('#wz-aspect').value = '9:16';
  $('#wz-resolution').value = '720p';
  $('#wz-detect').innerHTML = '';
  renderWizardStep();
  renderPresetGrids();
  $('#wizard').classList.add('on');
}

function renderWizardStep() {
  const st = state.wizard.step;
  $$('.wz-step').forEach((el) => el.classList.toggle('is-on', Number(el.dataset.wz) === st));
  $('#wz-step-label').textContent = st === 1 ? '第 1 步 / 2 · 基本信息' : '第 2 步 / 2 · 题材与画风';
  $('#wz-prev').style.visibility = st === 1 ? 'hidden' : 'visible';
  $('#wz-next').textContent = st === 1 ? '下一步' : '创建项目';
}

function renderPresetGrids() {
  const mk = (list, kind) => list.map((x) => {
    const on = state.wizard[kind] === x.id ? 'is-on' : '';
    return `<div class="preset ${on}" data-kind="${kind}" data-id="${esc(x.id)}">
      <img src="${esc(x.img)}" alt="${esc(x.label)}" loading="lazy" onerror="this.style.display='none';this.parentNode.classList.add('noimg')" />
      <div class="lb"><span>${esc(x.label)}</span><i>${on ? '✓' : ''}</i></div>
    </div>`;
  }).join('');
  $('#wz-genres').innerHTML = mk(state.presets?.genres || [], 'genre');
  $('#wz-styles').innerHTML = mk(state.presets?.styles || [], 'style');
  const g = state.presets?.genres?.find((x) => x.id === state.wizard.genre);
  const st = state.presets?.styles?.find((x) => x.id === state.wizard.style);
  $('#wz-genre-pick').textContent = g ? g.label : '未选';
  $('#wz-style-pick').textContent = st ? st.label : '未选';
  $$('.preset').forEach((el) => (el.onclick = () => {
    state.wizard[el.dataset.kind] = el.dataset.id;
    renderPresetGrids();
  }));
}

async function parseScriptPreview() {
  const box = $('#wz-detect');
  if (!box) return;
  const mode = state.wizard.mode;
  if (mode === 'brief') { box.innerHTML = '<span style="color:var(--muted-2)">梗概模式：按下面填的集数生成，创建后可自动出大纲与剧本</span>'; return; }
  const text = mode === 'file' ? (state.wizard.uploaded?.text || '') : $('#wz-novel-text').value;
  const path = mode === 'file' ? ($('#wz-novel-file').value || '') : '';
  if (!path && !text.trim()) { box.innerHTML = ''; return; }
  box.innerHTML = '<span style="color:var(--muted-2)">识别中…</span>';
  try {
    const r = await fetch('/api/parse-script', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(text.trim() ? { text } : { path }),
    });
    const d = await r.json();
    if (!d.total) { box.innerHTML = '未识别到内容'; return; }
    $('#wz-episodes').value = d.total;
    const chips = d.episodes.map((e) => `<span class="eps">${esc(e.title).slice(0, 14)} · ${e.chars}字</span>`).join('');
    box.innerHTML = d.detected
      ? `✓ 识别到 <b>${d.total} 集</b>（已自动分集，原文按集存档）<br />${chips}`
      : `未发现分集标记，按 <b>1 集</b>处理（${d.total ? d.episodes[0].chars : 0} 字）`;
  } catch (e) { box.innerHTML = '识别失败，可手动填集数'; }
}

function setWizardMode(mode) {
  state.wizard.mode = mode;
  $$('#wz-modes .wz-mode').forEach((b) => b.classList.toggle('is-on', b.dataset.mode === mode));
  $$('.wz-pane').forEach((p) => p.classList.toggle('is-on', p.dataset.pane === mode));
}

async function readUploadedFile(file) {
  if (!file) return;
  if (!/\.(txt|md)$/i.test(file.name)) return toast('先支持 .txt / .md，其它格式可粘贴正文');
  const text = await file.text();
  state.wizard.uploaded = { name: file.name, text };
  const row = $('#wz-file-row');
  if (row) { row.hidden = false; row.textContent = `✓ 已读取 ${file.name}（${text.length} 字）`; }
  if (!$('#wz-title').value.trim()) {
    $('#wz-title').value = file.name.replace(/\.(txt|md)$/i, '').replace(/^\d+[_-]+/, '').trim();
  }
  parseScriptPreview();
}

function bindWizard() {
  $$('#wz-modes .wz-mode').forEach((b) => (b.onclick = () => { setWizardMode(b.dataset.mode); parseScriptPreview(); }));
  const drop = $('#wz-drop');
  if (drop) {
    drop.onclick = (e) => { if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'OPTION') $('#wz-file-input').click(); };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('hover'); };
    drop.ondragleave = () => drop.classList.remove('hover');
    drop.ondrop = async (e) => { e.preventDefault(); drop.classList.remove('hover'); await readUploadedFile(e.dataTransfer.files?.[0]); };
  }
  const fi = $('#wz-file-input');
  if (fi) fi.onchange = () => readUploadedFile(fi.files?.[0]);
  const nb = $('#btn-new-project');
  if (nb) nb.onclick = () => openWizard();
  $('#wz-close').onclick = () => $('#wizard').classList.remove('on');
  $('#wz-prev').onclick = () => { state.wizard.step = 1; renderWizardStep(); };
  $('#wz-next').onclick = () => {
    if (state.wizard.step === 1) {
      if (!$('#wz-title').value.trim()) return toast('先填剧名');
      const m = state.wizard.mode;
      if (m === 'brief' && !$('#wz-brief').value.trim()) return toast('先写故事梗概');
      if (m === 'text' && !$('#wz-novel-text').value.trim()) return toast('先粘贴正文');
      if (m === 'file' && !state.wizard.uploaded && !$('#wz-novel-file').value) return toast('上传一个剧本文件，或从 Downloads 里选');
      state.wizard.step = 2;
      renderWizardStep();
    } else {
      if (!state.wizard.genre || !state.wizard.style) return toast('选一个题材和一个画风');
      createProject();
    }
  };
  let parseTimer = null;
  const scheduleParse = () => { clearTimeout(parseTimer); parseTimer = setTimeout(parseScriptPreview, 400); };
  $('#wz-novel-file').onchange = () => {
    const v = $('#wz-novel-file').value;
    if (v && !$('#wz-title').value.trim()) {
      const base = v.split('/').pop().replace(/\.(txt|md)$/i, '');
      $('#wz-title').value = base.replace(/^\d+[_-]+/, '').trim() || base;
    }
    scheduleParse();
  };
  $('#wz-novel-text').addEventListener('input', scheduleParse);
}

async function createProject() {
  const title = $('#wz-title').value.trim();
  const mode = state.wizard.mode;
  const body = {
    title,
    source: mode,
    brief: mode === 'brief' ? $('#wz-brief').value.trim() : undefined,
    novelText: mode === 'text' ? $('#wz-novel-text').value.trim() : (mode === 'file' ? (state.wizard.uploaded?.text || undefined) : undefined),
    novelPath: mode === 'file' && !state.wizard.uploaded ? ($('#wz-novel-file').value || undefined) : undefined,
    episodes: Number($('#wz-episodes').value) || 1,
    seconds: Number($('#wz-seconds').value) || 120,
    genre: state.wizard.genre,
    style: state.wizard.style,
    aspect: $('#wz-aspect').value || '9:16',
    resolution: $('#wz-resolution').value || '720p',
  };
  const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) return toast(j.error || '创建失败');
  $('#wizard').classList.remove('on');
  toast('项目已创建');
  await loadProjects();
  await selectProject(j.project.name);
  // 只写梗概 + 勾了自动生成 → 立刻跑 情节/大纲/剧本
  if (body.source === 'brief' && $('#wz-autopre').checked) {
    const r2 = await fetch('/api/produce', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p: j.project.name, only: ['plot', 'outline', 'characters', 'art', 'script', 'staging', 'storyboard'], options: { plot: true, images: false, videos: false, upscale: false, concat: false, report: false } }),
    });
    if (r2.ok) { setView('produce'); toast('已开始生成前期六阶（大纲→角色→美术→剧本→站位→分镜）'); }
  }
}

/* -------------------------------- 项目详情 / 分集 -------------------------------- */
async function renderProjectDetail() {
  const host = $('#project-detail');
  if (!host) return;
  if (!state.project) { host.innerHTML = '<div class="empty">先从「项目」里选一部</div>'; return; }
  const d = state.data, m = d.meta || {};
  let eps = { rows: [], total: 0 };
  try { eps = await (await fetch('/api/episodes?p=' + encodeURIComponent(state.project))).json(); } catch {}
  const cover = m.cover || (d.media.scenes[0]?.url) || (d.media.frames[0]?.url) || '';
  const ST = ['空', '有原文', '有梗概', '有剧本', '有分镜', '有出图', '有成片'];
  const rows = (eps.rows || []).map((r) => {
    const tagCls = r.status >= 4 ? 'gold' : r.status >= 1 ? 'jade' : '';
    return `<div class="ep-card" data-ep="${r.ep}">
      <div class="hd">
        <b>${esc(r.tag)}</b><span class="t">第 ${r.ep} 集</span>
        <span class="st"><span class="tag ${tagCls}">${ST[r.status] || '空'}</span><span class="tag">${r.scenes} 场 · ${r.lines} 句</span>${r.segments ? `<span class="tag">${r.segments} 段</span>` : ''}${r.videos ? `<span class="tag gold">${r.videos} 段视频</span>` : ''}</span>
      </div>
      <div class="bd">
        <div>
          <textarea class="syn" data-syn="${r.ep}" placeholder="写这一集的梗概：谁、在哪、发生什么、结尾钩子……">${esc(r.synopsis || r.synopsisOutline || '')}</textarea>
          ${r.sourcePreview ? `<div class="srcline">原文（${r.sourceChars} 字）：${esc(r.sourcePreview)}…</div>` : ''}
          ${r.hook ? `<div class="hookline">大纲钩子：${esc(r.hook)}</div>` : ''}
          <div class="stats"><span>${r.frames} 帧</span><span>${r.cuts} 切</span><span>${r.seconds || 0}s</span></div>
        </div>
        <div class="ops">
          <button class="btn btn-ghost" data-act="save" data-ep="${r.ep}">保存梗概</button>
          <button class="btn" data-act="script" data-ep="${r.ep}">AI 写本集剧本</button>
          <button class="btn btn-ghost" data-act="continue" data-ep="${r.ep}">续写第 ${r.ep + 1} 集</button>
          <button class="btn btn-ghost" data-act="assets" data-ep="${r.ep}">看本集素材</button>
        </div>
      </div>
    </div>`;
  }).join('');

  host.innerHTML = `
    <div class="sec-title"><h2>分集</h2><span>${eps.total || 0} EPISODES</span></div>
    <div class="eps">${rows || '<div class="empty">还没有分集</div>'}</div>`;

  const pd = $('#pd-produce'); if (pd) pd.onclick = () => setView('produce');
  const psv = $('#pd-script-view'); if (psv) psv.onclick = () => setView('script');
  $$('#project-detail [data-act]').forEach((b) => (b.onclick = () => episodeAction(b.dataset.act, Number(b.dataset.ep))));
}

async function episodeAction(act, ep) {
  if (act === 'save') {
    const text = $(`textarea[data-syn="${ep}"]`).value;
    const r = await fetch('/api/episode/synopsis', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p: state.project, ep, text }),
    });
    return r.ok ? toast('梗概已保存') : toast('保存失败');
  }
  if (act === 'assets') {
    setView('images');
    return;
  }
  const text = $(`textarea[data-syn="${ep}"]`)?.value || '';
  const r = await fetch('/api/episode/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p: state.project, ep, action: act === 'continue' ? 'continue' : 'script', synopsis: text, seconds: state.data?.meta?.secondsPerEpisode || 120 }),
  });
  const j = await r.json();
  if (!r.ok) return toast(j.error || '启动失败');
  setView('produce');
  toast(act === 'continue' ? `正在续写第 ${ep + 1} 集` : `正在写第 ${ep} 集剧本`);
}

boot();


/* ---------------------------------- 右侧 AI 助手 ---------------------------------- */
function chatEl() { return $('#chat-msgs'); }

function chatScroll() { const el = chatEl(); if (el) el.scrollTop = el.scrollHeight; }

function addChatBubble(role, text) {
  const el = chatEl();
  if (!el) return null;
  const hint = el.querySelector('.chat-hint'); if (hint) hint.remove();
  const d = document.createElement('div');
  d.className = 'cmsg ' + role;
  d.textContent = text || '';
  el.appendChild(d);
  chatScroll();
  return d;
}

function addChatTool(name, args) {
  const el = chatEl(); if (!el) return null;
  const d = document.createElement('div');
  d.className = 'ctool';
  const a = JSON.stringify(args || {}).slice(0, 80);
  d.innerHTML = `<b>▸ ${esc(name)}</b> ${esc(a)}`;
  el.appendChild(d); chatScroll();
  return d;
}

function syncProduceUI(running, stageText) {
  state.produce.running = !!running;
  const start = $('#pf-start'), stop = $('#pf-stop');
  if (start) start.disabled = !!running;
  if (stop) stop.disabled = !running;
  const st = $('#ai-state');
  if (st) st.textContent = running ? (stageText || '运行中') : '空闲';
}

function setChatBusy(busy) {
  state.chat.sending = busy;
  const send = $('#chat-send'), stop = $('#chat-stop');
  if (send) send.disabled = busy;
  if (stop) stop.disabled = !busy;
}

function clearChatView(showHint = true) {
  const el = chatEl(); if (!el) return;
  el.innerHTML = showHint ? '<div class="chat-hint">选一部剧后，可以直接让我改情节、改剧本、改资产；我会读文件、跑校验，改完告诉你结果。</div>' : '';
}

async function loadChatHistory() {
  const el = chatEl(); if (!el) return;
  $('#chat-proj').textContent = state.project || '未选择项目';
  const input = $('#chat-input');
  if (!state.project) {
    if (input) { input.disabled = true; input.placeholder = '先从「项目库」选一部剧'; }
    clearChatView(true);
    return;
  }
  if (input) { input.disabled = false; input.placeholder = '跟助手说：把第 2 集改成雨夜开场…'; }
  try {
    const d = await (await fetch('/api/chat/history?p=' + encodeURIComponent(state.project))).json();
    clearChatView(!(d.messages || []).length);
    for (const m of d.messages || []) addChatBubble(m.role === 'user' ? 'user' : 'assistant', m.content);
  } catch { clearChatView(true); }
}

function handleChatEvent(ev) {
  if (!ev) return;
  if (ev.type === 'chat_start') {
    setChatBusy(true);
    state.chat.bubble = addChatBubble('assistant', '');
    state.chat.bubble.classList.add('streaming');
    return;
  }
  if (ev.type === 'ai_delta') {
    if (!state.chat.bubble) state.chat.bubble = addChatBubble('assistant', '');
    state.chat.bubble.classList.add('streaming');
    state.chat.bubble.textContent += ev.text;
    chatScroll();
    return;
  }
  if (ev.type === 'ai_message') {
    if (state.chat.bubble && !state.chat.bubble.textContent.trim()) state.chat.bubble.textContent = ev.text;
    return;
  }
  if (ev.type === 'tool_call') { addChatTool(ev.name, ev.args); return; }
  if (ev.type === 'tool_result') {
    const el = chatEl();
    const d = document.createElement('div');
    d.className = 'ctool';
    d.innerHTML = `<span class="r">${esc(String(ev.result || '').slice(0, 400))}</span>`;
    el.appendChild(d); chatScroll();
    return;
  }
  if (ev.type === 'chat_done') {
    if (state.chat.bubble) state.chat.bubble.classList.remove('streaming');
    if (ev.error) addChatBubble('assistant', '出错了：' + ev.error);
    else if (ev.truncated) addChatBubble('assistant', `（本轮工具调用达到上限 ${ev.turns || ''}，已强制收尾；可以继续说“继续”让我接着做）`);
    state.chat.bubble = null;
    setChatBusy(false);
    refresh();
    return;
  }
}

async function sendChat() {
  if (!state.project) return toast('先从项目库选一部剧');
  if (state.chat.sending) return;
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addChatBubble('user', text);
  setChatBusy(true);
  const r = await fetch('/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p: state.project, message: text }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { setChatBusy(false); addChatBubble('assistant', '启动失败：' + (j.error || r.status)); }
}

function initChat() {
  const rail = $('#chat-rail');
  const toggle = $('#chat-toggle');
  if (toggle) toggle.onclick = () => { document.body.classList.add('chat-closed'); state.chat.open = false; localStorage.setItem('chat-closed', '1'); };
  const reopen = $('#chat-reopen');
  if (reopen) reopen.onclick = () => { document.body.classList.remove('chat-closed'); rail.classList.add('open'); state.chat.open = true; localStorage.setItem('chat-closed', '0'); };
  if (localStorage.getItem('chat-closed') === '1') document.body.classList.add('chat-closed');
  const send = $('#chat-send'); if (send) send.onclick = sendChat;
  const stop = $('#chat-stop'); if (stop) stop.onclick = async () => { await fetch('/api/chat/cancel', { method: 'POST' }); };
  const clear = $('#chat-clear'); if (clear) clear.onclick = async () => {
    if (!state.project) return;
    await fetch('/api/chat/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p: state.project }) });
    clearChatView(true);
  };
  const input = $('#chat-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });
  }
}
