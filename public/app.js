// Multi-Model Workspace frontend. Vanilla JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');

const S = {
  get ctxOpen() { return !!window.__ctxOpen; },
  me: null,
  models: [], modelMap: new Map(), maxModels: 3, modelsError: null,
  convs: [],
  skills: [],
  conv: null, resp: new Map(),
  running: new Map(),            // response id -> true while streaming in this tab
  tabs: {},                      // turn id -> response id shown on mobile
  expanded: new Set(),
  target: 'all',
  filters: { q: '', free: true, fast: false, reasoning: false, coding: false, popular: false },
  lastSel: null,
  alts: new Map(),               // response id -> alternatives array | 'loading'                 // { id, text } highlighted inside a card
  navOpen: false,
};

const STATUS_LABEL = { pending: 'Not started', generating: 'Generating', completed: 'Completed', failed: 'Failed', rate_limited: 'Rate limited', stopped: 'Stopped' };
const ERROR_HINT = {
  rate_limit: 'Free models share capacity with everyone on OpenRouter, and this one has run out for the moment. Retry in a minute, or swap in a model that is responding now.',
  insufficient_credits: 'Your OpenRouter account has no credits for this paid model. Add credits or use a free model.',
  context_limit: 'The conversation is too long for this model\'s context window.',
  invalid_model: 'This model is unavailable or no longer exists.',
  forbidden: 'OpenRouter refused this model for this kind of app.',
  timeout: 'The model stopped sending data.',
  network: 'Network problem reaching OpenRouter.',
  provider_unavailable: 'The provider is down or overloaded.',
  safety: 'The provider\'s safety filter blocked this request.',
};

// ---------- utils ----------
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => null);
  if (r.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/signup')) {
    const wasSignedIn = !!S.me;
    S.me = null; S.conv = null;
    renderAuth('login', wasSignedIn ? 'Your session ended. Sign in again and you will be back in this conversation, with any unsent message kept.' : '');
    throw new Error('Please sign in');
  }
  if (!r.ok) throw new Error(data?.error || `${r.status} ${r.statusText}`);
  return data;
}
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400); }
const fail = (e) => toast(e.message || String(e));
function md(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text || '', { breaks: false, gfm: true }));
  return `<div style="white-space:pre-wrap">${esc(text)}</div>`;
}
function fmtCost(c) { if (c === null || c === undefined) return '—'; if (c === 0) return 'Free'; return c < 0.01 ? `$${c.toFixed(5)}` : `$${c.toFixed(3)}`; }
function fmtTokens(n) { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n || 0); }
function perM(p) { return p === 0 ? '0' : (p * 1e6).toFixed(p * 1e6 < 1 ? 2 : 2).replace(/\.00$/, ''); }
function shortName(id) { const m = S.modelMap.get(id); return (m?.name || id).replace(/^[^:]+:\s*/, ''); }
function laneColor(modelId) { const m = S.conv?.models.find((x) => x.model_id === modelId); return `var(--lane-${(m?.position ?? 0) % 6})`; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const body = sel.anchorNode?.parentElement?.closest?.('.card-body');
  if (body) S.lastSel = { id: body.closest('.card').dataset.id, text: sel.toString() };
});

// ---------- auth ----------
function renderAuth(mode, notice = '') {
  $('#modal-root').innerHTML = '';
  app.innerHTML = `<div class="auth"><div class="auth-card">
    ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    <h1>${mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
    <div class="muted">One conversation. Multiple models. Pick the best response as you go.</div>
    <form id="auth-form">
      ${mode === 'signup' ? '<input class="input" name="name" placeholder="Name" autocomplete="name" required>' : ''}
      <input class="input" name="email" type="email" placeholder="Email" autocomplete="email" required>
      <input class="input" name="password" type="password" placeholder="Password (8+ characters)" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="8">
      <div class="err-text" id="auth-err"></div>
      <button class="btn primary" type="submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
    </form>
    <p class="small muted" style="margin:14px 0 0">${mode === 'login' ? 'No account yet?' : 'Already have an account?'}
      <a href="#" id="auth-switch">${mode === 'login' ? 'Create one' : 'Sign in'}</a></p>
  </div></div>`;
  $('#auth-switch').onclick = (e) => { e.preventDefault(); renderAuth(mode === 'login' ? 'signup' : 'login', notice); };
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try { S.me = await api('POST', mode === 'login' ? '/api/login' : '/api/signup', fd); await startApp(); }
    catch (err) { $('#auth-err').textContent = err.message; }
  };
}

// ---------- shell ----------
async function startApp() {
  S.filters.free = S.me.preferences.free_only !== false;
  renderShell();
  loadModels();
  await Promise.all([loadConvs(), loadSkills()]);
  route();
}

function renderShell() {
  app.innerHTML = `<div class="layout" id="layout">
    <aside class="sidebar">
      <div class="sidebar-head">
        <div class="brand"><span class="brand-mark"><i style="background:var(--lane-0)"></i><i style="background:var(--lane-1)"></i><i style="background:var(--lane-2)"></i></span>Multi-Model Workspace</div>
        <button class="btn primary" id="new-btn">+ New conversation</button>
      </div>
      <nav class="conv-list" id="conv-list"></nav>
      <section class="skills" id="skills"></section>
      <div class="sidebar-foot"><span class="who" title="${esc(S.me.email)}">${esc(S.me.name)}</span>
        <button class="btn small ghost" id="settings-btn">Settings</button>
        <button class="btn small ghost" id="logout-btn">Sign out</button></div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  $('#new-btn').onclick = () => { location.hash = '#/new'; closeNav(); };
  $('#logout-btn').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); S.me = null; renderAuth('login'); };
  $('#settings-btn').onclick = openSettings;
  $('#layout').addEventListener('click', (e) => { if (S.navOpen && !e.target.closest('.sidebar') && !e.target.closest('[data-nav]')) closeNav(); });
}
function closeNav() { S.navOpen = false; $('#layout')?.classList.remove('nav-open'); }
const mobileTop = (title) => `<div class="mobile-top"><button class="btn small" data-nav onclick="document.getElementById('layout').classList.add('nav-open')">☰</button><b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</b></div>`;

async function loadModels() {
  try {
    const { models, max_models } = await api('GET', '/api/models');
    S.models = models; S.maxModels = max_models; S.modelMap = new Map(models.map((m) => [m.id, m])); S.modelsError = null;
  } catch (e) { S.modelsError = e.message; }
  document.querySelectorAll('[data-picker]').forEach((el) => el._redraw?.());
  if (S.conv) { renderHead(); renderThread(); }
}

async function loadConvs() {
  S.convs = await api('GET', '/api/conversations');
  renderSidebar();
}
async function loadSkills() {
  try { S.skills = await api('GET', '/api/skills'); } catch { S.skills = []; }
  renderSkills();
}

function renderSkills() {
  const el = $('#skills'); if (!el) return;
  const inConv = !!S.conv;
  const on = new Set(inConv ? S.conv.skill_ids : newSkillIds());
  el.innerHTML = `<div class="skills-head"><b style="flex:1">Skills</b>
      <button class="btn small ghost" id="skill-tpl" title="Add from templates">Templates</button>
      <button class="btn small ghost" id="skill-new" title="Create a skill">+ New</button></div>
    ${S.skills.length ? `<div class="muted small skills-sub">Checked skills apply to ${inConv ? 'this chat' : 'the new chat'}</div>` : ''}
    <div class="skills-list">${S.skills.length ? S.skills.map((k) => `<div class="skill-row ${on.has(k.id) ? 'on' : ''}" title="${esc(k.description || k.instructions.slice(0, 160))}">
        <label><input type="checkbox" data-skill="${k.id}" ${on.has(k.id) ? 'checked' : ''}> <span>${esc(k.name)}</span></label>
        ${k.auto ? '<span class="tag" title="Switched on for every new chat">auto</span>' : ''}
        <button class="btn small ghost" data-edit-skill="${k.id}" title="Edit">✎</button></div>`).join('')
      : '<div class="muted small">Reusable instructions every model follows, like "Answer concisely" or "Act as a senior PM". <a href="#" id="skill-tpl2">Start from a template</a>.</div>'}</div>`;
  $('#skill-new').onclick = () => openSkillEditor();
  $('#skill-tpl').onclick = openSkillTemplates;
  const t2 = $('#skill-tpl2'); if (t2) t2.onclick = (e) => { e.preventDefault(); openSkillTemplates(); };
  el.onchange = async (e) => {
    const id = e.target.dataset.skill; if (!id) return;
    if (!S.conv) {
      const cur = new Set(newSkillIds());
      e.target.checked ? cur.add(id) : cur.delete(id);
      newState.skills = [...cur]; renderSkills(); return;
    }
    try {
      setConv(await api(e.target.checked ? 'PUT' : 'DELETE', `/api/conversations/${S.conv.conversation.id}/skills/${id}`));
      renderSkills(); renderHead(); estimate();
      toast(e.target.checked ? 'Skill on. Every model follows it from your next message.' : 'Skill off for this chat');
    } catch (err) { fail(err); e.target.checked = !e.target.checked; }
  };
  el.onclick = (e) => { const b = e.target.closest('[data-edit-skill]'); if (b) openSkillEditor(S.skills.find((k) => k.id === b.dataset.editSkill)); };
}

const SKILL_TEMPLATES = [
  { name: 'Concise answers', description: 'Short, direct, no preamble', instructions: 'Lead with the answer. Keep it under about 150 words unless the user asks for depth. Use short bullet points for lists. No preamble, no closing summary.' },
  { name: 'Plain writing', description: 'Natural human tone, no AI tics', instructions: 'Write in plain, natural language. Use short sentences and simple words. Never use em dashes. Avoid filler openers like "Great question" and avoid restating everything at the end.' },
  { name: 'Senior PM reviewer', description: 'Product thinking: users, metrics, trade-offs', instructions: 'Act as a senior product manager. Frame answers around the user problem, who it affects, success metrics, trade-offs, and risks. Call out assumptions. End with one recommended next step.' },
  { name: 'Code reviewer', description: 'Correctness first, then security and clarity', instructions: 'When code is involved, review for correctness first, then security, then readability and performance. Quote the exact lines you are commenting on and show a corrected version. Say explicitly if you found no real problems.' },
  { name: 'Facts vs. assumptions', description: 'Flag uncertainty instead of guessing', instructions: 'Separate facts from assumptions and opinions. State how confident you are in key claims. If you do not know something or it may be out of date, say so instead of guessing.' },
  { name: 'Explain simply', description: 'Beginner-friendly explanations', instructions: 'Explain as you would to a smart newcomer. Define any jargon the first time you use it. Use one concrete everyday analogy. Build from the basics to the answer.' },
  { name: 'Structured comparison', description: 'Tables for options and trade-offs', instructions: 'When comparing options, start with a one-line recommendation, then a table with the options as rows and the key criteria as columns, then a short note on when you would choose differently.' },
];

function openSkillTemplates() {
  const have = new Set(S.skills.map((k) => k.name.toLowerCase()));
  const { el } = modal({
    title: 'Skill templates',
    body: `<p class="muted small" style="margin:0">Add a template, then edit it however you like. Skills are sent to every model in a chat where they are switched on.</p>` +
      SKILL_TEMPLATES.map((t, i) => `<div class="out-item"><div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(t.name)}</b>
        ${have.has(t.name.toLowerCase()) ? '<span class="badge completed">Added</span>' : `<button class="btn small primary" data-tpl="${i}">Add</button>`}</div>
        <div class="small muted">${esc(t.description)}</div><div class="small">${esc(t.instructions)}</div></div>`).join(''),
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tpl]'); if (!b) return;
    b.disabled = true;
    try { await api('POST', '/api/skills', SKILL_TEMPLATES[Number(b.dataset.tpl)]); await loadSkills(); b.outerHTML = '<span class="badge completed">Added</span>'; toast('Skill added. Switch it on in the sidebar.'); }
    catch (err) { fail(err); b.disabled = false; }
  });
}

function openSkillEditor(skill) {
  const { el, close } = modal({
    title: skill ? 'Edit skill' : 'New skill',
    body: `<label class="small">Name<input class="input" id="sk-name" maxlength="60" value="${esc(skill?.name || '')}" placeholder="e.g. Senior PM reviewer"></label>
      <label class="small">Short description <span class="muted">(optional)</span><input class="input" id="sk-desc" maxlength="200" value="${esc(skill?.description || '')}"></label>
      <label class="small">Instructions every model should follow<textarea class="textarea" id="sk-ins" rows="8" maxlength="8000" placeholder="e.g. Act as a senior product manager. Frame answers around user problems, metrics and trade-offs.">${esc(skill?.instructions || '')}</textarea></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="sk-auto" ${skill?.auto ? 'checked' : ''}> Switch on automatically for new chats</label>
      <div class="err-text" id="sk-err"></div>`,
    foot: `${skill ? '<button class="btn danger" id="sk-del" style="margin-right:auto">Delete</button>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" id="sk-save">Save skill</button>`,
  });
  $('#sk-save', el).onclick = async () => {
    const body = { name: $('#sk-name', el).value, description: $('#sk-desc', el).value, instructions: $('#sk-ins', el).value, auto: $('#sk-auto', el).checked };
    try {
      const saved = await api(skill ? 'PATCH' : 'POST', skill ? `/api/skills/${skill.id}` : '/api/skills', body);
      close(); await loadSkills();
      if (!skill && S.conv) { setConv(await api('PUT', `/api/conversations/${S.conv.conversation.id}/skills/${saved.id}`)); renderSkills(); renderHead(); estimate(); toast('Skill created and switched on for this chat'); }
      else toast('Skill saved');
    } catch (e) { $('#sk-err', el).textContent = e.message; }
  };
  const del = $('#sk-del', el);
  if (del) del.onclick = async () => {
    if (!confirm(`Delete the skill "${skill.name}"? It will be switched off in every chat.`)) return;
    try {
      await api('DELETE', `/api/skills/${skill.id}`); close(); await loadSkills();
      if (S.conv) { setConv(await api('GET', `/api/conversations/${S.conv.conversation.id}`)); renderHead(); renderSkills(); }
      toast('Skill deleted');
    } catch (e) { fail(e); }
  };
}

function renderSidebar() {
  const el = $('#conv-list'); if (!el) return;
  const cur = S.conv?.conversation.id;
  el.innerHTML = S.convs.length ? S.convs.map((c) => `<div class="conv-item ${c.id === cur ? 'active' : ''}" data-id="${c.id}">
      <span class="t" title="${esc(c.title)}">${esc(c.title)}</span>
      <button class="btn small ghost x" data-del="${c.id}" title="Delete conversation">✕</button></div>`).join('')
    : '<div class="muted small" style="padding:8px">No conversations yet.</div>';
  el.onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      if (!confirm('Delete this conversation and all its responses?')) return;
      try { await api('DELETE', `/api/conversations/${del.dataset.del}`); if (S.conv?.conversation.id === del.dataset.del) location.hash = '#/new'; await loadConvs(); } catch (err) { fail(err); }
      return;
    }
    const item = e.target.closest('.conv-item');
    if (item) { location.hash = `#/c/${item.dataset.id}`; closeNav(); }
  };
}

function route() {
  const m = location.hash.match(/^#\/c\/([\w-]+)/);
  if (m) openConversation(m[1]); else renderNew();
}
window.addEventListener('hashchange', () => S.me && route());

// ---------- model picker ----------
const FILTERS = [['best', '★ Free & best'], ['free', 'Free only'], ['fast', 'Fast'], ['reasoning', 'Best reasoning'], ['coding', 'Coding'], ['popular', 'Popular']];
// Free chat models ranked by the server's estimated quality score (size, reasoning, context,
// recency, live health and how often people here pick them).
function bestFree() {
  return S.models.filter((m) => m.free && m.chat && m.health !== 'blocked').sort((a, b) => b.quality - a.quality);
}
function filteredModels(exclude = []) {
  const f = S.filters, q = f.q.trim().toLowerCase();
  const base = f.best ? bestFree() : S.models;
  return base.filter((m) => !exclude.includes(m.id)
    && (!q || `${m.id} ${m.name}`.toLowerCase().includes(q))
    && FILTERS.every(([k]) => k === 'best' || !f[k] || (f.best && k === 'free') || m.tags.includes(k)));
}
function pickBestFree(n, exclude = []) {
  const picked = [], vendors = new Set();
  const pool = bestFree().filter((m) => !exclude.includes(m.id));
  // Prefer healthy models from different vendors, so one busy provider can't take out every lane.
  const vendorOk = (m) => !vendors.has(m.id.split('/')[0]);
  for (const pass of [(m) => m.health === 'ok' && vendorOk(m), (m) => m.health === 'ok', (m) => m.health !== 'busy' && vendorOk(m), (m) => m.health !== 'busy', () => true]) {
    for (const m of pool) {
      if (picked.length >= n) break;
      if (!picked.includes(m.id) && pass(m)) { picked.push(m.id); vendors.add(m.id.split('/')[0]); }
    }
  }
  return picked;
}
function priceLabel(m) {
  if (m.free) return '<span class="tag free">FREE</span>';
  return `$${perM(m.prompt_price)} in · $${perM(m.completion_price)} out<br><span class="small">per 1M tokens</span>`;
}

/** Mounts a picker. opts: { selected: string[], max, exclude, onChange(selected) } */
function mountPicker(el, opts) {
  el.dataset.picker = '1';
  el.innerHTML = `<div class="picker">
    <div class="picker-bar"><input class="input" data-q placeholder="Search models" value="${esc(S.filters.q)}">
      ${FILTERS.map(([k, l]) => `<button class="chip ${S.filters[k] ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="picker-selected" data-sel></div>
    <div class="picker-list" data-list></div></div>`;
  const draw = () => {
    const sel = opts.selected;
    $('[data-q]', el).placeholder = `Search ${S.models.length || ''} models`;
    $('[data-sel]', el).innerHTML = (sel.length ? sel.map((id) => `<span class="sel-chip">${esc(shortName(id))}<button data-unsel="${esc(id)}" title="Remove">×</button></span>`).join('')
      : '<span class="muted small">No models selected</span>') + `<span class="muted small" style="margin-left:auto">${sel.length}/${opts.max} selected</span>`;
    const list = $('[data-list]', el);
    if (S.modelsError) { list.innerHTML = `<div class="err-box">Could not load models: ${esc(S.modelsError)}</div>`; return; }
    if (!S.models.length) { list.innerHTML = '<div class="muted" style="padding:14px">Loading models…</div>'; return; }
    const rows = filteredModels(opts.exclude || []);
    const full = sel.length >= opts.max;
    const rankOf = S.filters.best ? new Map(bestFree().map((m, i) => [m.id, i + 1])) : null;
    list.innerHTML = (S.filters.best ? '<div class="muted small best-note">Free models ranked by an estimated score: size, reasoning support, context window, recency, whether they are answering right now, and how often people here pick them.</div>' : '')
      + (rows.length ? rows.slice(0, 200).map((m) => {
      const on = sel.includes(m.id), dis = !on && full;
      return `<label class="model-row ${dis ? 'disabled' : ''}" data-id="${esc(m.id)}">
        <input type="checkbox" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}>
        <div><div class="model-name">${rankOf?.get(m.id) <= 10 ? `<span class="rank">#${rankOf.get(m.id)}</span> ` : ''}${esc(m.name)}${m.health === 'busy' ? ' <span class="tag busy">busy now</span>' : m.health === 'blocked' ? ' <span class="tag busy">unavailable</span>' : m.health === 'ok' ? ' <span class="tag ok">responding</span>' : ''}</div><div class="model-id">${esc(m.id)}</div>
          <div>${m.tags.filter((t) => t !== 'free').map((t) => `<span class="tag">${t}</span>`).join('')}${m.context_length ? `<span class="tag">${fmtTokens(m.context_length)} context</span>` : ''}</div>
          <div class="model-desc">${esc(m.description)}</div></div>
        <div class="price">${priceLabel(m)}</div></label>`;
    }).join('') + (rows.length > 200 ? `<div class="muted small" style="padding:10px">Showing 200 of ${rows.length}. Search to narrow down.</div>` : '')
      : '<div class="muted" style="padding:14px">No models match these filters.</div>');
  };
  el._redraw = draw;
  el._setSelected = (ids) => { opts.selected = ids.slice(0, opts.max); opts.onChange?.(opts.selected); draw(); };
  $('[data-q]', el).oninput = debounce((e) => { S.filters.q = e.target.value; draw(); }, 120);
  el.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]');
    if (f) {
      const k = f.dataset.f; S.filters[k] = !S.filters[k]; f.classList.toggle('on', S.filters[k]);
      if (k === 'free') api('PATCH', '/api/me', { free_only: S.filters.free }).then((u) => (S.me = u)).catch(() => {});
      if (k === 'best' && S.filters.best) $('[data-list]', el).scrollTop = 0;
      draw(); return;
    }
    const un = e.target.closest('[data-unsel]');
    if (un) { opts.selected = opts.selected.filter((x) => x !== un.dataset.unsel); opts.onChange?.(opts.selected); draw(); return; }
  });
  el.addEventListener('change', (e) => {
    const row = e.target.closest('.model-row'); if (!row) return;
    const id = row.dataset.id;
    if (e.target.checked) { if (opts.selected.length < opts.max) opts.selected = [...opts.selected, id]; }
    else opts.selected = opts.selected.filter((x) => x !== id);
    opts.onChange?.(opts.selected); draw();
  });
  draw();
}

// ---------- new conversation ----------
let newState = { text: '', selected: [], skills: null };
const newSkillIds = () => newState.skills ?? S.skills.filter((k) => k.auto).map((k) => k.id);
function renderNew() {
  S.conv = null; S.resp = new Map(); renderSidebar(); renderSkills();
  $('#main').innerHTML = `${mobileTop('New conversation')}<div class="new-wrap"><div class="new-inner">
    <h1>What would you like help with?</h1>
    <textarea class="textarea" id="new-text" rows="4" placeholder="Describe your task. Every model you pick will answer, and the conversation keeps its context.">${esc(newState.text)}</textarea>
    <div><div class="section-title" style="flex-wrap:wrap">Choose models <span class="muted small" style="flex:1">One model is a normal chat. Two or three gives you a side-by-side comparison on every turn.</span>
        <button class="btn small" id="best-btn" title="Picks the top-ranked free models, from different vendors where possible">★ Pick ${S.maxModels} best free models</button></div>
      <div id="new-picker"></div></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;align-items:center"><span class="err-text" id="new-err"></span>
      <button class="btn primary" id="start-btn">Start conversation</button></div>
  </div></div>`;
  $('#new-text').oninput = (e) => { newState.text = e.target.value; };
  $('#new-text').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#start-btn').click(); };
  mountPicker($('#new-picker'), { selected: newState.selected, max: S.maxModels, onChange: (s) => (newState.selected = s) });
  $('#best-btn').onclick = async () => {
    const btn = $('#best-btn'); const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Checking which free models are answering…';
    try {
      await loadModels();
      // Ask the top candidates a tiny question first, so we never pick a model that is busy or gated.
      const candidates = bestFree().filter((m) => m.health !== 'busy').slice(0, 8).map((m) => m.id);
      if (candidates.length) await api('POST', '/api/models/probe', { ids: candidates });
      await loadModels();
    } catch (e) { fail(e); } finally { btn.disabled = false; btn.textContent = label; }
    const ids = pickBestFree(S.maxModels);
    if (!ids.length) return toast('No free models are available right now');
    $('#new-picker')._setSelected(ids);
    toast(`Picked: ${ids.map(shortName).join(', ')}`);
  };
  $('#start-btn').onclick = async () => {
    const err = $('#new-err');
    if (!newState.selected.length) { err.textContent = 'Pick at least one model.'; return; }
    const btn = $('#start-btn'); btn.disabled = true; err.textContent = '';
    try {
      let payload = await api('POST', '/api/conversations', { models: newState.selected, skill_ids: newSkillIds() });
      const text = newState.text.trim();
      if (text) payload = await api('POST', `/api/conversations/${payload.conversation.id}/messages`, { message: text, target: 'all' });
      newState = { text: '', selected: [], skills: null };
      S.target = 'all';
      setConv(payload);
      history.replaceState(null, '', `#/c/${payload.conversation.id}`);
      renderConv();
      loadConvs();
      startPending();
    } catch (e) { err.textContent = e.message; btn.disabled = false; }
  };
  setTimeout(() => $('#new-text')?.focus(), 0);
}

// ---------- conversation ----------
function setConv(payload) {
  const old = S.resp;
  S.conv = payload; S.resp = new Map();
  for (const t of payload.turns) {
    t.responses = t.responses.map((r) => {
      // Keep live streamed text for responses this tab is currently streaming.
      if (S.running.has(r.id) && old.has(r.id)) { const o = old.get(r.id); Object.assign(r, { content: o.content, reasoning: o.reasoning, status: o.status }); }
      S.resp.set(r.id, r); return r;
    });
  }
  if (S.target !== 'all' && !payload.models.some((m) => m.model_id === S.target && m.status !== 'removed')) S.target = 'all';
}

async function openConversation(id) {
  if (S.conv?.conversation.id === id) { renderConv(); return; }
  try { setConv(await api('GET', `/api/conversations/${id}`)); S.target = 'all'; renderConv(); renderSidebar(); }
  catch (e) { fail(e); location.hash = '#/new'; }
}
const refreshConv = debounce(async () => {
  if (!S.conv) return;
  try { setConv(await api('GET', `/api/conversations/${S.conv.conversation.id}`)); renderHead(); renderComposerMeta(); } catch {}
}, 250);

function renderConv() {
  renderSidebar(); renderSkills();
  $('#main').innerHTML = `${mobileTop(S.conv.conversation.title)}
    <header class="conv-head" id="conv-head"></header>
    <div class="thread" id="thread"></div>
    <div class="composer"><div class="composer-inner">
      <div id="pin-note"></div>
      <div class="composer-row">
        <textarea class="textarea" id="msg" rows="1" placeholder="Ask anything… (Enter to send, Shift+Enter for a new line)"></textarea>
        <button class="btn primary" id="send-btn">Send</button></div>
      <div class="composer-meta"><label>Send to <select class="select" id="target"></select></label><span id="estimate"></span></div>
    </div></div>`;
  renderHead(); renderThread(); renderComposerMeta();
  const msg = $('#msg');
  const draftKey = `draft:${S.conv.conversation.id}`;
  try { msg.value = sessionStorage.getItem(draftKey) || ''; } catch {}
  msg.oninput = () => {
    msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, 240) + 'px'; estimate();
    try { sessionStorage.setItem(draftKey, msg.value); } catch {}
  };
  msg.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } };
  $('#send-btn').onclick = sendMessage;
  $('#target').onchange = (e) => { S.target = e.target.value; estimate(); };
  $('#thread').addEventListener('click', onThreadClick);
  const th = $('#thread'); th.scrollTop = th.scrollHeight;
}

function renderHead() {
  const el = $('#conv-head'); if (!el || !S.conv) return;
  const { conversation: c, models, stats, selections } = S.conv;
  const active = models.filter((m) => m.status === 'active').length;
  const canonical = selections.filter((s) => s.selection_type === 'canonical');
  el.innerHTML = `
    <div class="conv-title-row"><input class="conv-title" id="title" value="${esc(c.title)}" aria-label="Conversation title">
      <button class="btn small" id="finish-btn">Finish</button></div>
    <div class="lanes-bar">${models.map((m) => `<span class="lane-chip ${m.status}" title="${esc(m.model_id)}">
        <span class="dot" style="background:var(--lane-${m.position % 6})"></span>${esc(shortName(m.model_id))}${S.modelMap.get(m.model_id)?.free ? ' <span class="tag free">FREE</span>' : ''}
        ${m.status === 'paused' ? '<span class="muted small">paused</span>' : ''}
        <button class="btn small ghost" data-lane="${m.status === 'paused' ? 'resume' : 'pause'}" data-model="${esc(m.model_id)}" title="${m.status === 'paused' ? 'Resume' : 'Pause'}">${m.status === 'paused' ? '▶' : '⏸'}</button>
        <button class="btn small ghost" data-lane="remove" data-model="${esc(m.model_id)}" title="Remove from conversation">✕</button></span>`).join('')}
      <button class="btn small" id="add-model" ${active >= S.conv.max_models ? `disabled title="Max ${S.conv.max_models} active models"` : ''}>+ Add model</button></div>
    ${S.conv.skill_ids?.length ? `<div class="skills-on small">Skills on: ${S.conv.skill_ids.map((id) => S.skills.find((k) => k.id === id)).filter(Boolean).map((k) => `<span class="tag">${esc(k.name)}</span>`).join('')}</div>` : ''}
    <div class="stats"><span>Conversation cost <b>${fmtCost(stats.cost)}</b></span><span>Model calls <b>${stats.calls}</b></span>
      <span>Messages <b>${stats.messages}</b></span><span>Tokens <b>${fmtTokens(stats.tokens)}</b></span></div>
    ${canonical.length ? `<details class="context-panel" ${S.ctxOpen ? 'open' : ''} ontoggle="window.__ctxOpen=this.open"><summary>Shared context: ${canonical.length} selected decision${canonical.length > 1 ? 's' : ''} sent to every model</summary>
      ${canonical.map((s) => `<div class="ctx-item"><span class="dot" style="background:${laneColor(s.model_id)};width:9px;height:9px;border-radius:50%;margin-top:6px"></span>
        <div class="body"><b>${esc(shortName(s.model_id))}</b><div class="snip">${esc(s.selected_text.slice(0, 400))}</div></div>
        <button class="btn small ghost" data-unselect="${s.id}" title="Stop sending this to models">✕</button></div>`).join('')}</details>` : ''}`;
  $('#title').onchange = async (e) => { try { setConv(await api('PATCH', `/api/conversations/${c.id}`, { title: e.target.value })); loadConvs(); } catch (err) { fail(err); } };
  $('#finish-btn').onclick = openFinish;
  $('#add-model').onclick = openAddModel;
  el.onclick = async (e) => {
    const lane = e.target.closest('[data-lane]');
    const un = e.target.closest('[data-unselect]');
    try {
      if (lane) {
        const mid = encodeURIComponent(lane.dataset.model), act = lane.dataset.lane;
        if (act === 'remove') {
          if (!confirm(`Remove ${shortName(lane.dataset.model)}? Its earlier answers stay visible.`)) return;
          setConv(await api('DELETE', `/api/conversations/${c.id}/models/${mid}`));
        } else setConv(await api('PATCH', `/api/conversations/${c.id}/models/${mid}`, { status: act === 'pause' ? 'paused' : 'active' }));
        renderHead(); renderComposerMeta();
      } else if (un) { setConv(await api('DELETE', `/api/selections/${un.dataset.unselect}`)); renderHead(); estimate(); }
    } catch (err) { fail(err); }
  };
}

function renderComposerMeta() {
  if (!S.conv || !$('#target')) return;
  const models = S.conv.models.filter((m) => m.status !== 'removed');
  const active = models.filter((m) => m.status === 'active');
  $('#target').innerHTML = `<option value="all">All active models (${active.length})</option>` +
    models.map((m) => `<option value="${esc(m.model_id)}">Only ${esc(shortName(m.model_id))}${m.status === 'paused' ? ' (paused)' : ''}</option>`).join('');
  $('#target').value = S.target;
  const pin = S.conv.selections.find((s) => s.selection_type === 'continue');
  $('#pin-note').innerHTML = pin ? `<div class="pin-note">↳ Your next message continues from <b>${esc(shortName(pin.model_id))}</b>'s answer. <button class="btn small ghost" data-unpin="${pin.id}">Cancel</button></div>` : '';
  const up = $('[data-unpin]'); if (up) up.onclick = async () => { try { setConv(await api('DELETE', `/api/selections/${up.dataset.unpin}`)); renderComposerMeta(); } catch (e) { fail(e); } };
  estimate();
}

const estimate = debounce(async () => {
  const el = $('#estimate'); if (!el || !S.conv) return;
  try {
    const est = await api('POST', `/api/conversations/${S.conv.conversation.id}/estimate`, { message: $('#msg')?.value || '', target: S.target });
    const n = est.models.length;
    const allFree = est.models.every((m) => m.free);
    const dropped = Math.max(0, ...est.models.map((m) => m.dropped_turns));
    el.innerHTML = `${n} model${n > 1 ? 's' : ''} · ${allFree ? 'Estimated cost: <b>Free</b>' : `Estimated cost: <b>${fmtCost(est.cost_min)} to ${fmtCost(est.cost_max)}</b>`}`
      + ` · ~${fmtTokens(Math.max(...est.models.map((m) => m.prompt_tokens)))} prompt tokens`
      + (dropped ? ` · <span title="Older turns are condensed to fit the smallest context window">${dropped} older turn${dropped > 1 ? 's' : ''} condensed</span>` : '');
  } catch (e) { el.textContent = e.message; }
}, 400);

function renderThread() {
  const th = $('#thread'); if (!th || !S.conv) return;
  const turns = S.conv.turns;
  if (!turns.length) { th.innerHTML = `<div class="empty-thread"><h2>Ask your first question</h2><p>Every active model answers separately. Use the best answer as shared context, and the other models will build on it.</p></div>`; return; }
  th.innerHTML = turns.map(turnHTML).join('');
}

function turnHTML(t) {
  const rs = t.responses;
  const active = S.tabs[t.id] && rs.some((r) => r.id === S.tabs[t.id]) ? S.tabs[t.id] : rs[0]?.id;
  return `<section class="turn" id="turn-${t.id}">
    <div class="user-msg">${esc(t.user_message)}</div>
    ${t.mode === 'single' ? `<div class="turn-meta">Asked only ${esc(shortName(t.target_models[0]))}</div>` : ''}
    <div class="lane-tabs">${rs.map((r) => `<button class="${r.id === active ? 'on' : ''}" style="--lane:${laneColor(r.model_id)}" data-act="tab" data-turn="${t.id}" data-id="${r.id}">
      <span class="dot" style="background:${laneColor(r.model_id)};width:8px;height:8px;border-radius:50%"></span>${esc(shortName(r.model_id))}${r.status === 'completed' ? ' ✓' : r.status === 'generating' ? ' …' : ['failed', 'rate_limited'].includes(r.status) ? ' ⚠' : ''}</button>`).join('')}</div>
    <div class="lanes" style="--n:${Math.max(1, rs.length)}">${rs.map((r) => cardHTML(r, r.id === active)).join('')}</div>
  </section>`;
}

function cardHTML(r, tabActive) {
  const live = r.status === 'generating';
  const has = !!r.content.trim();
  const long = r.content.length > 2500 && !S.expanded.has(r.id) && !live;
  const isErr = r.status === 'failed' && r.error_kind !== 'rate_limit';
  const errText = r.error ? errorHTML(r) : '';
  const meta = [];
  if (r.latency_ms) meta.push(`${(r.latency_ms / 1000).toFixed(1)}s`);
  if (r.first_token_ms) meta.push(`first token ${(r.first_token_ms / 1000).toFixed(1)}s`);
  if (r.prompt_tokens != null) meta.push(`${fmtTokens(r.prompt_tokens)} in · ${fmtTokens(r.completion_tokens)} out`);
  if (r.cost != null) meta.push(fmtCost(r.cost));
  if (r.provider) meta.push(`via ${esc(r.provider)}`);
  if (r.attempts > 1) meta.push(`attempt ${r.attempts}`);
  const body = has ? md(r.content) : live ? (r.retrying ? retryingHTML(r) : `<span class="muted">${r.reasoning ? 'Thinking…' : 'Waiting for the first token…'}</span>`)
    : r.status === 'pending' ? '<span class="muted">Not started yet.</span>' : '';
  return `<article class="card ${r.final ? 'is-final' : ''} ${tabActive ? 'tab-active' : ''}" id="card-${r.id}" data-id="${r.id}" style="--lane:${laneColor(r.model_id)}">
    <div class="card-head"><span class="dot" style="background:${laneColor(r.model_id)}"></span>
      <span class="name" title="${esc(r.model_id)}">${esc(shortName(r.model_id))}</span>
      ${r.final ? '<span class="badge final">Final</span>' : ''}${r.saved ? '<span class="badge">Saved</span>' : ''}
      <span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span></div>
    ${r.reasoning ? `<details class="thinking" ${live && !has ? 'open' : ''}><summary>Reasoning (${fmtTokens(Math.ceil(r.reasoning.length / 4))} tokens)</summary><pre>${esc(r.reasoning.slice(-20000))}</pre></details>` : ''}
    ${body ? `<div class="card-body md ${live ? 'cursor' : ''} ${long ? 'collapsed' : ''}">${body}</div>` : ''}
    ${long ? `<button class="btn small ghost expand" data-act="expand" data-id="${r.id}">Show full answer</button>` : ''}
    ${errText ? `<div class="err-box ${isErr ? '' : 'warn'}">${errText}</div>` : ''}
    ${meta.length ? `<div class="card-meta">${meta.join('<span>·</span>')}</div>` : ''}
    <div class="card-actions">
      ${live ? `<button class="btn small" data-act="stop" data-id="${r.id}">■ Stop</button>` : ''}
      ${!live && r.status !== 'completed' ? `<button class="btn small" data-act="run" data-id="${r.id}">${r.status === 'pending' ? 'Run' : '↻ Retry'}</button>` : ''}
      ${has && !live ? `
        <button class="btn small" data-act="use" data-id="${r.id}" title="Send this answer (or the part you highlighted) to every model on future turns">Use as context</button>
        <button class="btn small" data-act="continue" data-id="${r.id}" title="Your next message builds on this answer, for all models">Continue with this</button>
        <button class="btn small ghost" data-act="ask" data-id="${r.id}" title="Send the next message only to this model">Ask this model</button>
        <button class="btn small ghost" data-act="copy" data-id="${r.id}">Copy</button>
        <button class="btn small ghost ${r.saved ? 'on' : ''}" data-act="save" data-id="${r.id}">${r.saved ? 'Saved' : 'Save'}</button>
        <button class="btn small ghost ${r.final ? 'on' : ''}" data-act="final" data-id="${r.id}">${r.final ? 'Final ✓' : 'Use as final'}</button>` : ''}
      ${r.attempts ? `<button class="btn small ghost" data-act="context" data-id="${r.id}" title="See exactly what was sent to this model">Context sent</button>` : ''}
    </div></article>`;
}


const SWAPPABLE = new Set(['rate_limit', 'forbidden', 'invalid_model', 'insufficient_credits', 'provider_unavailable', 'timeout', 'empty']);
function retryingHTML(r) {
  const secs = Math.max(0, Math.ceil((r.retrying.until - Date.now()) / 1000));
  return `<div class="retrying"><b>${esc(shortName(r.model_id))} is busy upstream.</b>
    <span class="muted">${secs ? `Retrying in ${secs}s` : 'Retrying now'} · attempt ${r.retrying.attempt + 1} of ${r.retrying.of + 1}</span>
    <div class="retry-bar"><i style="width:${Math.max(0, Math.min(100, ((r.retrying.until - Date.now()) / r.retrying.total) * 100))}%"></i></div></div>`;
}
function errorHTML(r) {
  const name = esc(shortName(r.model_id));
  const [summary, raw] = r.error.includes(' Raw: ') ? r.error.split(' Raw: ') : [null, r.error];
  const title = { rate_limit: `${name} is busy right now`, insufficient_credits: 'No OpenRouter credits for this model', forbidden: `${name} isn't available to this app`,
    invalid_model: `${name} is unavailable`, context_limit: 'Conversation too long for this model', timeout: `${name} stopped responding`,
    provider_unavailable: `${name}'s provider is down`, empty: 'Empty answer', truncated: 'Answer cut off', safety: 'Blocked by a safety filter' }[r.error_kind] || 'Something went wrong';
  const hint = ERROR_HINT[r.error_kind] || '';
  let alts = '';
  const laneStatus = S.conv?.models.find((m) => m.model_id === r.model_id)?.status;
  if (laneStatus && laneStatus !== 'active') {
    alts = `<div class="small muted">This lane is ${laneStatus} now${laneStatus === 'paused' ? '. Resume it from the model chips above.' : '.'}</div>`;
  } else if (SWAPPABLE.has(r.error_kind) && ['failed', 'rate_limited'].includes(r.status)) {
    const a = S.alts.get(r.id);
    if (a === undefined) loadAlternatives(r.id);
    alts = `<div class="alts">${Array.isArray(a) && a.length ? `<span class="small">Swap this lane to:</span>${a.map((m) =>
        `<button class="btn small" data-act="swap" data-id="${r.id}" data-model="${esc(m.id)}" title="${esc(m.id)}">${esc(shortName(m.id))}${m.health === 'ok' ? ' <span class="tag ok">responding</span>' : ''}</button>`).join('')}` : ''}
      <button class="btn small ghost" data-act="swap-pick" data-id="${r.id}">Pick another model…</button></div>`;
  }
  return `<div class="err-title">⚠ ${title}</div>
    ${summary ? `<div class="small">${esc(summary)}</div>` : ''}
    ${hint && !(r.error_kind === 'empty' || r.error_kind === 'truncated') ? `<div class="small">${hint}</div>` : (!summary ? `<div class="small">${esc(raw)}</div>` : '')}
    ${alts}
    ${raw && (summary || hint) ? `<details class="tech"><summary>Technical details</summary><div>${esc(raw)}</div></details>` : ''}`;
}
async function loadAlternatives(id) {
  S.alts.set(id, 'loading');
  try { S.alts.set(id, (await api('GET', `/api/responses/${id}/alternatives`)).alternatives); }
  catch { S.alts.set(id, []); }
  renderCard(id);
}
async function swapModel(id, modelId) {
  const payload = await api('POST', `/api/responses/${id}/replace`, { model_id: modelId });
  setConv(payload); renderHead(); renderThread(); renderComposerMeta();
  toast(`${shortName(S.resp.get(id).model_id)} paused. ${shortName(modelId)} is answering this turn and future ones.`);
  runResponse(payload.new_response_id);
}
// Tick countdowns on cards that are waiting to retry.
setInterval(() => { for (const [id, r] of S.resp) if (r.retrying && r.status === 'generating') renderCard(id); }, 1000);

const pendingCardRender = new Set();
let renderTimer = null;
function renderCard(id) {
  pendingCardRender.add(id);
  if (renderTimer) return;
  // setTimeout, not requestAnimationFrame: rAF pauses in background tabs and would freeze streaming cards.
  renderTimer = setTimeout(() => {
    renderTimer = null;
    const th = $('#thread');
    const nearBottom = th && th.scrollHeight - th.scrollTop - th.clientHeight < 120;
    for (const rid of pendingCardRender) {
      const r = S.resp.get(rid), el = document.getElementById(`card-${rid}`);
      if (!r || !el) continue;
      const openThinking = el.querySelector('.thinking')?.open;
      el.outerHTML = cardHTML(r, el.classList.contains('tab-active'));
      const th2 = document.querySelector(`#card-${rid} .thinking`); if (th2 && openThinking !== undefined && r.content.trim()) th2.open = openThinking;
      const turn = S.conv.turns.find((t) => t.id === r.turn_id);
      const tabs = turn && document.querySelector(`#turn-${turn.id} .lane-tabs`);
      if (tabs) { const tmp = document.createElement('div'); tmp.innerHTML = turnHTML(turn); tabs.replaceWith(tmp.querySelector('.lane-tabs')); }
    }
    pendingCardRender.clear();
    if (nearBottom && th) th.scrollTop = th.scrollHeight;
  }, 50);
}

async function sendMessage() {
  const msg = $('#msg'); const text = msg.value.trim();
  if (!text || !S.conv) return;
  const btn = $('#send-btn'); btn.disabled = true;
  try {
    const payload = await api('POST', `/api/conversations/${S.conv.conversation.id}/messages`, { message: text, target: S.target });
    msg.value = ''; msg.style.height = 'auto';
    try { sessionStorage.removeItem(`draft:${S.conv.conversation.id}`); } catch {}
    setConv(payload); renderHead(); renderThread(); renderComposerMeta(); loadConvs();
    const th = $('#thread'); th.scrollTop = th.scrollHeight;
    startPending();
  } catch (e) { fail(e); } finally { btn.disabled = false; msg.focus(); }
}

function startPending() {
  const last = S.conv?.turns.at(-1); if (!last) return;
  for (const r of last.responses) if (r.status === 'pending') runResponse(r.id);
}

// Each model streams on its own request, so one slow or failed model never blocks the others.
async function runResponse(id) {
  if (S.running.has(id)) return;
  S.running.set(id, true);
  const r = S.resp.get(id);
  Object.assign(r, { status: 'generating', content: '', reasoning: '', error: null, error_kind: null, retrying: null });
  S.alts.delete(id);
  renderCard(id);
  try {
    const res = await fetch(`/api/responses/${id}/run`, { method: 'POST' });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        const cur = S.resp.get(id); if (!cur) continue;
        if (ev.type === 'delta') cur.content += ev.content;
        else if (ev.type === 'reasoning') cur.reasoning += ev.content;
        else if (ev.type === 'start' || ev.type === 'final') { Object.assign(cur, ev.response); cur.retrying = null; }
        else if (ev.type === 'retrying') cur.retrying = { attempt: ev.attempt, of: ev.of, until: Date.now() + ev.wait_ms, total: ev.wait_ms };
        renderCard(id);
      }
    }
  } catch (e) {
    const cur = S.resp.get(id);
    if (cur) Object.assign(cur, { status: 'failed', error: e.message, error_kind: 'network' });
    renderCard(id);
  } finally {
    S.running.delete(id);
    refreshConv();
  }
}

async function onThreadClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id, r = S.resp.get(id), act = b.dataset.act;
  try {
    switch (act) {
      case 'tab': {
        S.tabs[b.dataset.turn] = id;
        const sec = document.getElementById(`turn-${b.dataset.turn}`);
        sec.querySelectorAll('.lane-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.id === id));
        sec.querySelectorAll('.card').forEach((x) => x.classList.toggle('tab-active', x.dataset.id === id));
        break;
      }
      case 'expand': S.expanded.add(id); renderCard(id); break;
      case 'stop': await api('POST', `/api/responses/${id}/stop`); break;
      case 'run': runResponse(id); break;
      case 'use': {
        const part = S.lastSel?.id === id && S.lastSel.text.trim().length > 20 ? S.lastSel.text.trim() : '';
        setConv(await api('POST', `/api/responses/${id}/use`, { selected_text: part }));
        S.lastSel = null; renderHead(); estimate();
        toast(part ? 'Highlighted part added to shared context' : `${shortName(r.model_id)}'s answer added to shared context`);
        break;
      }
      case 'continue':
        setConv(await api('POST', `/api/responses/${id}/continue`));
        S.target = 'all'; renderComposerMeta(); $('#msg').focus();
        toast('Your next message will build on this answer');
        break;
      case 'ask':
        S.target = r.model_id; renderComposerMeta(); $('#msg').focus();
        toast(`Next message goes only to ${shortName(r.model_id)}`);
        break;
      case 'copy': await navigator.clipboard.writeText(r.content); toast('Copied'); break;
      case 'save': case 'final': {
        const row = await api('POST', `/api/responses/${id}/${act}`);
        Object.assign(r, row); renderCard(id);
        if (act === 'final' && row.final) toast('Marked as final. See all picks under Finish.');
        break;
      }
      case 'context': await openContextView(id); break;
      case 'swap': b.disabled = true; await swapModel(id, b.dataset.model); break;
      case 'swap-pick': openSwapPicker(id); break;
    }
  } catch (err) { fail(err); }
}

// ---------- modals ----------
function modal({ title, body, foot = '', wide = false }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" style="${wide ? 'max-width:980px' : ''}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="btn small ghost" data-close>✕</button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div></div>`;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.querySelector('.modal-back').addEventListener('click', (e) => { if (e.target.classList.contains('modal-back') || e.target.closest('[data-close]')) close(); });
  return { el: root.querySelector('.modal'), close };
}

async function openSwapPicker(id) {
  await loadModels();
  const r = S.resp.get(id);
  const existing = S.conv.models.filter((m) => m.status !== 'removed').map((m) => m.model_id);
  let picked = [];
  const { el, close } = modal({
    title: `Replace ${shortName(r.model_id)}`,
    body: `<p class="muted small" style="margin:0">${esc(shortName(r.model_id))} will be paused, not removed, so you can resume it later. The new model answers this turn and the next ones.</p><div id="swap-picker"></div>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="swap-confirm">Swap and answer</button>`,
  });
  mountPicker($('#swap-picker', el), { selected: picked, max: 1, exclude: existing, onChange: (s) => (picked = s) });
  $('#swap-confirm', el).onclick = async () => {
    if (!picked.length) return toast('Pick a model');
    try { close(); await swapModel(id, picked[0]); } catch (e) { fail(e); }
  };
}

async function openAddModel() {
  await loadModels();
  const existing = S.conv.models.filter((m) => m.status !== 'removed').map((m) => m.model_id);
  let picked = [];
  const { el, close } = modal({
    title: 'Add a model',
    body: `<p class="muted small" style="margin:0">The new model gets your messages and every decision you selected as shared context. It does not see the other models' private answers.</p><div id="add-picker"></div>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="add-confirm">Add to conversation</button>`,
  });
  mountPicker($('#add-picker', el), { selected: picked, max: 1, exclude: existing, onChange: (s) => (picked = s) });
  $('#add-confirm', el).onclick = async () => {
    if (!picked.length) return toast('Pick a model');
    try { setConv(await api('POST', `/api/conversations/${S.conv.conversation.id}/models`, { model_id: picked[0] })); close(); renderHead(); renderComposerMeta(); toast(`${shortName(picked[0])} joined. It answers from the next message.`); }
    catch (e) { fail(e); }
  };
}

async function openContextView(id) {
  const { messages } = await api('GET', `/api/responses/${id}/context`);
  const r = S.resp.get(id);
  modal({
    title: `Context sent to ${shortName(r.model_id)}`, wide: true,
    body: `<p class="muted small" style="margin:0">This is the exact message list sent for this answer: shared user messages, this model's own earlier answers, and the decisions you selected.</p>` +
      (messages || []).map((m) => `<div class="ctx-msg"><div class="role">${esc(m.role)}</div><pre>${esc(m.content)}</pre></div>`).join(''),
  });
}

function openFinish() {
  const picks = S.conv.turns.flatMap((t) => t.responses.filter((r) => r.saved || r.final).map((r) => ({ r, t })));
  const { el, close } = modal({
    title: 'Your selected outputs', wide: true,
    body: picks.length ? picks.map(({ r, t }) => `<div class="out-item">
        <div style="display:flex;gap:8px;align-items:center"><span class="dot" style="background:${laneColor(r.model_id)};width:9px;height:9px;border-radius:50%"></span>
          <b style="flex:1">${esc(shortName(r.model_id))}</b>${r.final ? '<span class="badge final">Final</span>' : ''}${r.saved ? '<span class="badge">Saved</span>' : ''}</div>
        <div class="q">In reply to: ${esc(t.user_message.slice(0, 160))}</div>
        <details><summary class="small">Show answer</summary><div class="card-body md">${md(r.content)}</div></details>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn small" data-copy="${r.id}">Copy</button>
          <button class="btn small" data-dl="${r.id}">Download .md</button>
          <button class="btn small ${r.final ? 'on' : ''}" data-fin="${r.id}">${r.final ? 'Final ✓' : 'Use as final'}</button></div></div>`).join('')
      : '<p class="muted">Nothing selected yet. Use <b>Save</b> or <b>Use as final</b> on any answer card, from any model and any turn.</p>',
    foot: `<span class="muted small" style="margin-right:auto">Combining and AI evaluation of picks are planned for V1.5.</span><button class="btn primary" data-close>Continue conversation</button>`,
  });
  el.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]'), d = e.target.closest('[data-dl]'), f = e.target.closest('[data-fin]');
    try {
      if (c) { await navigator.clipboard.writeText(S.resp.get(c.dataset.copy).content); toast('Copied'); }
      if (d) {
        const r = S.resp.get(d.dataset.dl);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([r.content], { type: 'text/markdown' }));
        a.download = `${S.conv.conversation.title.replace(/[^\w-]+/g, '-').slice(0, 40)}-${r.model_id.split('/').pop()}.md`;
        a.click(); URL.revokeObjectURL(a.href);
      }
      if (f) { const row = await api('POST', `/api/responses/${f.dataset.fin}/final`); Object.assign(S.resp.get(row.id), row); renderCard(row.id); close(); openFinish(); }
    } catch (err) { fail(err); }
  });
}

function openSettings() {
  const p = S.me.preferences;
  const { el, close } = modal({
    title: 'Settings',
    body: `<label class="small">Max output tokens per answer<input class="input" id="set-max" type="number" min="256" max="32000" step="256" value="${p.max_output_tokens}"></label>
      <p class="muted small" style="margin:-6px 0 0">Reasoning models spend part of this on thinking. Raise it if answers come back empty.</p>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="set-free" ${p.free_only ? 'checked' : ''}> Show free models only by default</label>
      <hr style="border:0;border-top:1px solid var(--border);width:100%">
      <div><b>Delete account</b><p class="muted small">Permanently deletes your account, conversations, responses, and preference history.</p>
      <button class="btn danger" id="del-acct">Delete my account</button></div>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="set-save">Save</button>`,
  });
  $('#set-save', el).onclick = async () => {
    try { S.me = await api('PATCH', '/api/me', { max_output_tokens: Number($('#set-max', el).value), free_only: $('#set-free', el).checked }); S.filters.free = S.me.preferences.free_only; close(); toast('Settings saved'); if (S.conv) estimate(); }
    catch (e) { fail(e); }
  };
  $('#del-acct', el).onclick = async () => {
    if (prompt('Type DELETE to permanently delete your account and all data') !== 'DELETE') return;
    try { await api('DELETE', '/api/me'); close(); S.me = null; S.conv = null; renderAuth('signup'); } catch (e) { fail(e); }
  };
}

// ---------- boot ----------
(async () => {
  try { S.me = await api('GET', '/api/me'); await startApp(); }
  catch { if (!S.me) renderAuth('login'); }
})();
