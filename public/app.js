// Multi-Model Workspace frontend. Vanilla JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');

// Recent client-side errors, attached to feedback so bug reports carry evidence.
const recentErrors = [];
window.addEventListener('error', (e) => { recentErrors.push({ at: Date.now(), msg: String(e.message).slice(0, 300), src: `${e.filename || ''}:${e.lineno || ''}` }); recentErrors.splice(0, recentErrors.length - 10); });
window.addEventListener('unhandledrejection', (e) => { recentErrors.push({ at: Date.now(), msg: String(e.reason?.message || e.reason).slice(0, 300) }); recentErrors.splice(0, recentErrors.length - 10); });

const S = {
  get ctxOpen() { return !!window.__ctxOpen; },
  me: null,
  models: [], modelMap: new Map(), maxModels: 3, modelsError: null,
  convs: [],
  skills: [],
  conv: null, resp: new Map(),
  live: new Set(),               // response ids currently generating (from the stream)
  tabs: {},                      // turn id -> response id shown on mobile
  expanded: new Set(),
  target: 'all',                 // 'all' or an array of model ids (any subset)
  reply: null,                   // { id, model_id, quote } when replying to one answer
  filters: { q: '', free: true, fast: false, reasoning: false, coding: false, popular: false },
  lastSel: null,
  alts: new Map(),
  pending: [],                   // files attached to the message being written               // response id -> alternatives array | 'loading'                 // { id, text } highlighted inside a card
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
  no_key: 'There is no OpenRouter key to run this model. Add your own key in Settings.',
  invalid_key: 'OpenRouter rejected your key. Update it in Settings.',
};

// ---------- utils ----------
async function api(method, url, body) {
  // Errors keep any extra fields the server sent (for example suggested links).
  let r;
  try { r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error(`Can't reach the app server at ${location.host}. It may be restarting or stopped. Wait a few seconds and try again, or start it with "npm start".`); }
  const data = await r.json().catch(() => null);
  if (r.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/signup')) {
    const wasSignedIn = !!S.me;
    S.me = null; S.conv = null;
    renderAuth('login', wasSignedIn ? 'Your session ended. Sign in again and you will be back in this conversation, with any unsent message kept.' : '');
    throw new Error('Please sign in');
  }
  if (!r.ok) {
    if (r.status >= 500) { recentErrors.push({ at: Date.now(), msg: `${method} ${url} -> ${r.status} ${data?.error || ''}`.slice(0, 300) }); recentErrors.splice(0, recentErrors.length - 10); }
    throw Object.assign(new Error(data?.error || `${r.status} ${r.statusText}`), { data });
  }
  return data;
}
let toastTimer;
function toast(msg, ms = 2400) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms); }
const fail = (e) => toast(e.message || String(e));
function md(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text || '', { breaks: false, gfm: true }));
  return `<div style="white-space:pre-wrap">${esc(text)}</div>`;
}
function fmtCost(c) { if (c === null || c === undefined) return '—'; if (c === 0) return 'Free'; return c < 0.01 ? `$${c.toFixed(5)}` : `$${c.toFixed(3)}`; }
function fmtTokens(n) { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n || 0); }
function perM(p) { return p === 0 ? '0' : (p * 1e6).toFixed(p * 1e6 < 1 ? 2 : 2).replace(/\.00$/, ''); }
function shortName(id) {
  const m = S.modelMap.get(id);
  if (m) return m.name.replace(/^[^:]+:\s*/, '');
  return String(id || '').split('/').pop().replace(/:free$/, ' (free)'); // catalog not loaded yet: never cut at the ":free" colon
}
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
        <div class="nav-row"><button class="btn" id="compare-btn">⚖ Compare</button><button class="btn" id="metrics-btn">📊 Metrics</button></div>
        <button class="btn" id="watches-btn">🔔 Agents <span class="count-badge" id="w-badge" hidden>0</span></button>
      </div>
      <div class="search-wrap"><input class="input" id="conv-search" placeholder="Search chats  (/)" aria-label="Search chats"></div>
      <nav class="conv-list" id="conv-list"></nav>
      <section class="skills" id="skills"></section>
      <div class="sidebar-foot"><span class="who" title="${esc(S.me.email)}"><span class="avatar">${esc((S.me.name || '?').slice(0, 1).toUpperCase())}</span>${esc(S.me.name)}</span>
        <button class="btn small ghost" id="feedback-btn" title="Report a bug, suggest an idea, or ask a question" aria-label="Send feedback">💬</button>
        <button class="btn small ghost" id="settings-btn">Settings</button>
        <button class="btn small ghost" id="logout-btn">Sign out</button></div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  $('#new-btn').onclick = () => { location.hash = '#/new'; closeNav(); };
  $('#compare-btn').onclick = () => { location.hash = '#/compare'; closeNav(); };
  $('#metrics-btn').onclick = () => { location.hash = '#/metrics'; closeNav(); };
  $('#watches-btn').onclick = () => { location.hash = '#/agents'; closeNav(); };
  pollNotifications();
  $('#logout-btn').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); S.me = null; renderAuth('login'); };
  $('#settings-btn').onclick = openSettings;
  $('#feedback-btn').onclick = () => openFeedback();
  $('#conv-search').oninput = searchConvs;
  wireAttachments($('#main'));
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
  if (S.conv) { renderHead(); renderThread(); renderComposerMeta(); }
}

let convSeq = 0;
async function loadConvs() {
  const q = $('#conv-search')?.value.trim();
  const seq = ++convSeq;
  const list = await api('GET', `/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  if (seq !== convSeq) return; // a newer search or refresh already replaced this one
  S.convs = list; S.searchQ = q || '';
  renderSidebar();
}
const searchConvs = debounce(() => loadConvs().catch(() => {}), 250);
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

function snippet(text, q) {
  const t = String(text).replace(/\s+/g, ' '); const i = t.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? t.slice(0, 80) : (i > 30 ? '…' : '') + t.slice(Math.max(0, i - 30), i + q.length + 40);
}
function highlight(text, q) {
  const e = esc(text), qe = esc(q);
  return qe ? e.replace(new RegExp(qe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`) : e;
}

function renderSidebar() {
  const el = $('#conv-list'); if (!el) return;
  const cur = S.conv?.conversation.id;
  el.innerHTML = S.convs.length ? S.convs.map((c) => `<div class="conv-item ${c.id === cur ? 'active' : ''}" data-id="${c.id}">
      <span class="t" title="${esc(c.title)}">${esc(c.title)}${S.searchQ && (c.hit_message || c.hit_answer) ? `<span class="hit">${highlight(snippet(c.hit_message || c.hit_answer, S.searchQ), S.searchQ)}</span>` : ''}</span>
      <button class="btn small ghost x" data-del="${c.id}" title="Delete conversation">✕</button></div>`).join('')
    : `<div class="muted small" style="padding:8px">${S.searchQ ? 'No chats match.' : 'No conversations yet.'}</div>`;
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
  if (m) openConversation(m[1]);
  else if (location.hash.startsWith('#/compare')) renderCompare();
  else if (location.hash.startsWith('#/metrics')) renderMetrics();
  else if (location.hash.startsWith('#/watches')) { S.agentTab = 'prices'; location.replace('#/agents'); }
  else if (location.hash.startsWith('#/agents')) renderAgents();
  else renderNew();
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
  closeStream();
  S.conv = null; S.resp = new Map(); S.live = new Set(); renderSidebar(); renderSkills();
  // Start from the models used last time, if they still exist.
  if (!newState.selected.length && S.me.preferences.last_models?.length) newState.selected = S.me.preferences.last_models.filter((id) => !S.models.length || S.modelMap.has(id)).slice(0, S.maxModels);
  $('#main').innerHTML = `${mobileTop('New conversation')}<div class="new-wrap"><div class="new-inner">
    <h1>What would you like help with?</h1>
    <div class="new-box"><textarea class="textarea" id="new-text" rows="4" placeholder="Describe your task, or drop files here. Every model you pick will answer, and the conversation keeps its context.">${esc(newState.text)}</textarea>
      <div class="attach-tray" hidden></div>
      <div class="new-box-bar"><button class="btn small" id="attach-btn" title="Attach images, PDFs or text files">📎 Attach files</button>
        <span class="muted small">Images, PDFs, text and code. Drag and drop or paste works too.</span>
        <input type="file" id="file-input" multiple hidden accept="${ACCEPT}"></div></div>
    <div><div class="section-title" style="flex-wrap:wrap">Choose models <span class="muted small" style="flex:1">One model is a normal chat. Two or three gives you a side-by-side comparison on every turn.</span>
        <button class="btn small" id="best-btn" title="Picks the top-ranked free models, from different vendors where possible">★ Pick ${S.maxModels} best free models</button></div>
      <div id="new-picker"></div></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;align-items:center"><span class="err-text" id="new-err"></span>
      <button class="btn primary" id="start-btn">Start conversation</button></div>
  </div></div>`;
  $('#new-text').oninput = (e) => { newState.text = e.target.value; };
  $('#attach-btn').onclick = () => $('#file-input').click();
  bindFileInput($('#file-input'));
  renderTrays();
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
      if (uploadsBusy()) { err.textContent = 'Wait for the uploads to finish.'; btn.disabled = false; return; }
      if (text || pendingIds().length) { payload = await api('POST', `/api/conversations/${payload.conversation.id}/messages`, { message: text, target: 'all', attachment_ids: pendingIds() }); clearPending(); }
      newState = { text: '', selected: [], skills: null };
      S.target = 'all'; S.reply = null;
      setConv(payload);
      history.replaceState(null, '', `#/c/${payload.conversation.id}`);
      renderConv();
      loadConvs();
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
      // Keep streamed text for answers still generating: the DB copy lags by up to 1.5s.
      if (S.live.has(r.id) && old.has(r.id) && r.status !== 'completed' && r.status !== 'failed' && r.status !== 'stopped' && r.status !== 'rate_limited') {
        const o = old.get(r.id); Object.assign(r, { content: o.content, reasoning: o.reasoning, status: o.status, retrying: o.retrying, switching: o.switching });
      }
      S.resp.set(r.id, r); return r;
    });
  }
  if (Array.isArray(S.target)) {
    const live = new Set(payload.models.filter((m) => m.status !== 'removed').map((m) => m.model_id));
    S.target = S.target.filter((id) => live.has(id));
    if (!S.target.length) S.target = 'all';
  }
  if (S.reply && !S.resp.has(S.reply.id)) S.reply = null;
}

async function openConversation(id) {
  if (S.conv?.conversation.id === id) { renderConv(); return; }
  try { S.target = 'all'; S.reply = null; setConv(await api('GET', `/api/conversations/${id}`)); renderConv(); renderSidebar(); }
  catch (e) { fail(e); location.hash = '#/new'; }
}
const refreshConv = debounce(async () => {
  if (!S.conv) return;
  try { setConv(await api('GET', `/api/conversations/${S.conv.conversation.id}`)); renderHead(); renderComposerMeta(); } catch {}
}, 250);

function renderConv() {
  renderSidebar(); renderSkills();
  openStream(S.conv.conversation.id);
  $('#main').innerHTML = `${mobileTop(S.conv.conversation.title)}
    <header class="conv-head" id="conv-head"></header>
    <div class="conn" id="conn">Reconnecting… answers keep generating on the server.</div>
    <div class="thread" id="thread"></div>
    <div class="composer"><div class="composer-inner">
      <div id="pin-note"></div>
      <div id="reply-note"></div>
      <div class="attach-tray" hidden></div>
      <div class="small vision-note" id="vision-note"></div>
      <div id="watch-suggest"></div>
      <div class="composer-row">
        <button class="btn attach-btn" id="attach-btn" title="Attach images, PDFs or text files (or drag and drop, or paste)">📎</button>
        <input type="file" id="file-input" multiple hidden accept="${ACCEPT}">
        <textarea class="textarea" id="msg" rows="1" placeholder="Ask anything… (Enter to send, Shift+Enter for a new line)"></textarea>
        <button class="btn" id="stop-all" hidden title="Stop every answer that is generating (Esc)">■ Stop</button>
        <button class="btn primary" id="send-btn">Send</button></div>
      <div class="composer-meta"><div class="send-to" id="send-to"></div><span id="estimate"></span></div>
    </div></div>`;
  renderHead(); renderThread(); renderComposerMeta();
  const msg = $('#msg');
  const draftKey = `draft:${S.conv.conversation.id}`;
  try { msg.value = sessionStorage.getItem(draftKey) || ''; } catch {}
  msg.oninput = () => {
    msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, 240) + 'px'; estimate();
    try { sessionStorage.setItem(draftKey, msg.value); } catch {}
    suggestWatch(msg.value);
  };
  msg.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } };
  $('#send-btn').onclick = sendMessage;
  $('#attach-btn').onclick = () => $('#file-input').click();
  bindFileInput($('#file-input'));
  renderTrays();
  $('#stop-all').onclick = stopAll;
  msg.addEventListener('keydown', (e) => {
    // Up arrow in an empty box edits your last message, like most chat apps.
    if (e.key === 'ArrowUp' && !msg.value) { const t = S.conv.turns.at(-1); if (t) { e.preventDefault(); startEditTurn(t.id); } }
  });
  updateStopAll();
  $('#send-to').onclick = (e) => {
    const b = e.target.closest('[data-to]'); if (!b) return;
    const v = b.dataset.to;
    if (v === 'all') S.target = 'all';
    else {
      const cur = new Set(S.target === 'all' ? activeIds() : S.target);
      if (cur.has(v)) cur.delete(v); else cur.add(v);
      if (cur.size > S.conv.max_models) return toast(`At most ${S.conv.max_models} models per message`);
      if (!cur.size) return toast('Pick at least one model');
      const act = activeIds();
      S.target = cur.size === act.length && act.every((id) => cur.has(id)) ? 'all' : [...cur];
    }
    renderComposerMeta();
  };
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
      ${S.conv.langfuse?.session_url ? `<a class="btn small ghost" href="${esc(S.conv.langfuse.session_url)}" target="_blank" rel="noopener" title="Open this whole chat as a Langfuse session">Langfuse ↗</a>` : ''}
      <button class="btn small" id="finish-btn">Finish</button></div>
    <div class="lanes-bar">${models.map((m) => `<span class="lane-chip ${m.status}" title="${esc(m.model_id)}">
        <span class="dot" style="background:var(--lane-${m.position % 6})"></span>${esc(shortName(m.model_id))}${S.modelMap.get(m.model_id)?.free ? ' <span class="tag free">FREE</span>' : ''}
        ${m.status === 'paused' ? '<span class="muted small">paused</span>' : ''}
        <button class="btn small ghost" data-lane="${m.status === 'paused' ? 'resume' : 'pause'}" data-model="${esc(m.model_id)}" title="${m.status === 'paused' ? 'Resume' : 'Pause'}">${m.status === 'paused' ? '▶' : '⏸'}</button>
        <button class="btn small ghost" data-lane="remove" data-model="${esc(m.model_id)}" title="Remove from conversation">✕</button></span>`).join('')}
      <button class="btn small" id="add-model" ${active >= S.conv.max_models ? `disabled title="Max ${S.conv.max_models} active models"` : ''}>+ Add model</button></div>
    ${S.conv.skill_ids?.length ? `<div class="skills-on small">Skills on: ${S.conv.skill_ids.map((id) => S.skills.find((k) => k.id === id)).filter(Boolean).map((k) => `<span class="tag">${esc(k.name)}</span>`).join('')}</div>` : ''}
    ${S.conv.memory ? `<details class="memory small"><summary>🧠 Memory: older turns are summarized for every model</summary><div class="md">${md(S.conv.memory.summary)}</div>
      <div class="muted">Built only from your messages and the answers you shared, so each model keeps its own view. It updates as the chat grows.</div></details>` : ''}
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

const replyBody = () => (S.reply ? { response_id: S.reply.id, quote: S.reply.quote || null } : null);
const activeIds = () => S.conv.models.filter((m) => m.status === 'active').map((m) => m.model_id);
function targetIds() { return S.target === 'all' ? activeIds() : S.target; }

function renderComposerMeta() {
  if (!S.conv || !$('#send-to')) return;
  const models = S.conv.models.filter((m) => m.status !== 'removed');
  const chosen = new Set(targetIds());
  $('#send-to').innerHTML = `<span class="muted">Send to</span>
    <button class="to-chip ${S.target === 'all' ? 'on' : ''}" data-to="all" title="Every active model">All active (${activeIds().length})</button>
    ${models.map((m) => `<button class="to-chip ${chosen.has(m.model_id) ? 'on' : ''} ${m.status}" data-to="${esc(m.model_id)}" style="--lane:var(--lane-${m.position % 6})"
        title="${m.status === 'paused' ? 'Paused lane: you can still ask it directly' : 'Click to include or leave out'}">
        <span class="dot" style="background:var(--lane-${m.position % 6})"></span>${esc(shortName(m.model_id))}${chosen.has(m.model_id) ? ' ✓' : ''}</button>`).join('')}`;
  renderTrays();
  const n = chosen.size;
  $('#send-btn').textContent = S.target === 'all' ? 'Send' : `Send to ${n}`;
  const r = S.reply && S.resp.get(S.reply.id);
  $('#reply-note').innerHTML = r ? `<div class="reply-note"><span class="dot" style="background:${laneColor(r.model_id)}"></span>
      <div style="flex:1;min-width:0"><b>↩ Replying to ${esc(shortName(r.model_id))}</b>${S.reply.quote ? ' (highlighted part)' : ''}
        <div class="snip">${esc((S.reply.quote || r.content).slice(0, 220))}</div>
        <div class="small muted">Only ${esc(shortName(r.model_id))} is selected. Tick more models below to get their take on this answer too.</div></div>
      <button class="btn small ghost" id="reply-cancel" title="Cancel reply">✕</button></div>` : '';
  const rc = $('#reply-cancel'); if (rc) rc.onclick = () => { S.reply = null; S.target = 'all'; renderComposerMeta(); };
  const pin = S.conv.selections.find((s) => s.selection_type === 'continue');
  $('#pin-note').innerHTML = pin ? `<div class="pin-note">↳ Your next message continues from <b>${esc(shortName(pin.model_id))}</b>'s answer. <button class="btn small ghost" data-unpin="${pin.id}">Cancel</button></div>` : '';
  const up = $('[data-unpin]'); if (up) up.onclick = async () => { try { setConv(await api('DELETE', `/api/selections/${up.dataset.unpin}`)); renderComposerMeta(); } catch (e) { fail(e); } };
  estimate();
}

const estimate = debounce(async () => {
  const el = $('#estimate'); if (!el || !S.conv) return;
  try {
    const est = await api('POST', `/api/conversations/${S.conv.conversation.id}/estimate`, { message: $('#msg')?.value || '', target: S.target, reply_to: replyBody(), attachment_ids: pendingIds() });
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
  enhanceCode(th);
}

function turnHTML(t) {
  const rs = t.responses;
  const active = S.tabs[t.id] && rs.some((r) => r.id === S.tabs[t.id]) ? S.tabs[t.id] : rs[0]?.id;
  return `<section class="turn" id="turn-${t.id}">
    ${t.reply_to_response ? replyQuoteHTML(t) : ''}
    ${turnAttachmentsHTML(t)}
    <div class="user-msg">${esc(t.user_message)}${S.conv.turns.at(-1)?.id === t.id ? `<button class="btn small ghost edit-btn" data-act="edit-turn" data-turn="${t.id}" title="Edit and resend (↑ in an empty box)">✎ Edit</button>` : ''}</div>
    ${t.mode === 'single' ? `<div class="turn-meta">Asked only ${esc(shortName(t.target_models[0]))}</div>`
      : t.mode === 'subset' ? `<div class="turn-meta">Asked ${t.target_models.map((m) => esc(shortName(m))).join(' and ')}</div>` : ''}
    <div class="lane-tabs">${rs.map((r) => `<button class="${r.id === active ? 'on' : ''}" style="--lane:${laneColor(r.model_id)}" data-act="tab" data-turn="${t.id}" data-id="${r.id}">
      <span class="dot" style="background:${laneColor(r.model_id)};width:8px;height:8px;border-radius:50%"></span>${esc(shortName(r.model_id))}${r.status === 'completed' ? ' ✓' : r.status === 'generating' ? ' …' : ['failed', 'rate_limited'].includes(r.status) ? ' ⚠' : ''}</button>`).join('')}</div>
    <div class="lanes" style="--n:${Math.max(1, rs.length)}">${rs.map((r) => cardHTML(r, r.id === active)).join('')}</div>
    ${rs.filter((r) => r.status === 'completed').length >= 2 ? `<div class="turn-tools"><button class="btn small" data-act="evaluate" data-turn="${t.id}">⚖ Evaluate answers</button>
      ${S.conv.evaluations?.some((e) => e.turn_id === t.id) ? '<span class="muted small">Evaluated. Run again to rescore.</span>' : ''}</div>` : ''}
  </section>`;
}

function replyQuoteHTML(t) {
  const r = S.resp.get(t.reply_to_response);
  if (!r) return '<div class="reply-quote muted">↩ Reply to an earlier answer</div>';
  return `<a class="reply-quote" href="#" data-act="jump" data-id="${r.id}" style="--lane:${laneColor(r.model_id)}">
    <b>↩ Reply to ${esc(shortName(r.model_id))}</b><span>${esc((t.reply_quote || r.content).replace(/\s+/g, ' ').slice(0, 160))}</span></a>`;
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
  const body = has ? md(r.content) : live ? (r.switching ? `<div class="retrying"><b>${esc(shortName(r.model_id))} is still rate limited.</b><span class="muted">Finding the best other model that is answering right now…</span></div>` : r.retrying ? retryingHTML(r) : `<span class="muted">${r.reasoning ? 'Thinking…' : 'Waiting for the first token…'}</span>`)
    : r.status === 'pending' ? (Date.now() - r.created_at < 15000 ? '<span class="muted">Starting…</span>' : '<span class="muted">Not started.</span>') : '';
  return `<article class="card ${r.final ? 'is-final' : ''} ${tabActive ? 'tab-active' : ''}" id="card-${r.id}" data-id="${r.id}" style="--lane:${laneColor(r.model_id)}">
    <div class="card-head"><span class="dot" style="background:${laneColor(r.model_id)}"></span>
      <span class="name" title="${esc(r.model_id)}">${esc(shortName(r.model_id))}</span>
      ${r.stands_in_for && S.resp.get(r.stands_in_for) ? `<span class="badge standin" title="Answering in place of ${esc(shortName(S.resp.get(r.stands_in_for).model_id))}, which was ${S.resp.get(r.stands_in_for).error_kind === 'rate_limit' ? 'rate limited' : 'unavailable'}">Stand-in for ${esc(shortName(S.resp.get(r.stands_in_for).model_id))}</span>` : ''}
      ${(() => { const ev = latestEvalFor(r.id); const o = evalOverall(ev, r.id); return o == null ? '' : `<span class="badge eval ${ev.recommended_response === r.id ? 'rec' : ''}" title="${ev.evaluator === 'jev' ? 'Jev' : 'Judge'} score${ev.recommended_response === r.id ? ', recommended' : ''}">⚖ ${Math.round(o)}${ev.recommended_response === r.id ? ' ★' : ''}</span>`; })()}
      ${r.final ? '<span class="badge final">Final</span>' : ''}${r.saved ? '<span class="badge">Saved</span>' : ''}
      <span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span></div>
    ${r.reasoning ? `<details class="thinking" ${live && !has ? 'open' : ''}><summary>Reasoning (${fmtTokens(Math.ceil(r.reasoning.length / 4))} tokens)</summary><pre>${esc(r.reasoning.slice(-20000))}</pre></details>` : ''}
    ${body ? `<div class="card-body md ${live ? 'cursor' : ''} ${long ? 'collapsed' : ''}">${body}</div>` : ''}
    ${long ? `<button class="btn small ghost expand" data-act="expand" data-id="${r.id}">Show full answer</button>` : ''}
    ${errText ? `<div class="err-box ${isErr ? '' : 'warn'}">${errText}</div>` : ''}
    ${meta.length ? `<div class="card-meta">${meta.join('<span>·</span>')}</div>` : ''}
    <div class="card-actions">
      ${live ? `<button class="btn small" data-act="stop" data-id="${r.id}">■ Stop</button>` : ''}
      ${!live && r.status !== 'completed' && !(r.status === 'pending' && Date.now() - r.created_at < 15000) ? `<button class="btn small" data-act="run" data-id="${r.id}">${r.status === 'pending' ? 'Run' : '↻ Retry'}</button>` : ''}
      ${!live && has && r.status === 'completed' ? `<button class="btn small ghost" data-act="regen" data-id="${r.id}" title="Ask this model again. The current answer is kept as a version.">↻ Regenerate</button>` : ''}
      ${!live && r.version_count ? `<button class="btn small ghost" data-act="versions" data-id="${r.id}" title="Earlier answers from this model">Versions (${r.version_count + 1})</button>` : ''}
      ${has && !live ? `
        <button class="btn small" data-act="use" data-id="${r.id}" title="Send this answer (or the part you highlighted) to every model on future turns">Use as context</button>
        <button class="btn small" data-act="continue" data-id="${r.id}" title="Your next message builds on this answer, for all models">Continue with this</button>
        <button class="btn small" data-act="reply" data-id="${r.id}" title="Reply to this answer. Highlight part of it first to quote just that part.">↩ Reply</button>
        <button class="btn small ghost" data-act="ask" data-id="${r.id}" title="Send the next message only to this model">Ask this model</button>
        <button class="btn small ghost" data-act="copy" data-id="${r.id}">Copy</button>
        <button class="btn small ghost ${r.rating === 1 ? 'on' : ''}" data-act="rate" data-v="1" data-id="${r.id}" title="Good answer">👍</button>
        <button class="btn small ghost ${r.rating === -1 ? 'on' : ''}" data-act="rate" data-v="-1" data-id="${r.id}" title="Bad answer. Tell us why with 💬 Feedback">👎</button>
        <button class="btn small ghost ${r.saved ? 'on' : ''}" data-act="save" data-id="${r.id}">${r.saved ? 'Saved' : 'Save'}</button>
        <button class="btn small ghost ${r.final ? 'on' : ''}" data-act="final" data-id="${r.id}">${r.final ? 'Final ✓' : 'Use as final'}</button>` : ''}
      ${r.attempts ? `<button class="btn small ghost" data-act="context" data-id="${r.id}" title="See exactly what was sent to this model">Context sent</button>` : ''}
      ${S.conv?.langfuse && r.trace_span_id ? `<a class="btn small ghost" target="_blank" rel="noopener" title="Open this run in Langfuse"
          href="${esc(S.conv.langfuse.trace_base + (S.conv.turns.find((t) => t.id === r.turn_id)?.trace_id || '') + '?observation=' + r.trace_span_id)}">Trace ↗</a>` : ''}
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
  const standIn = r.replaced_by && S.resp.get(r.replaced_by);
  if (standIn) {
    alts = `<div class="switched">⇄ ${r.replaced_by && standIn.auto_switched ? 'Switched automatically' : 'You switched this lane'} to
      <a href="#" data-act="jump" data-id="${standIn.id}"><b>${esc(shortName(standIn.model_id))}</b></a>, which answered this message instead.
      ${esc(shortName(r.model_id))} is paused. Resume it from the model chips above when it is free again.</div>`;
  } else if (laneStatus && laneStatus !== 'active') {
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
}
// Tick countdowns on cards that are waiting to retry.
setInterval(() => { for (const [id, r] of S.resp) if (r.retrying && r.status === 'generating') renderCard(id); }, 1000);

// Syntax highlighting + copy buttons for code blocks (skipped while a card is still streaming).
function enhanceCode(root) {
  if (!root) return;
  root.querySelectorAll('.card-body pre > code').forEach((code) => {
    const pre = code.parentElement;
    if (pre.parentElement.classList.contains('code-wrap')) return;
    if (window.hljs && !code.classList.contains('hljs')) { try { hljs.highlightElement(code); } catch {} }
    const lang = [...code.classList].find((c) => c.startsWith('language-'))?.slice(9) || '';
    const wrap = document.createElement('div'); wrap.className = 'code-wrap';
    pre.replaceWith(wrap);
    wrap.innerHTML = `<div class="code-bar"><span>${esc(lang)}</span><button class="btn small ghost" data-act="copy-code">Copy</button></div>`;
    wrap.appendChild(pre);
  });
}

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
      if (r.status !== 'generating') enhanceCode(document.getElementById(`card-${rid}`));
      const th2 = document.querySelector(`#card-${rid} .thinking`); if (th2 && openThinking !== undefined && r.content.trim()) th2.open = openThinking;
      const turn = S.conv.turns.find((t) => t.id === r.turn_id);
      const tabs = turn && document.querySelector(`#turn-${turn.id} .lane-tabs`);
      if (tabs) { const tmp = document.createElement('div'); tmp.innerHTML = turnHTML(turn); tabs.replaceWith(tmp.querySelector('.lane-tabs')); }
    }
    pendingCardRender.clear();
    if (nearBottom && th) th.scrollTop = th.scrollHeight;
  }, 50);
}

const AGENT_INTENT = /\b(notify me|alert me|let me know|keep me (?:posted|updated)|tell me when|track|monitor|watch for)\b/i;
function suggestWatch(text) {
  const box = $('#watch-suggest'); if (!box) return;
  const url = (text.match(URL_RE) || [])[0];
  const priceLink = url && WATCH_INTENT.test(text.replace(url, '')) && /\b(price|cheaper|below|under|drops?|deal|\$|£|€)/i.test(text);
  if (!priceLink && AGENT_INTENT.test(text) && text.length > 15) {
    box.innerHTML = `<button class="btn small watch-chip" id="ag-go">🤖 Create an agent for this</button>`;
    $('#ag-go').onclick = () => { S.agentPrefill = text; location.hash = '#/agents'; };
    return;
  }
  box.innerHTML = priceLink ? `<button class="btn small watch-chip" id="ws-go">🔔 Watch the price of this link and alert me when it drops</button>` : '';
  const b = $('#ws-go'); if (b) b.onclick = () => openWatchModal({ url, target: parsePriceHint(text), interval: parseFrequency(text), conversationId: S.conv?.conversation.id });
}
const parsePriceHint = (t) => { const m = t.match(/(?:below|under|less than|falls? (?:below|under|to)|drops? (?:below|under|to)|<)\s*(?:x\s*)?[$£€₹]?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:dollars?|usd|bucks)?/i); return m ? Number(m[1].replace(/,/g, '')) : null; };

async function sendMessage() {
  const msg = $('#msg'); const text = msg.value.trim();
  // "/watch <link> [below 500]" sets up a price watch instead of sending a message.
  if (/^\/watch\b/i.test(text)) {
    const url = (text.match(URL_RE) || [])[0];
    openWatchModal({ url: url || '', target: parsePriceHint(text), interval: parseFrequency(text), conversationId: S.conv?.conversation.id });
    msg.value = ''; suggestWatch(''); return;
  }
  if ((!text && !pendingIds().length) || !S.conv) return;
  if (uploadsBusy()) return toast('Wait for the uploads to finish');
  const btn = $('#send-btn'); btn.disabled = true;
  try {
    const payload = await api('POST', `/api/conversations/${S.conv.conversation.id}/messages`, { message: text, target: S.target, reply_to: replyBody(), attachment_ids: pendingIds() });
    S.reply = null; clearPending();
    msg.value = ''; msg.style.height = 'auto';
    try { sessionStorage.removeItem(`draft:${S.conv.conversation.id}`); } catch {}
    setConv(payload); renderHead(); renderThread(); renderComposerMeta(); loadConvs();
    const th = $('#thread'); th.scrollTop = th.scrollHeight;
  } catch (e) { fail(e); } finally { btn.disabled = false; msg.focus(); }
}

// ---------- live stream ----------
// Models run on the server. The browser just watches one stream per open chat, so a reload,
// a tab switch or a dropped connection never stops an answer; on reconnect the server sends
// a snapshot of everything mid-generation and the stream carries on.
let stream = null; // { convId, ctl }
function openStream(convId) {
  if (stream?.convId === convId) return;
  closeStream();
  const ctl = new AbortController();
  stream = { convId, ctl, retry: 0 };
  (async function loop() {
    while (stream?.ctl === ctl) {
      try {
        const res = await fetch(`/api/conversations/${convId}/stream`, { signal: ctl.signal });
        if (res.status === 401) { await api('GET', '/api/me').catch(() => {}); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        stream.retry = 0; setConn(true);
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (line.trim()) onStreamEvent(JSON.parse(line));
          }
        }
      } catch (e) { if (ctl.signal.aborted) return; }
      if (stream?.ctl !== ctl) return;
      setConn(false);
      await new Promise((ok) => setTimeout(ok, Math.min(5000, 500 * 2 ** stream.retry++)));
      refreshConvFull(); // catch up on anything that finished while disconnected
    }
  })();
}
function closeStream() { stream?.ctl.abort(); stream = null; }
function setConn(ok) { document.getElementById('conn')?.classList.toggle('show', !ok); }

const refreshConvFull = debounce(async () => {
  if (!S.conv) return;
  try { setConv(await api('GET', `/api/conversations/${S.conv.conversation.id}`)); renderHead(); renderThread(); renderComposerMeta(); } catch {}
}, 200);

function onStreamEvent(ev) {
  if (ev.type === 'ping' || ev.type === 'ready') return;
  if (ev.type === 'title') {
    if (S.conv) { S.conv.conversation.title = ev.title; const t = $('#title'); if (t && document.activeElement !== t) t.value = ev.title; }
    loadConvs(); return;
  }
  if (ev.type === 'summary') { refreshConv(); return; }
  const cur = S.resp.get(ev.rid);
  if (!cur) { refreshConvFull(); return; } // a response this tab hasn't seen yet (stand-in, other tab)
  switch (ev.type) {
    case 'start': Object.assign(cur, ev.response, { retrying: null, switching: false }); S.live.add(cur.id); S.alts.delete(cur.id); break;
    case 'snapshot': Object.assign(cur, { status: 'generating', content: ev.content, reasoning: ev.reasoning, switching: ev.switching,
      retrying: ev.retrying ? { attempt: ev.retrying.attempt, of: ev.retrying.of, until: ev.retrying.at + ev.retrying.wait_ms, total: ev.retrying.wait_ms } : null }); S.live.add(cur.id); break;
    case 'delta': cur.content += ev.content; cur.retrying = null; break;
    case 'reasoning': cur.reasoning += ev.content; cur.retrying = null; break;
    case 'retrying': cur.retrying = { attempt: ev.attempt, of: ev.of, until: Date.now() + ev.wait_ms, total: ev.wait_ms }; break;
    case 'switching': cur.retrying = null; cur.switching = true; break;
    case 'switch_failed': cur.switching = false; toast(`${shortName(cur.model_id)} is rate limited. ${ev.message}`); break;
    case 'switched':
      toast(`${shortName(ev.from)} was rate limited, so ${shortName(ev.to)} is answering instead. ${shortName(ev.from)} is paused.`, 6000);
      if (Array.isArray(S.target)) S.target = S.target.map((m) => (m === ev.from ? ev.to : m));
      if (S.reply?.model_id === ev.from) S.reply = null;
      refreshConvFull();
      break;
    case 'final': Object.assign(cur, ev.response, { retrying: null, switching: false }); S.live.delete(cur.id); refreshConv(); break;
  }
  renderCard(cur.id);
  updateStopAll();
}

// Asks the server to (re)run one answer; output arrives on the stream.
async function runResponse(id, { regenerate = false } = {}) {
  const r = S.resp.get(id);
  try {
    await api('POST', `/api/responses/${id}/run`, regenerate ? { regenerate: true } : {});
    if (r) { Object.assign(r, { status: 'generating', content: '', reasoning: '', error: null, error_kind: null, retrying: null }); S.live.add(id); S.alts.delete(id); renderCard(id); updateStopAll(); }
  } catch (e) { fail(e); }
}

function updateStopAll() {
  const b = $('#stop-all'); if (!b) return;
  const n = [...S.resp.values()].filter((r) => r.status === 'generating' || r.status === 'pending' && S.live.has(r.id)).length;
  b.hidden = !n; b.textContent = `■ Stop ${n > 1 ? `all ${n}` : ''}`.trim();
}

async function stopAll() {
  if (!S.conv) return;
  try { const { stopped } = await api('POST', `/api/conversations/${S.conv.conversation.id}/stop`); if (stopped) toast(`Stopped ${stopped} answer${stopped > 1 ? 's' : ''}`); } catch (e) { fail(e); }
}

// ---------- edit your last message ----------
function startEditTurn(turnId) {
  const t = S.conv.turns.find((x) => x.id === turnId);
  if (!t || S.conv.turns.at(-1).id !== turnId) return;
  const box = document.querySelector(`#turn-${turnId} .user-msg`); if (!box) return;
  box.outerHTML = `<div class="user-edit" id="edit-${turnId}"><textarea class="textarea" rows="3">${esc(t.user_message)}</textarea>
    <div class="edit-actions"><span class="muted small">Every model answers again. The current answers are kept as earlier versions.</span>
    <button class="btn small" data-act="edit-cancel">Cancel</button><button class="btn small primary" data-act="edit-save" data-turn="${turnId}">Save and resend</button></div></div>`;
  const ta = document.querySelector(`#edit-${turnId} textarea`);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.onkeydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); renderThread(); }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); document.querySelector(`#edit-${turnId} [data-act="edit-save"]`).click(); }
  };
}

async function openVersions(id) {
  const r = S.resp.get(id);
  const { versions } = await api('GET', `/api/responses/${id}/versions`);
  const { el, close } = modal({
    title: `Earlier answers from ${shortName(r.model_id)}`, wide: true,
    body: versions.length ? versions.map((v, i) => `<div class="out-item"><div style="display:flex;gap:8px;align-items:center"><b style="flex:1">Version ${i + 1}</b>
        <span class="muted small">${v.finished_at ? new Date(v.finished_at).toLocaleString() : ''}</span>
        <button class="btn small primary" data-restore="${i}">Use this version</button></div>
        <details><summary class="small">Show</summary><div class="card-body md">${md(v.content)}</div></details></div>`).reverse().join('')
      : '<p class="muted">No earlier versions.</p>',
    foot: '<span class="muted small" style="margin-right:auto">The version you pick becomes the answer every model sees in later turns. The current one is kept here.</span><button class="btn" data-close>Close</button>',
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-restore]'); if (!b) return;
    try { const row = await api('POST', `/api/responses/${id}/restore`, { index: Number(b.dataset.restore) }); Object.assign(S.resp.get(id), row); renderCard(id); close(); toast('Restored'); }
    catch (err) { fail(err); }
  });
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
      case 'regen': runResponse(id, { regenerate: true }); break;
      case 'versions': await openVersions(id); break;
      case 'edit-turn': startEditTurn(b.dataset.turn); break;
      case 'edit-cancel': renderThread(); break;
      case 'edit-save': {
        const ta = document.querySelector(`#edit-${b.dataset.turn} textarea`);
        if (!ta.value.trim()) return;
        b.disabled = true;
        setConv(await api('POST', `/api/turns/${b.dataset.turn}/edit`, { message: ta.value }));
        renderThread(); renderHead();
        break;
      }
      case 'evaluate': {
        const turn = S.conv.turns.find((x) => x.id === b.dataset.turn);
        await openEvaluate(turn.responses.filter((r) => r.status === 'completed').map((r) => r.id));
        break;
      }
      case 'copy-code': {
        const code = b.closest('.code-wrap')?.querySelector('code')?.innerText || '';
        await navigator.clipboard.writeText(code); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200);
        break;
      }
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
      case 'reply': {
        const part = S.lastSel?.id === id && S.lastSel.text.trim().length > 3 ? S.lastSel.text.trim() : '';
        S.reply = { id, model_id: r.model_id, quote: part };
        S.target = [r.model_id]; S.lastSel = null;
        renderComposerMeta(); $('#msg').focus();
        break;
      }
      case 'jump': {
        e.preventDefault();
        const turn = S.conv.turns.find((t) => t.responses.some((x) => x.id === id));
        if (turn) { S.tabs[turn.id] = id; renderThread(); }
        const card = document.getElementById(`card-${id}`);
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card?.classList.add('flash'); setTimeout(() => card?.classList.remove('flash'), 1400);
        break;
      }
      case 'ask':
        S.target = [r.model_id]; renderComposerMeta(); $('#msg').focus();
        toast(`Next message goes only to ${shortName(r.model_id)}`);
        break;
      case 'copy': await navigator.clipboard.writeText(r.content); toast('Copied'); break;
      case 'rate': {
        const v = Number(b.dataset.v); const next = r.rating === v ? 0 : v;
        Object.assign(r, await api('POST', `/api/responses/${id}/rate`, { value: next })); renderCard(id);
        if (next === -1) toast('Thanks. Want to say what was wrong? Use 💬 Feedback.', 4000);
        break;
      }
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
    foot: `${picks.length >= 2 ? '<button class="btn" id="eval-picks" style="margin-right:auto">⚖ Evaluate selected responses</button>' : '<span class="muted small" style="margin-right:auto">Save two or more answers to have them evaluated.</span>'}<button class="btn primary" data-close>Continue conversation</button>`,
  });
  const ep = $('#eval-picks', el); if (ep) ep.onclick = () => { close(); openEvaluate(picks.map(({ r }) => r.id), { title: 'Evaluate your selected outputs' }); };
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
      <label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="set-auto" ${p.auto_switch !== false ? 'checked' : ''} style="margin-top:4px">
        <span>When a model is rate limited, switch to the best other model that is answering<br><span class="muted small">You always see when this happens. The busy model is paused, not removed. Turn this off to keep strict comparisons and retry for longer instead.</span></span></label>
      <div class="key-box"><b>Your OpenRouter key</b>
        <div id="key-status" class="small muted">Checking…</div>
        <div class="key-row"><input class="input" id="key-input" type="password" autocomplete="off" spellcheck="false" placeholder="sk-or-v1-…">
          <button class="btn" id="key-save">${S.me.openrouter_key?.set ? 'Replace key' : 'Save key'}</button>
          ${S.me.openrouter_key?.set ? '<button class="btn danger" id="key-del">Remove</button>' : ''}</div>
        <div class="small muted">Use your own OpenRouter account: your credits, your rate limits, and paid models if you have credits. Get a key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. It is checked with OpenRouter, encrypted on the server, and never shown again. Only the last 4 characters are kept visible.</div>
        <div class="err-text" id="key-err"></div></div>
      <div class="key-box"><b>Jev evaluator key (TypeSafe)</b>
        <div class="small muted">${S.me.jev_key?.set ? `✓ Evaluations use Jev with your key ••••${esc(S.me.jev_key.last4)}.` : S.me.jev_shared_available ? 'Evaluations use Jev with this app\'s shared key.' : 'No Jev key, so evaluations use a free fallback judge on OpenRouter.'}</div>
        <div class="key-row"><input class="input" id="jev-input" type="password" autocomplete="off" spellcheck="false" placeholder="TypeSafe API key">
          <button class="btn" id="jev-save">${S.me.jev_key?.set ? 'Replace key' : 'Save key'}</button>${S.me.jev_key?.set ? '<button class="btn danger" id="jev-del">Remove</button>' : ''}</div>
        <div class="small muted">Jev scores answers on a rubric and picks the best one, with calibrated confidence. The key is checked with a test call, then encrypted on the server.</div>
        <div class="err-text" id="jev-err"></div></div>
      <div id="lf-status" class="small muted">Checking Langfuse…</div>
      <hr style="border:0;border-top:1px solid var(--border);width:100%">
      <div><b>Delete account</b><p class="muted small">Permanently deletes your account, conversations, responses, and preference history.</p>
      <button class="btn danger" id="del-acct">Delete my account</button></div>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="set-save">Save</button>`,
  });
  const showKey = () => api('GET', '/api/me/openrouter-key').then((k) => {
    const box = $('#key-status', el); if (!box) return;
    const usage = k.error ? `⚠ ${esc(k.error)}` : [k.limit != null ? `limit $${Number(k.limit).toFixed(2)}, $${Number(k.limit_remaining ?? 0).toFixed(2)} left` : 'no spending limit',
      k.usage != null ? `$${Number(k.usage).toFixed(2)} used` : '', k.free_daily ? `${k.free_daily.remaining} of ${k.free_daily.limit} free-model requests left today` : ''].filter(Boolean).join(' · ');
    box.innerHTML = k.source === 'personal' ? `✓ Your chats run on your key ••••${esc(k.last4 || '')}. ${usage}`
      : k.source === 'shared' ? `Your chats run on this app's shared key. ${usage}` : '⚠ No key. Add your OpenRouter key to start chatting.';
  }).catch(() => {});
  showKey();
  $('#jev-save', el).onclick = async () => {
    const btn = $('#jev-save', el); btn.disabled = true; btn.textContent = 'Checking with Jev…'; $('#jev-err', el).textContent = '';
    try { S.me = await api('PUT', '/api/me/jev-key', { key: $('#jev-input', el).value }); toast('Jev key saved. Evaluations now use Jev.'); close(); openSettings(); }
    catch (e) { $('#jev-err', el).textContent = e.message; btn.disabled = false; btn.textContent = 'Save key'; }
  };
  const jd = $('#jev-del', el);
  if (jd) jd.onclick = async () => { try { S.me = await api('DELETE', '/api/me/jev-key'); toast('Jev key removed'); close(); openSettings(); } catch (e) { fail(e); } };
  $('#key-save', el).onclick = async () => {
    const input = $('#key-input', el); const btn = $('#key-save', el);
    $('#key-err', el).textContent = ''; btn.disabled = true; btn.textContent = 'Checking with OpenRouter…';
    try {
      S.me = await api('PUT', '/api/me/openrouter-key', { key: input.value });
      input.value = ''; toast('Key saved. Your chats now run on your OpenRouter account.'); close(); openSettings();
    } catch (e) { $('#key-err', el).textContent = e.message; btn.disabled = false; btn.textContent = S.me.openrouter_key?.set ? 'Replace key' : 'Save key'; }
  };
  const kd = $('#key-del', el);
  if (kd) kd.onclick = async () => {
    if (!confirm(S.me.shared_key_available ? 'Remove your key? Chats will go back to the shared key.' : 'Remove your key? You will not be able to chat until you add one again.')) return;
    try { S.me = await api('DELETE', '/api/me/openrouter-key'); toast('Key removed'); close(); openSettings(); } catch (e) { fail(e); }
  };
  api('GET', '/api/langfuse/status').then((st) => {
    const box = $('#lf-status', el); if (!box) return;
    box.innerHTML = !st.enabled
      ? '<b>Langfuse:</b> off. Add LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to .env and restart to trace every chat.'
      : `<b>Langfuse:</b> ${st.last_error ? `⚠ ${esc(st.last_error)}` : 'connected'} · ${st.spans_sent} spans and ${st.scores_sent} scores sent${st.spans_dropped ? ` · ${st.spans_dropped} dropped` : ''}
         · ${st.log_content ? 'prompts and answers included' : 'metadata only'}${st.project_url ? ` · <a href="${esc(st.project_url)}" target="_blank" rel="noopener">open project ↗</a>` : ''}`;
  }).catch(() => {});
  $('#set-save', el).onclick = async () => {
    try { S.me = await api('PATCH', '/api/me', { max_output_tokens: Number($('#set-max', el).value), free_only: $('#set-free', el).checked, auto_switch: $('#set-auto', el).checked }); S.filters.free = S.me.preferences.free_only; close(); toast('Settings saved'); if (S.conv) estimate(); }
    catch (e) { fail(e); }
  };
  $('#del-acct', el).onclick = async () => {
    if (prompt('Type DELETE to permanently delete your account and all data') !== 'DELETE') return;
    try { await api('DELETE', '/api/me'); close(); S.me = null; S.conv = null; renderAuth('signup'); } catch (e) { fail(e); }
  };
}



// ---------- attachments ----------
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf,.txt,.md,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.html,.css,.js,.mjs,.jsx,.ts,.tsx,.py,.ipynb,.java,.kt,.go,.rb,.rs,.c,.h,.cpp,.hpp,.cs,.php,.swift,.scala,.sql,.sh,.r,.lua,.dart,.vue,.svelte,.log,.ini,.toml,.tex,.rst,.srt,.vtt';
const MAX_FILES = 6, MAX_BYTES = 20 * 1024 * 1024;
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fileIcon = (kind) => ({ image: '🖼', pdf: '📄', text: '📃' }[kind] || '📎');
const guessKind = (f) => (f.type.startsWith('image/') ? 'image' : f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? 'pdf' : 'text');

function addFiles(files) {
  for (const f of files) {
    if (S.pending.length >= MAX_FILES) { toast(`At most ${MAX_FILES} files per message`); break; }
    if (f.size > MAX_BYTES) { toast(`${f.name} is larger than 20 MB`); continue; }
    if (/\.svg$/i.test(f.name) || f.type === 'image/svg+xml') { toast('SVG images are not supported. Use PNG or JPEG.'); continue; }
    const item = { local: crypto.randomUUID(), name: f.name, size: f.size, kind: guessKind(f), status: 'uploading', progress: 0,
      preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
    S.pending.push(item);
    uploadOne(item, f);
  }
  renderTrays();
}

function uploadOne(item, file) {
  const xhr = new XMLHttpRequest();
  item.xhr = xhr;
  xhr.open('POST', '/api/uploads');
  xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { item.progress = e.loaded / e.total; renderTrays(); } };
  xhr.onload = () => {
    let body = {}; try { body = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status === 401) { api('GET', '/api/me').catch(() => {}); return; }
    if (xhr.status >= 300) { item.status = 'failed'; item.error = body.error || `Upload failed (${xhr.status})`; renderTrays(); return; }
    Object.assign(item, { id: body.id, kind: body.kind, status: body.status, error: body.error });
    renderTrays(); estimate();
    if (item.status === 'processing') pollAttachment(item);
  };
  xhr.onerror = () => { item.status = 'failed'; item.error = 'Network error during upload'; renderTrays(); };
  xhr.send(file);
}

async function pollAttachment(item) {
  while (item.status === 'processing' && S.pending.includes(item)) {
    await new Promise((ok) => setTimeout(ok, 1500));
    try { const a = await api('GET', `/api/uploads/${item.id}`); item.status = a.status; item.error = a.error; item.has_text = a.has_text; } catch { break; }
    renderTrays();
  }
  estimate();
}

function removePending(local) {
  const item = S.pending.find((x) => x.local === local); if (!item) return;
  item.xhr?.abort();
  if (item.id) api('DELETE', `/api/uploads/${item.id}`).catch(() => {});
  if (item.preview) URL.revokeObjectURL(item.preview);
  S.pending = S.pending.filter((x) => x !== item);
  renderTrays(); estimate();
}

function clearPending() { for (const i of S.pending) if (i.preview) URL.revokeObjectURL(i.preview); S.pending = []; renderTrays(); }
const pendingIds = () => S.pending.filter((i) => i.id && i.status !== 'failed').map((i) => i.id);
const uploadsBusy = () => S.pending.some((i) => i.status === 'uploading');

function renderTrays() {
  document.querySelectorAll('.attach-tray').forEach((tray) => {
    tray.innerHTML = S.pending.map((i) => `<div class="att-chip ${i.status}" title="${esc(i.error || i.name)}">
        ${i.preview ? `<img src="${i.preview}" alt="">` : `<span class="att-icon">${fileIcon(i.kind)}</span>`}
        <span class="att-meta"><span class="att-name">${esc(i.name)}</span>
          <span class="att-sub">${i.status === 'uploading' ? `Uploading ${Math.round(i.progress * 100)}%` : i.status === 'processing' ? 'Reading PDF…' : i.status === 'failed' ? `⚠ ${esc(i.error || 'Failed')}` : i.error ? '⚠ Sent as file' : fmtSize(i.size)}</span></span>
        ${i.status === 'uploading' ? `<span class="att-bar"><i style="width:${Math.round(i.progress * 100)}%"></i></span>` : ''}
        <button class="att-x" data-unattach="${i.local}" title="Remove">×</button></div>`).join('');
    tray.hidden = !S.pending.length;
  });
  const note = $('#vision-note');
  if (note && S.conv) {
    const hasImg = S.pending.some((i) => i.kind === 'image' && i.status !== 'failed');
    const blind = hasImg ? targetIds().filter((id) => S.modelMap.get(id) && !S.modelMap.get(id).vision) : [];
    note.innerHTML = blind.length ? `🖼 ${blind.map((id) => esc(shortName(id))).join(', ')} can't see images, so ${blind.length > 1 ? 'they get' : 'it gets'} a detailed AI description of each image instead.` : '';
  }
  const send = $('#send-btn') || $('#start-btn');
  if (send) send.disabled = uploadsBusy();
}

// Drag and drop anywhere on the main area, and paste images or files into a text box.
// Wired once on #main (it persists across views); per view only the file input changes.
function bindFileInput(input) { input.onchange = () => { addFiles([...input.files]); input.value = ''; }; }
function wireAttachments(root) {
  let depth = 0;
  root.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; root.classList.add('dropping'); } });
  root.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; root.classList.remove('dropping'); } });
  root.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  root.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); if (!$('#file-input')) { depth = 0; root.classList.remove('dropping'); return; } depth = 0; root.classList.remove('dropping'); addFiles([...e.dataTransfer.files]); });
  root.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && e.target.matches('textarea')) { e.preventDefault(); addFiles(files.map((f, i) => (f.name === 'image.png' ? new File([f], `pasted-${Date.now()}-${i}.png`, { type: f.type }) : f))); }
  });
  root.addEventListener('click', (e) => { const x = e.target.closest('[data-unattach]'); if (x) removePending(x.dataset.unattach); });
}

function turnAttachmentsHTML(t) {
  if (!t.attachments?.length) return '';
  const blind = t.attachments.some((a) => a.kind === 'image') ? t.target_models.filter((id) => S.modelMap.get(id) && !S.modelMap.get(id).vision) : [];
  return `<div class="turn-atts">${t.attachments.map((a) => a.kind === 'image'
      ? `<a class="att-thumb" href="/api/uploads/${a.id}/raw" target="_blank" rel="noopener" title="${esc(a.name)}"><img src="/api/uploads/${a.id}/raw" alt="${esc(a.name)}" loading="lazy"></a>`
      : `<a class="att-file" href="/api/uploads/${a.id}/raw" target="_blank" rel="noopener" title="${esc(a.error || a.name)}">${fileIcon(a.kind)} <span>${esc(a.name)}</span> <span class="muted">${fmtSize(a.size)}${a.error ? ' · sent as file' : ''}</span></a>`).join('')}</div>
    ${blind.length ? `<div class="turn-meta">${blind.map((id) => esc(shortName(id))).join(', ')} got an AI description of the image${t.attachments.filter((a) => a.kind === 'image').length > 1 ? 's' : ''}</div>` : ''}`;
}


// ---------- evaluation (Jev or fallback judge) ----------
let evaluatorInfo = null;
async function getEvaluator() { evaluatorInfo = await api('GET', '/api/evaluator'); return evaluatorInfo; }
const latestEvalFor = (rid) => [...(S.conv?.evaluations || [])].reverse().find((e) => e.candidates.includes(rid));
const evalOverall = (e, rid) => e?.results.find((r) => r.response_id === rid)?.scores.overall?.value ?? null;

async function openEvaluate(responseIds, { title = 'Evaluate answers' } = {}) {
  const info = await getEvaluator();
  const cands = responseIds.map((id) => S.resp.get(id)).filter((r) => r?.content?.trim());
  const { el, close } = modal({
    title, wide: true,
    body: `<div class="eval-who">${info.evaluator === 'jev'
        ? `<b>Evaluator: Jev</b> by TypeSafe, a decision model with calibrated scores and confidence${info.key_source === 'personal' ? ' (your key)' : ''}.`
        : `<b>Evaluator: fallback judge</b>, a free model on OpenRouter scoring the same rubric. Add a Jev key in Settings for calibrated scores with confidence.`}</div>
      <div><div class="section-title">Answers</div><div class="eval-cands">${cands.map((r) => `<label class="chk"><input type="checkbox" data-cand="${r.id}" checked>
        <span class="dot" style="background:${laneColor(r.model_id)}"></span>${esc(shortName(r.model_id))}</label>`).join('')}</div>
        <div class="muted small">The evaluator never sees model names. Answers are labeled A, B, C.</div></div>
      <div><div class="section-title">Rubric</div><div class="eval-crit">${info.criteria.map((c) => `<label class="chk" title="${esc(c.question)}"><input type="checkbox" data-crit="${c.key}" ${c.default ? 'checked' : ''}> ${esc(c.label)}</label>`).join('')}</div></div>
      <div id="eval-out"></div>`,
    foot: `<span class="muted small" style="margin-right:auto">The result is a recommendation. You make the final call.</span><button class="btn" data-close>Close</button><button class="btn primary" id="eval-run">Run evaluation</button>`,
  });
  $('#eval-run', el).onclick = async () => {
    const ids = [...el.querySelectorAll('[data-cand]:checked')].map((x) => x.dataset.cand);
    const criteria = [...el.querySelectorAll('[data-crit]:checked')].map((x) => x.dataset.crit);
    if (!ids.length) return toast('Pick at least one answer');
    if (!criteria.length) return toast('Pick at least one criterion');
    const btn = $('#eval-run', el); btn.disabled = true; btn.textContent = info.evaluator === 'jev' ? 'Jev is scoring…' : 'Judging…';
    $('#eval-out', el).innerHTML = '<div class="muted">Scoring every answer against the rubric…</div>';
    try {
      const ev = await api('POST', '/api/evaluations', { response_ids: ids, criteria });
      S.conv.evaluations = [...(S.conv.evaluations || []), ev];
      $('#eval-out', el).innerHTML = evaluationHTML(ev);
      ids.forEach((id) => renderCard(id));
      btn.textContent = 'Run again';
    } catch (e) { $('#eval-out', el).innerHTML = `<div class="err-box">${esc(e.message)}</div>`; btn.textContent = 'Run evaluation'; }
    btn.disabled = false;
  };
  el.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-eval-final]'); if (!f) return;
    try { const row = await api('POST', `/api/responses/${f.dataset.evalFinal}/final`); Object.assign(S.resp.get(row.id), row); renderCard(row.id); toast('Marked as final'); close(); } catch (err) { fail(err); }
  });
}

function evaluationHTML(ev) {
  const res = ev.results;
  const name = (rid) => shortName(S.resp.get(rid)?.model_id || res.find((r) => r.response_id === rid)?.model_id || '?');
  const rec = ev.recommended_response;
  const human = ev.human_picks || [];
  const agree = human.length ? (human.includes(rec) ? '✓ Matches the answer you picked.' : `You picked ${human.map(name).join(', ')}, so you and the evaluator disagree here.`) : '';
  const best = (k) => { const vals = res.map((r) => r.scores[k]?.value).filter((v) => v != null); return vals.length > 1 && new Set(vals).size > 1 ? Math.max(...vals) : null; };
  const cell = (r, k) => {
    const v = r.scores[k]?.value, c = r.scores[k]?.confidence;
    if (v == null) return '<td class="muted">—</td>';
    return `<td class="${best(k) === v ? 'best' : ''}" title="${v.toFixed(2)} of 4${c != null ? ` · confidence ${Math.round(c * 100)}%` : ''}">
      <div class="score"><span class="meter"><i style="width:${(v / 4) * 100}%"></i></span>${v.toFixed(1)}</div></td>`;
  };
  return `<div class="eval-rec"><div class="eval-rec-label">Evaluator recommendation</div>
      <div class="eval-rec-main"><span class="dot" style="background:${laneColor(S.resp.get(rec)?.model_id)}"></span><b>${esc(name(rec))}</b>
        ${evalOverall(ev, rec) != null ? `<span class="big">${Math.round(evalOverall(ev, rec))}</span><span class="muted">/100</span>` : ''}
        ${ev.recommended_confidence != null ? `<span class="tag">confidence ${Math.round(ev.recommended_confidence * 100)}%</span>` : ''}
        <button class="btn small" data-eval-final="${rec}">Use as final</button></div>
      ${agree ? `<div class="small">${agree}</div>` : ''}</div>
    <div class="cmp-wrap"><table class="cmp"><thead><tr><th></th>${res.map((r) => `<th><span class="dot" style="background:${laneColor(r.model_id)}"></span> ${esc(name(r.response_id))}${r.response_id === rec ? ' ⭐' : ''}</th>`).join('')}</tr></thead><tbody>
      ${ev.criteria.map((k) => `<tr><th scope="row">${esc(ev.criteria_labels[k] || k)}</th>${res.map((r) => cell(r, k)).join('')}</tr>`).join('')}
      <tr class="total"><th scope="row">Overall</th>${res.map((r) => `<td class="${r.response_id === rec ? 'best' : ''}"><b>${r.scores.overall?.value != null ? Math.round(r.scores.overall.value) : '—'}</b><span class="muted">/100</span></td>`).join('')}</tr>
      ${ev.probabilities ? `<tr><th scope="row">Head-to-head pick</th>${res.map((r) => `<td>${ev.probabilities[r.response_id] != null ? `${Math.round(ev.probabilities[r.response_id] * 100)}%` : '—'}</td>`).join('')}</tr>` : ''}
    </tbody></table></div>
    <div class="muted small">Scores run from 0 (Poor) to 4 (Excellent). Hover a cell to see the evaluator's confidence. Evaluated by ${esc(ev.evaluator === 'jev' ? 'Jev' : 'fallback judge')} (${esc(ev.evaluator_model || '')})
      in ${fmtMs(ev.latency_ms)}${ev.input_tokens != null ? ` using ${fmtTokens(ev.input_tokens + (ev.output_tokens || 0))} tokens` : ''}.</div>`;
}

// ---------- compare models ----------
let compareSel = [];
const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const vendorName = (m) => (m.name.includes(':') ? m.name.split(':')[0] : m.id.split('/')[0]);

function renderCompare() {
  closeStream();
  S.conv = null; S.resp = new Map(); renderSidebar(); renderSkills();
  try { compareSel = JSON.parse(sessionStorage.getItem('compareSel') || '[]'); } catch {}
  if (!compareSel.length && S.me.preferences.last_models?.length) compareSel = S.me.preferences.last_models.slice(0, 4);
  $('#main').innerHTML = `${mobileTop('Compare models')}<div class="new-wrap"><div class="new-inner compare">
    <div><h1>Compare models</h1><p class="muted" style="margin:4px 0 0">Catalog facts side by side, plus how each model has actually done in your own chats.</p></div>
    <div id="cmp-picker"></div>
    <div id="cmp-result"></div>
    <div id="cmp-board"></div>
  </div></div>`;
  mountPicker($('#cmp-picker'), { selected: compareSel, max: 4, onChange: (sel) => { compareSel = sel; try { sessionStorage.setItem('compareSel', JSON.stringify(sel)); } catch {} loadCompare(); } });
  loadCompare();
}

const loadCompare = debounce(async () => {
  const box = $('#cmp-result'); if (!box) return;
  box.innerHTML = compareSel.length ? '<div class="muted">Loading…</div>' : '<div class="muted">Pick up to 4 models above to compare them.</div>';
  try {
    const data = await api('GET', `/api/compare?models=${encodeURIComponent(compareSel.join(','))}`);
    if (compareSel.length) box.innerHTML = compareTableHTML(data); else box.innerHTML = '<div class="muted">Pick up to 4 models above to compare them.</div>';
    $('#cmp-board').innerHTML = leaderboardHTML(data.leaderboard);
    const start = $('#cmp-start'); if (start) start.onclick = () => { newState.selected = compareSel.slice(0, S.maxModels); location.hash = '#/new'; };
    $('#cmp-board').onclick = (e) => { const b = e.target.closest('[data-cmp-add]'); if (b && compareSel.length < 4 && !compareSel.includes(b.dataset.cmpAdd)) { $('#cmp-picker')._setSelected([...compareSel, b.dataset.cmpAdd]); } };
  } catch (e) { box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; }
}, 150);

function compareTableHTML({ models, head_to_head }) {
  // Each row: label, value per model, numeric value for "best" highlighting, and which direction wins.
  const C = (m) => m.catalog || {}, U = (m) => m.usage || {};
  const rows = [
    ['section', 'Catalog'],
    ['Provider', (m) => esc(C(m).name ? vendorName(C(m)) : '—')],
    ['Price per 1M tokens', (m) => (C(m).free ? '<span class="tag free">FREE</span>' : C(m).prompt_price != null ? `$${perM(C(m).prompt_price)} in · $${perM(C(m).completion_price)} out` : '—'),
      (m) => (C(m).prompt_price != null ? C(m).prompt_price + C(m).completion_price : null), 'low'],
    ['Context window', (m) => (C(m).context_length ? `${fmtTokens(C(m).context_length)} tokens` : '—'), (m) => C(m).context_length, 'high'],
    ['Max answer length', (m) => (C(m).max_output ? `${fmtTokens(C(m).max_output)} tokens` : '—'), (m) => C(m).max_output, 'high'],
    ['Strengths', (m) => (C(m).tags || []).filter((t) => t !== 'free').map((t) => `<span class="tag">${t}</span>`).join(' ') || '—'],
    ['Estimated rank among free models', (m) => (C(m).free_rank ? `#${C(m).free_rank}` : C(m).free ? '—' : 'paid'), (m) => C(m).free_rank, 'low'],
    ['Right now', (m) => ({ ok: '<span class="tag ok">responding</span>', busy: '<span class="tag busy">busy</span>', blocked: '<span class="tag busy">unavailable</span>' }[C(m).health] || '<span class="muted">not checked</span>')],
    ['section', 'In your chats'],
    ['Answers', (m) => U(m).answers ?? 0],
    ['Picked when compared', (m) => (U(m).shown_in_comparisons ? `${pct(U(m).pick_rate)} <span class="muted small">(${U(m).chosen} of ${U(m).shown_in_comparisons})</span>` : '<span class="muted">no data</span>'),
      (m) => (U(m).shown_in_comparisons >= 3 ? U(m).pick_rate : null), 'high'],
    ['Average response time', (m) => fmtMs(U(m).avg_latency_ms), (m) => U(m).avg_latency_ms, 'low'],
    ['Time to first token', (m) => fmtMs(U(m).avg_first_token_ms), (m) => U(m).avg_first_token_ms, 'low'],
    ['Average answer length', (m) => (U(m).avg_output_tokens != null ? `${fmtTokens(Math.round(U(m).avg_output_tokens))} tokens` : '—')],
    ['Average cost per answer', (m) => fmtCost(U(m).avg_cost), (m) => U(m).avg_cost, 'low'],
    ['Total spent', (m) => fmtCost(U(m).total_cost ?? null)],
    ['Failed or rate limited', (m) => (U(m).answers ? `${pct(U(m).failure_rate)} <span class="muted small">(${(U(m).failed || 0) + (U(m).rate_limited || 0)} of ${U(m).answers})</span>` : '—'),
      (m) => (U(m).answers ? U(m).failure_rate : null), 'low'],
  ];
  const head = `<tr><th></th>${models.map((m) => `<th><span class="dot" style="background:var(--lane-${compareSel.indexOf(m.id) % 6})"></span> ${esc(shortName(m.id))}<div class="model-id">${esc(m.id)}</div></th>`).join('')}</tr>`;
  const body = rows.map((r) => {
    if (r[0] === 'section') return `<tr class="sec"><td colspan="${models.length + 1}">${r[1]}</td></tr>`;
    const [label, fmt, val, dir] = r;
    let best = null;
    if (val && models.length > 1) {
      const nums = models.map(val).filter((v) => v != null && !Number.isNaN(v));
      if (nums.length > 1 && new Set(nums).size > 1) best = dir === 'low' ? Math.min(...nums) : Math.max(...nums);
    }
    return `<tr><th scope="row">${label}</th>${models.map((m) => `<td class="${best != null && val(m) === best ? 'best' : ''}">${fmt(m)}</td>`).join('')}</tr>`;
  }).join('');
  const h2h = head_to_head.filter((p) => p.together);
  const h2hHTML = models.length < 2 ? '' : `<h2 class="cmp-h">Head to head</h2>
    <p class="muted small" style="margin:0 0 8px">Questions where both models answered, and whose answer you picked (Use as context, Continue, Save or Final).</p>
    ${h2h.length ? `<div class="h2h">${h2h.map((p) => {
      const total = p.a_wins + p.b_wins || 1;
      return `<div class="h2h-row"><span class="h2h-name">${esc(shortName(p.a))}</span>
        <div class="h2h-bar" title="${p.a_wins} vs ${p.b_wins}"><i style="width:${(p.a_wins / total) * 100}%;background:var(--lane-${compareSel.indexOf(p.a) % 6})"></i><i style="width:${(p.b_wins / total) * 100}%;background:var(--lane-${compareSel.indexOf(p.b) % 6})"></i></div>
        <span class="h2h-name r">${esc(shortName(p.b))}</span>
        <span class="h2h-score"><b>${p.a_wins}</b> – <b>${p.b_wins}</b> <span class="muted small">· ${p.both_picked} both · ${p.neither_picked} neither · ${p.together} together</span></span></div>`;
    }).join('')}</div>` : '<p class="muted">These models have not answered the same question in your chats yet. Start a chat with them to build up a comparison.</p>'}`;
  return `<div class="cmp-wrap"><table class="cmp"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    <p class="muted small">Green marks the best value in a row. "Picked when compared" needs at least 3 comparisons before it is highlighted. The rank is an estimate from size, reasoning support, context, recency and live health.</p>
    ${h2hHTML}
    <div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn primary" id="cmp-start" ${models.length ? '' : 'disabled'}>Start a chat with ${models.length > S.maxModels ? `the first ${S.maxModels}` : 'these models'}</button></div>`;
}

function leaderboardHTML(board) {
  if (!board.length) return `<h2 class="cmp-h">Your leaderboard</h2><p class="muted">Once you use models in chats, they are ranked here by how often you pick their answers.</p>`;
  return `<h2 class="cmp-h">Your leaderboard</h2>
    <p class="muted small" style="margin:0 0 8px">Every model you have used, ranked by how often you picked its answer when it was shown next to others. Models with fewer than 3 comparisons are listed after the ranked ones.</p>
    <div class="cmp-wrap"><table class="cmp board"><thead><tr><th>#</th><th>Model</th><th>Picked when compared</th><th>Answers</th><th>Avg time</th><th>Failed</th><th></th></tr></thead><tbody>
    ${board.map((u, i) => `<tr><td>${u.shown_in_comparisons >= 3 ? i + 1 : '–'}</td><td><b>${esc(shortName(u.model_id))}</b><div class="model-id">${esc(u.model_id)}</div></td>
      <td>${u.shown_in_comparisons ? `<div class="meter"><i style="width:${Math.round((u.pick_rate || 0) * 100)}%"></i></div>${pct(u.pick_rate)} <span class="muted small">(${u.chosen}/${u.shown_in_comparisons})</span>` : '<span class="muted">—</span>'}</td>
      <td>${u.answers}</td><td>${fmtMs(u.avg_latency_ms)}</td><td>${pct(u.failure_rate)}</td>
      <td>${compareSel.includes(u.model_id) ? '' : `<button class="btn small ghost" data-cmp-add="${esc(u.model_id)}">+ Compare</button>`}</td></tr>`).join('')}
    </tbody></table></div>`;
}


// ---------- metrics (for AI PMs) ----------
let metricsState = { days: 30, conversation: '' };
const fmtNum = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const ERROR_LABEL = { rate_limit: 'Rate limited', insufficient_credits: 'No credits', context_limit: 'Context too long', invalid_model: 'Model unavailable', forbidden: 'Refused for this app',
  timeout: 'Timed out', network: 'Network error', provider_unavailable: 'Provider down', safety: 'Safety filter', empty: 'Empty answer', truncated: 'Cut off at max length', interrupted: 'Server restart', no_key: 'No API key', stopped: 'Stopped by user', unknown: 'Other' };

function renderMetrics() {
  closeStream();
  S.conv = null; S.resp = new Map(); renderSidebar(); renderSkills();
  $('#main').innerHTML = `${mobileTop('Metrics')}<div class="new-wrap"><div class="new-inner metrics viz-root">
    <div class="m-head"><div><h1>Metrics</h1><p class="muted" style="margin:4px 0 0">Usage, speed, cost, reliability and quality across your chats.</p></div>
      <div class="m-filters">
        <div class="seg" role="group" aria-label="Time range">${[[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All time']].map(([d, l]) => `<button data-days="${d}" class="${metricsState.days === d ? 'on' : ''}">${l}</button>`).join('')}</div>
        <select class="select" id="m-conv" aria-label="Chat"><option value="">All chats</option>${S.convs.map((c) => `<option value="${c.id}" ${metricsState.conversation === c.id ? 'selected' : ''}>${esc(c.title.slice(0, 50))}</option>`).join('')}</select>
      </div></div>
    <div id="m-body"><div class="muted">Loading…</div></div></div></div>`;
  $('.m-filters').onclick = (e) => { const b = e.target.closest('[data-days]'); if (!b) return; metricsState.days = Number(b.dataset.days); document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b)); loadMetrics(); };
  $('#m-conv').onchange = (e) => { metricsState.conversation = e.target.value; loadMetrics(); };
  loadMetrics();
}

let metricsData = null;
async function loadMetrics() {
  const body = $('#m-body'); if (!body) return;
  try {
    metricsData = await api('GET', `/api/metrics?days=${metricsState.days}&tz=${new Date().getTimezoneOffset()}${metricsState.conversation ? `&conversation=${metricsState.conversation}` : ''}`);
    drawMetrics();
  } catch (e) { body.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; }
}
window.addEventListener('resize', debounce(() => { if (location.hash.startsWith('#/metrics') && metricsData) drawMetrics(); }, 200));

function tile(label, value, sub = '') { return `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}</div>`; }

function drawMetrics() {
  const d = metricsData, s = d.summary, body = $('#m-body');
  if (!s.answers) {
    body.innerHTML = `<div class="empty-thread"><h2>No chat data yet</h2><p>Usage metrics appear once models have answered in this time range.</p></div>
      <section class="m-card" id="evals-card"><div class="m-card-head"><h2>AI quality: agent eval suite</h2><button class="btn small" id="eval-run-btn">Run evals</button></div><div id="evals-body" class="muted small">Loading…</div></section>
      <section class="m-card" id="checks-card"><div class="m-card-head"><h2>App health check</h2><button class="btn small" id="check-run-btn">Run check</button></div><div id="checks-body" class="muted small">Loading…</div></section>
      <section class="m-card"><div class="m-card-head"><h2>Feedback</h2><button class="btn small ghost" id="fb-new">+ New</button></div><div id="fb-body" class="small muted">Loading…</div></section>`;
    loadEvals(); loadChecks(); loadFeedbackInbox(); $('#fb-new').onclick = () => openFeedback(); return;
  }
  const failRate = s.answers ? (s.failed + s.rate_limited) / s.answers : null;
  body.innerHTML = `
    <section class="tiles">
      ${tile('Messages', fmtNum(s.messages), `${s.conversations} chat${s.conversations === 1 ? '' : 's'} · ${pct(s.multi_model_share)} multi-model`)}
      ${tile('Model calls', fmtNum(s.model_calls), `${s.answers} answers · ${(s.avg_models_per_message || 0).toFixed(1)} models per message`)}
      ${tile('Tokens', fmtNum(s.tokens_in + s.tokens_out), `${fmtNum(s.tokens_in)} in · ${fmtNum(s.tokens_out)} out`)}
      ${tile('Cost', fmtCost(s.cost), s.personal_key_share != null ? `${pct(s.personal_key_share)} on your own key` : '')}
      ${tile('Response time', fmtMs(s.latency_p50), `p50 · p95 ${fmtMs(s.latency_p95)}`)}
      ${tile('Time to first token', fmtMs(s.ttft_p50), `p50 · p95 ${fmtMs(s.ttft_p95)}`)}
      ${tile('Output speed', s.throughput ? `${Math.round(s.throughput)} tok/s` : '—', 'while streaming')}
      ${tile('Failure rate', pct(failRate), `${s.rate_limited} rate limited · ${s.failed} failed · ${s.auto_switches} auto-switched`)}
      ${tile('Picks', fmtNum(s.picks), `use as context, continue, save, final · ${s.thumbs_up} 👍 ${s.thumbs_down} 👎`)}
      ${tile('Evaluator agreement', s.evaluator_agreement != null ? pct(s.evaluator_agreement) : '—', s.evaluator_agreement_n ? `${s.evaluations} evaluations, ${s.evaluator_agreement_n} with your pick` : `${s.evaluations} evaluations`)}
    </section>
    <section class="m-card"><div class="m-card-head"><h2>Tokens per day</h2><div class="legend"><span><i style="background:var(--series-1)"></i>Input</span><span><i style="background:var(--series-2)"></i>Output</span></div>
      <button class="btn small ghost" data-table="daily">Table</button></div><div class="chart" id="ch-daily"></div><div class="m-table" id="tb-daily" hidden></div></section>
    <section class="m-card"><div class="m-card-head"><h2>Response time by model</h2><div class="legend"><span><i class="dot-l"></i>p50 (typical)</span><span><i class="dot-l hollow"></i>p95 (slow end)</span></div></div>
      <div class="chart" id="ch-latency"></div></section>
    <section class="m-card"><div class="m-card-head"><h2>By model</h2><button class="btn small ghost" id="csv">Export CSV</button></div>
      <div class="cmp-wrap">${modelTableHTML(d.per_model)}</div>
      <p class="muted small">Pick rate counts only answers shown next to another finished answer. Output speed is tokens per second after the first token.</p></section>
    <section class="m-card"><div class="m-card-head"><h2>Evaluator scores by model</h2><span class="muted small">${d.evaluator === 'jev' ? 'Jev' : 'Fallback judge'} · average score, 0 to 4</span></div>
      <div id="ch-heat">${heatmapHTML(d.eval_matrix)}</div></section>
    ${d.errors.length ? `<section class="m-card"><div class="m-card-head"><h2>Why answers failed</h2></div><div class="chart" id="ch-errors"></div></section>` : ''}
    <section class="m-card" id="evals-card"><div class="m-card-head"><h2>AI quality: agent eval suite</h2><button class="btn small" id="eval-run-btn">Run evals</button></div><div id="evals-body" class="muted small">Loading…</div></section>
    <section class="m-card" id="checks-card"><div class="m-card-head"><h2>App health check</h2><button class="btn small" id="check-run-btn">Run check</button></div><div id="checks-body" class="muted small">Loading…</div></section>
    <section class="m-card"><div class="m-card-head"><h2>Feedback</h2><button class="btn small ghost" id="fb-new">+ New</button></div><div id="fb-body" class="small muted">Loading…</div></section>`;
  loadEvals(); loadChecks(); loadFeedbackInbox(); $('#fb-new').onclick = () => openFeedback();
  drawDaily(d.daily); drawLatency(d.per_model); if (d.errors.length) drawErrors(d.errors);
  body.querySelector('[data-table="daily"]').onclick = (e) => { const t = $('#tb-daily'); t.hidden = !t.hidden; $('#ch-daily').hidden = !t.hidden; e.target.textContent = t.hidden ? 'Table' : 'Chart'; };
  $('#tb-daily').innerHTML = `<table class="cmp"><thead><tr><th>Day</th><th>Answers</th><th>Input tokens</th><th>Output tokens</th><th>Failures</th><th>Cost</th></tr></thead><tbody>${d.daily.filter((x) => x.answers).map((x) => `<tr><td>${x.day}</td><td>${x.answers}</td><td>${fmtNum(x.tokens_in)}</td><td>${fmtNum(x.tokens_out)}</td><td>${x.failures}</td><td>${fmtCost(x.cost)}</td></tr>`).join('')}</tbody></table>`;
  $('#csv').onclick = () => downloadCSV(d.per_model);
}

const SUITE_INFO = {
  planner: ['Planner', 'Turns plain-English requests into the right tracker'],
  relevance: ['Relevance screener', 'Keeps matching jobs and news, drops the rest (includes your 👍/👎)'],
  page: ['Page judge', 'Decides if a condition is true on a page'],
  price: ['Price reader', 'Finds the current price on a product page'],
};
let evalPoll = null;
async function loadEvals() {
  const box = $('#evals-body'); if (!box) return;
  try {
    const d = await api('GET', '/api/evals');
    const btn = $('#eval-run-btn');
    btn.disabled = !!d.running; btn.textContent = d.running ? 'Running…' : 'Run evals';
    btn.onclick = async () => { try { await api('POST', '/api/evals/run'); toast('Evaluation started. It takes about 2 minutes.'); loadEvals(); } catch (e) { fail(e); } };
    clearTimeout(evalPoll); if (d.running) evalPoll = setTimeout(loadEvals, 5000);
    const run = d.latest?.runs?.[0];
    if (!run) { box.innerHTML = `No eval results yet. Run the suite to measure the agents' AI steps against labeled test cases.${d.running ? `<pre class="eval-log">${esc(d.running.log.join('\n'))}</pre>` : ''}`; return; }
    const fmtV = (k, v) => (v == null ? '—' : /rate|accuracy|precision|recall|f1/.test(k) ? pct(v) : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v);
    box.className = '';
    box.innerHTML = `<div class="small muted" style="margin-bottom:6px">Last run ${ago(d.latest.run_at)} · ${esc(run.label)} · ${d.feedback_cases} cases from your feedback · ${d.latest.passed ? '<span class="good">✓ all gates passed</span>' : '<span class="bad">✗ a gate failed</span>'}</div>
      <div class="cmp-wrap"><table class="cmp"><thead><tr><th>AI step</th><th>Key metric</th><th>Gate</th><th>Other metrics</th><th>Failures</th></tr></thead><tbody>
      ${Object.entries(run.suites).map(([k, v]) => `<tr><td><b>${SUITE_INFO[k]?.[0] || k}</b><div class="muted small">${SUITE_INFO[k]?.[1] || ''}</div></td>
        <td class="${v.gate?.passed ? 'best' : ''}"><b>${fmtV(v.gate?.metric, v.gate?.value)}</b> <span class="muted small">${esc(v.gate?.metric || '')}</span></td>
        <td>${v.gate?.passed ? '<span class="good">✓ pass</span>' : '<span class="bad">✗ fail</span>'} <span class="muted small">≥ ${fmtV(v.gate?.metric, v.gate?.min)}</span></td>
        <td class="small">${Object.entries(v.metrics || {}).filter(([m]) => m !== v.gate?.metric && !/_ms$/.test(m)).map(([m, x]) => `${esc(m.replace(/_/g, ' '))} ${fmtV(m, x)}`).join(' · ')}</td>
        <td class="small">${(v.failures || []).length ? `<details><summary>${v.failures.length}</summary>${v.failures.slice(0, 8).map((f) => `<div class="muted">✗ ${esc(f.title || f.id || '')} ${f.expected !== undefined ? `(expected ${esc(String(f.expected))}, got ${esc(String(f.got ?? (f.score != null ? Math.round(f.score * 100) + '%' : '—')))})` : ''}${f.wrong ? ` ${esc(f.wrong.join('; '))}` : ''}</div>`).join('')}</details>` : '0'}</td></tr>`).join('')}
      </tbody></table></div>
      ${d.history.length > 1 ? `<div class="small muted" style="margin-top:6px">History: ${d.history.map((h) => `<span title="${new Date(h.run_at).toLocaleString()}">${h.passed ? '🟢' : '🔴'}</span>`).join(' ')} (newest first)</div>` : ''}
      ${d.running ? `<pre class="eval-log">${esc(d.running.log.join('\n'))}</pre>` : ''}`;
  } catch (e) { box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; }
}

function modelTableHTML(rows) {
  const maxTok = Math.max(1, ...rows.map((r) => r.tokens_in + r.tokens_out));
  return `<table class="cmp"><thead><tr><th>Model</th><th>Answers</th><th>Tokens (in / out)</th><th>Avg answer</th><th>p50 time</th><th>p95 time</th><th>First token</th><th>Speed</th><th>Cost</th><th>Failed</th><th>Rate limited</th><th>Pick rate</th><th>Eval score</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><b>${esc(shortName(r.model_id))}</b><div class="model-id">${esc(r.model_id)}</div></td>
      <td>${r.answers}</td>
      <td><span class="meter"><i style="width:${((r.tokens_in + r.tokens_out) / maxTok) * 100}%"></i></span>${fmtNum(r.tokens_in)} / ${fmtNum(r.tokens_out)}</td>
      <td>${r.avg_out_tokens != null ? `${fmtNum(r.avg_out_tokens)} tok` : '—'}</td>
      <td>${fmtMs(r.latency_p50)}</td><td>${fmtMs(r.latency_p95)}</td><td>${fmtMs(r.ttft_p50)}</td>
      <td>${r.throughput ? `${Math.round(r.throughput)} tok/s` : '—'}</td><td>${fmtCost(r.cost)}</td>
      <td>${pct(r.failure_rate)}</td><td>${pct(r.rate_limit_rate)}</td>
      <td>${r.shown_in_comparisons ? `${pct(r.pick_rate)} <span class="muted small">(${r.chosen}/${r.shown_in_comparisons})</span>` : '—'}</td>
      <td>${r.eval_overall != null ? `${Math.round(r.eval_overall)}<span class="muted">/100</span> <span class="muted small">(${r.evaluated}${r.eval_wins ? `, ${r.eval_wins} ★` : ''})</span>` : '—'}</td></tr>`).join('')}
  </tbody></table>`;
}

function downloadCSV(rows) {
  const cols = ['model_id', 'answers', 'completed', 'tokens_in', 'tokens_out', 'avg_out_tokens', 'latency_p50', 'latency_p95', 'ttft_p50', 'throughput', 'cost', 'failure_rate', 'rate_limit_rate', 'shown_in_comparisons', 'chosen', 'pick_rate', 'eval_overall', 'evaluated', 'eval_wins'];
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => (r[c] == null ? '' : typeof r[c] === 'number' ? +r[c].toFixed(4) : `"${String(r[c]).replace(/"/g, '""')}"`)).join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `model-metrics-${metricsState.days || 'all'}d.csv`; a.click(); URL.revokeObjectURL(a.href);
}

// Shared tooltip
function tip(html, x, y) {
  let t = document.getElementById('viz-tip');
  if (!t) { t = document.createElement('div'); t.id = 'viz-tip'; document.body.appendChild(t); }
  if (html == null) { t.style.opacity = 0; return; }
  t.innerHTML = html; t.style.opacity = 1;
  const r = t.getBoundingClientRect();
  t.style.left = `${Math.min(window.innerWidth - r.width - 8, x + 14)}px`; t.style.top = `${Math.max(8, y - r.height - 10)}px`;
}
const niceMax = (v) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1); };
// Bar with a 4px rounded data end and a square baseline.
const barPath = (x, y, w, h, r = 4) => { r = Math.min(r, h, w / 2); return h <= 0 ? '' : `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };

function drawDaily(daily) {
  const el = $('#ch-daily'); const W = el.clientWidth || 700, H = 220, m = { l: 48, r: 8, t: 10, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(...daily.map((d) => d.tokens_in + d.tokens_out), 1));
  const band = iw / daily.length, bw = Math.max(2, Math.min(24, band * 0.7));
  const y = (v) => m.t + ih - (v / max) * ih;
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const labelEvery = Math.ceil(daily.length / Math.max(2, Math.floor(iw / 70)));
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Input and output tokens per day">
    ${ticks.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${m.l - 6}" y="${y(t) + 4}" class="axis" text-anchor="end">${fmtNum(t)}</text>`).join('')}
    ${daily.map((d, i) => {
      const x = m.l + i * band + (band - bw) / 2;
      const hIn = (d.tokens_in / max) * ih, hOut = (d.tokens_out / max) * ih;
      const gap = d.tokens_in && d.tokens_out ? 2 : 0;
      // Output sits on input with a 2px surface gap; only the top segment gets the rounded end.
      const inPath = d.tokens_out ? `M${x},${m.t + ih}V${m.t + ih - hIn}H${x + bw}V${m.t + ih}Z` : barPath(x, m.t + ih - hIn, bw, hIn);
      return `<g class="hit" data-i="${i}"><rect x="${m.l + i * band}" y="${m.t}" width="${band}" height="${ih}" fill="transparent"/>
        ${hIn ? `<path d="${inPath}" fill="var(--series-1)"/>` : ''}
        ${hOut ? `<path d="${barPath(x, m.t + ih - hIn - gap - hOut, bw, hOut)}" fill="var(--series-2)"/>` : ''}</g>
        ${i % labelEvery === 0 ? `<text x="${m.l + i * band + band / 2}" y="${H - 8}" class="axis" text-anchor="middle">${d.day.slice(5)}</text>` : ''}`;
    }).join('')}
    <line x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}" class="baseline"/></svg>`;
  el.querySelectorAll('.hit').forEach((g) => {
    const d = daily[g.dataset.i];
    g.onmousemove = (e) => tip(`<b>${d.day}</b><div><i class="sw" style="background:var(--series-1)"></i>Input ${fmtNum(d.tokens_in)}</div><div><i class="sw" style="background:var(--series-2)"></i>Output ${fmtNum(d.tokens_out)}</div><div class="muted">${d.answers} answers · ${d.failures} failed · ${fmtCost(d.cost)}</div>`, e.clientX, e.clientY);
    g.onmouseleave = () => tip(null);
  });
}

function drawLatency(rows) {
  const data = rows.filter((r) => r.latency_p50 != null).slice(0, 12);
  const el = $('#ch-latency');
  if (!data.length) { el.innerHTML = '<p class="muted">No finished answers yet.</p>'; return; }
  const W = el.clientWidth || 700, rowH = 30, m = { l: Math.min(220, W * 0.32), r: 60, t: 6, b: 24 };
  const H = m.t + m.b + rowH * data.length, iw = W - m.l - m.r;
  const max = niceMax(Math.max(...data.map((r) => r.latency_p95 || r.latency_p50)));
  const x = (v) => m.l + (v / max) * iw;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Typical and slow-end response time per model">
    ${ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${m.t}" y2="${H - m.b}" class="grid"/><text x="${x(t)}" y="${H - 6}" class="axis" text-anchor="middle">${fmtMs(t)}</text>`).join('')}
    ${data.map((r, i) => { const cy = m.t + i * rowH + rowH / 2; return `<g class="hit" data-i="${i}">
      <rect x="0" y="${cy - rowH / 2}" width="${W}" height="${rowH}" fill="transparent"/>
      <text x="${m.l - 10}" y="${cy + 4}" class="label" text-anchor="end">${esc(shortName(r.model_id).slice(0, 28))}</text>
      ${r.latency_p95 != null ? `<line x1="${x(r.latency_p50)}" x2="${x(r.latency_p95)}" y1="${cy}" y2="${cy}" class="range"/>` : ''}
      ${r.latency_p95 != null ? `<circle cx="${x(r.latency_p95)}" cy="${cy}" r="5" class="p95"/>` : ''}
      <circle cx="${x(r.latency_p50)}" cy="${cy}" r="5" class="p50"/>
      <text x="${x(r.latency_p95 ?? r.latency_p50) + 10}" y="${cy + 4}" class="axis">${fmtMs(r.latency_p50)}</text></g>`; }).join('')}
  </svg>`;
  el.querySelectorAll('.hit').forEach((g) => {
    const r = data[g.dataset.i];
    g.onmousemove = (e) => tip(`<b>${esc(shortName(r.model_id))}</b><div>Typical (p50): ${fmtMs(r.latency_p50)}</div><div>Slow end (p95): ${fmtMs(r.latency_p95)}</div><div>First token (p50): ${fmtMs(r.ttft_p50)}</div><div class="muted">${r.completed} finished answers</div>`, e.clientX, e.clientY);
    g.onmouseleave = () => tip(null);
  });
}

function heatmapHTML(mx) {
  if (!mx.rows.length) return '<p class="muted">No evaluations yet. Use ⚖ Evaluate answers under any message with two or more answers.</p>';
  // Sequential one-hue ramp (blue), light = low, dark = high; text ink switches for contrast.
  const steps = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5'];
  const bucket = (v) => Math.min(4, Math.max(0, Math.floor(v)));
  return `<div class="cmp-wrap"><table class="cmp heat"><thead><tr><th>Model</th>${mx.criteria.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th>Evaluations</th></tr></thead><tbody>
    ${mx.rows.map((r) => `<tr><td><b>${esc(shortName(r.model_id))}</b></td>${mx.criteria.map((c) => { const v = r.values[c.key]; return v == null ? '<td class="muted">—</td>'
      : `<td class="hcell ${bucket(v) >= 3 ? 'dark' : ''}" style="background:var(${steps[bucket(v)]})" title="${esc(shortName(r.model_id))} · ${esc(c.label)}: ${v.toFixed(2)} of 4">${v.toFixed(1)}</td>`; }).join('')}<td>${r.n}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="heat-legend small muted">0 Poor ${steps.map((st) => `<i style="background:var(${st})"></i>`).join('')} 4 Excellent</div>`;
}

function drawErrors(errors) {
  const el = $('#ch-errors'); const W = el.clientWidth || 700, rowH = 26, m = { l: 170, r: 50, t: 4, b: 4 };
  const H = m.t + m.b + rowH * errors.length, iw = W - m.l - m.r, max = Math.max(...errors.map((e) => e.n));
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Failure reasons">${errors.map((e, i) => { const y = m.t + i * rowH + 5, w = Math.max(2, (e.n / max) * iw);
    return `<text x="${m.l - 10}" y="${y + 12}" class="label" text-anchor="end">${esc(ERROR_LABEL[e.kind] || e.kind)}</text>
      <path d="M${m.l},${y}H${m.l + w - 4}Q${m.l + w},${y} ${m.l + w},${y + 4}V${y + 12}Q${m.l + w},${y + 16} ${m.l + w - 4},${y + 16}H${m.l}Z" fill="var(--series-1)"><title>${e.n}</title></path>
      <text x="${m.l + w + 8}" y="${y + 12}" class="axis">${e.n}</text>`; }).join('')}</svg>`;
}


// ---------- price-watch agent ----------
const INTERVALS = [[60, '24 times a day (hourly)'], [120, '12 times a day'], [180, '8 times a day'], [240, '6 times a day'], [288, '5 times a day'], [360, '4 times a day'], [480, '3 times a day'], [720, 'Twice a day'], [1440, 'Once a day']];
// "5 times a day", "twice daily", "hourly", "every 6 hours" -> the nearest supported interval in minutes.
function parseFrequency(t) {
  let perDay = null;
  const m = t.match(/(\d+)\s*(?:x|times)\s*(?:a|per|each)?\s*day/i); if (m) perDay = Number(m[1]);
  else if (/\btwice\s+(?:a\s+|per\s+)?day|twice\s+daily\b/i.test(t)) perDay = 2;
  else if (/\b(?:thrice|three times)\s+(?:a|per)\s+day/i.test(t)) perDay = 3;
  else if (/\bhourly|every hour\b/i.test(t)) perDay = 24;
  else if (/\bonce\s+(?:a|per)\s+day|\bdaily\b/i.test(t)) perDay = 1;
  const h = t.match(/every\s+(\d+)\s*(?:h|hrs?|hours?)\b/i); if (h) perDay = 24 / Number(h[1]);
  if (!perDay || perDay <= 0) return null;
  const want = 1440 / perDay;
  return INTERVALS.map(([v]) => v).reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
}
const money = (p, c) => (p == null ? '—' : `${c ? `${c} ` : ''}${Number(p).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const ago = (ms) => { if (!ms) return 'never'; const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const until = (ms) => { const m = Math.round((ms - Date.now()) / 60000); return m <= 1 ? 'within a minute' : m < 60 ? `in ${m} min` : `in ${Math.round(m / 60)} h`; };
const WATCH_INTENT = /\b(price|cheaper|drops?|deal|discount|sale|track|watch|alert|notify|remind)\b/i;
const URL_RE = /https?:\/\/[^\s<>"')]+/i;

function openWatchModal({ url = '', target = null, conversationId = null, interval = null } = {}) {
  let preview = null;
  const { el, close } = modal({
    title: 'Watch a price',
    body: `<p class="muted small" style="margin:0">Paste a product link. The agent checks the page on a schedule and alerts you when the price drops. It identifies itself honestly, respects each site's robots.txt, and checks no more than once an hour.</p>
      <div class="key-row"><input class="input" id="w-url" type="url" placeholder="https://store.example.com/product" value="${esc(url)}"><button class="btn" id="w-preview">Check price</button></div>
      <div id="w-out"></div>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="w-create" disabled>Start watching</button>`,
  });
  const out = $('#w-out', el);
  const runPreview = async () => {
    const u = $('#w-url', el).value.trim(); if (!u) return;
    const b = $('#w-preview', el); b.disabled = true; b.textContent = 'Reading the page…'; out.innerHTML = '<div class="muted">Fetching the page and finding the price…</div>'; $('#w-create', el).disabled = true;
    try {
      preview = await api('POST', '/api/watches/preview', { url: u });
      const t = target ?? Math.floor(preview.price * 0.9 * 100) / 100;
      out.innerHTML = `<div class="w-preview"><div class="w-title">${esc(preview.title || new URL(preview.final_url).hostname)}</div>
          <div class="w-price">${preview.price_kind === 'from' ? '<span class="muted small">from </span>' : ''}${money(preview.price, preview.currency)}${preview.high_price ? `<span class="muted small"> to ${money(preview.high_price, preview.currency)} depending on the model</span>` : ''}</div>
          ${localCurrency() && preview.currency && preview.currency !== localCurrency() ? `<div class="small notice-inline">ℹ The store showed prices in ${esc(preview.currency)}. Stores often pick the currency from your network location (a VPN or proxy can change it). Alerts compare prices in this same currency.</div>` : ''}
          <div class="muted small">${preview.method === 'structured' ? 'Read from the page\'s product data.' : `Read from the page text by ${esc(shortName(preview.model || 'an AI model'))}. Double-check it matches the price you see.`}${preview.in_stock === false ? ' · ⚠ Out of stock' : ''}</div></div>
        <div class="w-cond"><div class="section-title">Alert me when</div>
          <label class="chk"><input type="radio" name="cond" value="below" checked> the price is at or below <input class="input inline" id="w-target" type="number" min="0" step="0.01" value="${t}"> ${esc(preview.currency || '')}</label>
          <label class="chk"><input type="radio" name="cond" value="drop_pct"> it drops by <input class="input inline" id="w-pct" type="number" min="1" max="99" value="10">% or more</label>
          <label class="chk"><input type="radio" name="cond" value="any_drop"> it drops at all</label></div>
        <label class="small">How often to check<select class="select" id="w-int">${INTERVALS.map(([v, l]) => `<option value="${v}" ${v === (interval || 288) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
      $('#w-create', el).disabled = false;
    } catch (e) {
      const sug = e.data?.suggestions || [];
      out.innerHTML = `<div class="err-box">${esc(e.message)}${sug.length ? `<div class="alts">${sug.map((x) => `<button class="btn small" data-sug="${esc(x.url)}" title="${esc(x.url)}">Use: ${esc(x.text || x.url)}</button>`).join('')}</div>` : ''}</div>`;
      out.querySelectorAll('[data-sug]').forEach((btn) => { btn.onclick = () => { $('#w-url', el).value = btn.dataset.sug; runPreview(); }; });
    }
    b.disabled = false; b.textContent = 'Check price';
  };
  $('#w-preview', el).onclick = runPreview;
  $('#w-url', el).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); runPreview(); } };
  $('#w-create', el).onclick = async () => {
    const cond = el.querySelector('[name=cond]:checked').value;
    const b = $('#w-create', el); b.disabled = true; b.textContent = 'Starting…';
    try {
      const w = await api('POST', '/api/watches', { url: $('#w-url', el).value.trim(), condition: cond, target_price: Number($('#w-target', el)?.value), drop_pct: Number($('#w-pct', el)?.value), interval_minutes: Number($('#w-int', el).value), conversation_id: conversationId });
      close();
      toast(w.already_met ? 'Watching. It is already at or below your target, so you will be alerted on the next new low.' : `Watching ${w.title || 'the link'}. You will be alerted when the price drops.`, 5000);
      ensureNotifyPermission();
      S.agentTab = 'prices'; if (location.hash.startsWith('#/agents')) loadAgents(); else location.hash = '#/agents';
    } catch (e) { out.insertAdjacentHTML('beforeend', `<div class="err-box">${esc(e.message)}</div>`); b.disabled = false; b.textContent = 'Start watching'; }
  };
  if (url) runPreview(); else setTimeout(() => $('#w-url', el)?.focus(), 0);
}

function localCurrency() {
  try { const c = new Intl.NumberFormat(navigator.language, { style: 'currency', currency: 'USD' }).resolvedOptions().locale; const region = (new Intl.Locale(c).maximize().region) || ''; return ({ US: 'USD', GB: 'GBP', IN: 'INR', CA: 'CAD', AU: 'AUD', MX: 'MXN', JP: 'JPY', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR' })[region] || null; } catch { return null; }
}
function ensureNotifyPermission() { try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {} }

function renderWatches() {
  closeStream();
  S.conv = null; S.resp = new Map(); renderSidebar(); renderSkills();
  $('#main').innerHTML = `${mobileTop('Price watches')}<div class="new-wrap"><div class="new-inner watches viz-root">
    <div class="m-head"><div><h1>Price watches</h1><p class="muted" style="margin:4px 0 0">An agent that checks product pages for you and alerts you when prices drop.</p></div>
      <button class="btn primary" id="w-add">+ Watch a link</button></div>
    <div id="w-notifs"></div><div id="w-list"><div class="muted">Loading…</div></div></div></div>`;
  $('#w-add').onclick = () => openWatchModal();
  loadWatches();
}

let watchesData = [];
async function loadWatches() {
  const list = $('#w-list'); if (!list) return;
  try {
    const [ws, notes] = await Promise.all([api('GET', '/api/watches'), api('GET', '/api/notifications')]);
    watchesData = ws;
    $('#w-notifs').innerHTML = notes.items.length ? `<section class="m-card"><div class="m-card-head"><h2>Alerts</h2>${notes.unread ? '<button class="btn small ghost" id="n-read">Mark all read</button>' : ''}</div>
      ${notes.items.slice(0, 8).map((n) => `<div class="notif ${n.read ? '' : 'unread'}"><span class="n-icon">${n.kind === 'price_drop' ? '▼' : '⚠'}</span>
        <div style="flex:1;min-width:0"><b>${esc(n.title)}</b><div class="small">${esc(n.body || '')}</div><div class="muted small">${ago(n.created_at)}${n.url ? ` · <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">Open page ↗</a>` : ''}</div></div></div>`).join('')}</section>` : '';
    const nr = $('#n-read'); if (nr) nr.onclick = async () => { await api('POST', '/api/notifications/read', {}); pollNotifications(); loadWatches(); };
    list.innerHTML = ws.length ? `<div class="w-grid">${ws.map(watchCardHTML).join('')}</div>`
      : `<div class="empty-thread"><h2>No watches yet</h2><p>Add a product link, or paste one in a chat with words like "track the price" and the app will offer to watch it.</p></div>`;
    ws.forEach(drawSpark);
    if (notes.unread) { await api('POST', '/api/notifications/read', {}); pollNotifications(); } // seen on this page
  } catch (e) { list.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; }
}

function watchCardHTML(w) {
  const change = w.baseline_price && w.last_price != null ? (w.last_price - w.baseline_price) / w.baseline_price : null;
  const cond = w.condition === 'below' ? `below ${money(w.target_price, w.currency)}` : w.condition === 'drop_pct' ? `a ${w.drop_pct}% drop` : 'any drop';
  const host = (() => { try { return new URL(w.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  return `<article class="w-card ${w.status}" data-w="${w.id}">
    <div class="w-top"><div style="min-width:0;flex:1"><a class="w-name" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer" title="${esc(w.title || w.url)}">${esc(w.title || host)}</a>
      <div class="muted small">${esc(host)} · alert on ${cond}</div></div>
      <span class="badge ${w.status === 'active' ? 'completed' : w.status === 'error' ? 'failed' : ''}">${w.status === 'active' ? 'Watching' : w.status === 'paused' ? 'Paused' : 'Stopped'}</span></div>
    <div class="w-mid"><div><div class="w-price">${money(w.last_price, w.currency)}</div>
      <div class="small">${change == null || Math.abs(change) < 0.0005 ? '<span class="muted">No change since you started</span>' : change < 0 ? `<span class="good">▼ ${pct(-change)} since you started</span>` : `<span class="bad">▲ ${pct(change)} since you started</span>`}</div>
      <div class="muted small">Lowest ${money(w.lowest_price, w.currency)}${w.in_stock === 0 ? ' · ⚠ out of stock' : ''}</div></div>
      <div class="spark" id="spark-${w.id}"></div></div>
    ${w.last_error ? `<div class="err-box small">⚠ ${esc(w.last_error)}</div>` : ''}
    <div class="muted small">Checked ${ago(w.last_checked_at)} · ${esc(freqLabel(w.interval_minutes))} · ${w.read_by?.method === 'ai' ? `price read by ${esc(shortName(w.read_by.model || 'AI'))}` : 'price from product data (no AI)'}</div>
    <div class="card-actions">
      <button class="btn small" data-w-act="check">Check now</button>
      <button class="btn small ghost" data-w-act="ask" title="Ask the models whether this is a good deal">💬 Ask</button>
      <button class="btn small ghost" data-w-act="more" style="margin-left:auto" aria-label="More actions">⋯</button></div></article>`;
}

// Price history: one series, 2px line, end marker, hover tooltip.
function drawSpark(w) {
  const el = document.getElementById(`spark-${w.id}`); if (!el) return;
  const pts = w.history.filter((h) => h.ok && h.price != null);
  if (pts.length < 2) { el.innerHTML = '<span class="muted small">History appears after a few checks.</span>'; return; }
  const W = el.clientWidth || 220, H = 56, pad = 6;
  const xs = pts.map((p) => p.checked_at), ys = pts.map((p) => p.price);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys), hi = Math.max(...ys);
  const X = (v) => pad + ((v - x0) / Math.max(1, x1 - x0)) * (W - pad * 2);
  const Y = (v) => (hi === lo ? H / 2 : pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.checked_at).toFixed(1)},${Y(p.price).toFixed(1)}`).join('');
  const last = pts.at(-1);
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Price history, ${pts.length} checks">
    ${w.condition === 'below' && w.target_price >= lo && w.target_price <= hi ? `<line x1="${pad}" x2="${W - pad}" y1="${Y(w.target_price)}" y2="${Y(w.target_price)}" class="target"/>` : ''}
    <path d="${d}" class="line"/><circle cx="${X(last.checked_at)}" cy="${Y(last.price)}" r="4" class="end"/>
    <rect width="${W}" height="${H}" fill="transparent" class="hit"/></svg>`;
  el.querySelector('.hit').onmousemove = (e) => {
    const rx = e.offsetX; const p = pts.reduce((a, b) => (Math.abs(X(b.checked_at) - rx) < Math.abs(X(a.checked_at) - rx) ? b : a));
    tip(`<b>${money(p.price, w.currency)}</b><div class="muted">${new Date(p.checked_at).toLocaleString()}</div>`, e.clientX, e.clientY);
  };
  el.querySelector('.hit').onmouseleave = () => tip(null);
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-w-act]'); if (!b) return;
  const card = b.closest('[data-w]'); const id = card.dataset.w; const w = watchesData.find((x) => x.id === id);
  try {
    let act = b.dataset.wAct;
    if (act === 'more') act = await openMenu(b, [['edit', 'Change alert'], [w.status === 'active' ? 'pause' : 'resume', w.status === 'active' ? 'Pause' : 'Resume'], ['delete', 'Delete', true]]);
    switch (act) {
      case 'check': { b.disabled = true; b.textContent = 'Checking…'; const r = await api('POST', `/api/watches/${id}/check`); toast(r.ok ? `Now ${money(r.price, r.watch.currency)}${r.alerted ? ' · alert sent' : ''}` : `Check failed: ${r.error}`); loadAgents(); break; }
      case 'pause': case 'resume': await api('PATCH', `/api/watches/${id}`, { status: b.dataset.wAct === 'pause' ? 'paused' : 'active' }); loadAgents(); break;
      case 'delete': if (confirm(`Stop watching ${w.title || 'this link'} and delete its history?`)) { await api('DELETE', `/api/watches/${id}`); loadAgents(); } break;
      case 'edit': {
        const v = prompt(w.condition === 'drop_pct' ? 'Alert when it drops by what percent?' : `Alert when the price is at or below (${w.currency || ''}):`, w.condition === 'drop_pct' ? w.drop_pct : (w.target_price ?? Math.floor((w.last_price || 0) * 0.9)));
        if (v == null) return;
        await api('PATCH', `/api/watches/${id}`, w.condition === 'drop_pct' ? { condition: 'drop_pct', drop_pct: Number(v) } : { condition: 'below', target_price: Number(v) });
        toast('Alert updated'); loadAgents(); break;
      }
      case 'ask':
        newState.text = `Is this a good deal right now? ${w.title || ''}\n${w.url}\nCurrent price: ${money(w.last_price, w.currency)}. Lowest I've seen: ${money(w.lowest_price, w.currency)}. What should I consider before buying, and are there good alternatives?`;
        location.hash = '#/new'; break;
    }
  } catch (err) { fail(err); }
});

// Unread alerts: badge in the sidebar, plus a browser notification for new ones.
let lastNotifAt = Date.now();
async function pollNotifications() {
  if (!S.me) return;
  try {
    const n = await api('GET', '/api/notifications');
    const badge = $('#w-badge'); if (badge) { badge.textContent = n.unread; badge.hidden = !n.unread; }
    const fresh = n.items.filter((x) => !x.read && x.created_at > lastNotifAt);
    if (fresh.length) {
      lastNotifAt = Math.max(...fresh.map((x) => x.created_at));
      toast(`🔔 ${fresh[0].title}`, 6000);
      try { if (Notification.permission === 'granted' && document.hidden) for (const x of fresh) new Notification(x.title, { body: x.body || '', tag: x.id }); } catch {}
      if (location.hash.startsWith('#/agents')) loadAgents();
    }
  } catch {}
}
setInterval(pollNotifications, 60_000);


// ---------- Agents hub: plain-English trackers (price, jobs, news, page) + alerts ----------
const AGENT_EXAMPLES = [
  'Tell me when AirPods Pro fall below $180 at https://www.walmart.com/ip/Apple-AirPods-Pro-2nd-Generation/1752657021, check 5 times a day',
  'New graduate or AI product manager roles at AI companies, London or remote. No senior roles.',
  'News about OpenAI and Anthropic product launches',
  'Alert me when https://example.com changes',
];
let agentsData = { monitors: [], watches: [], notes: { items: [], unread: 0 } };
let catalog = null;

function renderAgents() {
  closeStream();
  S.conv = null; S.resp = new Map(); renderSidebar(); renderSkills();
  const focus = new URLSearchParams(location.hash.split('?')[1] || '').get('m');
  S.agentTab = focus ? 'trackers' : S.agentTab || 'trackers';
  S.agentFocus = focus; S.agentOpen = S.agentOpen || new Set(focus ? [focus] : []);
  $('#main').innerHTML = `${mobileTop('Agents')}<div class="new-wrap"><div class="new-inner agents viz-root">
    <header class="ag-head"><div><h1>Agents</h1><p class="muted">They check the web on a schedule and alert you when something new shows up.</p></div>
      <div class="seg ag-tabs" role="tablist">${[['trackers', 'Agents'], ['prices', 'Prices'], ['alerts', 'Alerts']].map(([k, l]) => `<button data-tab="${k}" role="tab">${l}${k === 'alerts' ? '<span class="tab-dot" id="tab-dot" hidden></span>' : ''}</button>`).join('')}</div></header>
    <div class="ag-new"><span class="ag-new-icon">＋</span><input class="input" id="ag-req" placeholder="New agent: describe what to keep an eye on…" autocomplete="off"><button class="btn primary" id="ag-plan">Set up</button>
      <div class="ag-suggest" id="ag-suggest" hidden>${AGENT_EXAMPLES.map((x, i) => `<button data-ex="${i}">${esc(x)}</button>`).join('')}</div></div>
    <div class="ag-quick"><span class="muted small">Or set one up yourself:</span>${AGENT_TYPES.map((t) => `<button class="chip" data-new="${t.type}">${t.icon} ${t.label}</button>`).join('')}</div>
    <div id="ag-body"><div class="muted">Loading…</div></div></div></div>`;
  const req = $('#ag-req'), sug = $('#ag-suggest');
  const showSug = () => { sug.hidden = !!req.value; };
  req.onfocus = showSug; req.oninput = showSug;
  req.onblur = () => setTimeout(() => { sug.hidden = true; }, 150);
  req.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); planAgent(); } if (e.key === 'Escape') req.blur(); };
  sug.onmousedown = (e) => { const b = e.target.closest('[data-ex]'); if (b) { e.preventDefault(); req.value = AGENT_EXAMPLES[b.dataset.ex]; sug.hidden = true; req.focus(); } };
  $('#ag-plan').onclick = planAgent;
  $('.ag-quick').onclick = (e) => { const b = e.target.closest('[data-new]'); if (b) newAgentOfType(b.dataset.new); };
  $('.ag-tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { S.agentTab = b.dataset.tab; drawAgents(); if (b.dataset.tab === 'alerts') markAlertsRead(); } };
  if (S.agentPrefill) { req.value = S.agentPrefill; S.agentPrefill = null; planAgent(); }
  loadAgents();
}

async function loadAgents() {
  try {
    const [monitors, watches, notes, cat] = await Promise.all([api('GET', '/api/monitors'), api('GET', '/api/watches'), api('GET', '/api/notifications'), catalog || api('GET', '/api/agents/catalog')]);
    catalog = cat; agentsData = { monitors, watches, notes }; watchesData = watches;
    drawAgents();
    if (S.agentTab === 'alerts') markAlertsRead();
  } catch (e) { $('#ag-body').innerHTML = `<div class="err-box">${esc(e.message)}</div>`; }
}
async function markAlertsRead() { if (agentsData.notes.unread) { await api('POST', '/api/notifications/read', {}).catch(() => {}); agentsData.notes.unread = 0; pollNotifications(); } }

const dayLabel = (ms) => { const d = new Date(ms), t = new Date(); const diff = Math.floor((new Date(t.toDateString()) - new Date(d.toDateString())) / 86400000); return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : 'Earlier'; };

function drawAgents() {
  const body = $('#ag-body'); if (!body) return;
  document.querySelectorAll('.ag-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.agentTab));
  const dot = $('#tab-dot'); if (dot) dot.hidden = !agentsData.notes.unread;
  const { monitors, watches, notes } = agentsData;
  if (S.agentTab === 'alerts') {
    if (!notes.items.length) { body.innerHTML = emptyState('🔔', 'No alerts yet', 'When an agent finds something, it shows up here, as a badge in the sidebar, and as a browser notification.'); return; }
    const groups = {}; for (const n of notes.items) (groups[dayLabel(n.created_at)] ||= []).push(n);
    body.innerHTML = Object.entries(groups).map(([day, list]) => `<div class="ag-group"><div class="ag-group-label">${day}</div>${list.map((n) => {
      const inApp = n.url?.startsWith('#');
      return `<a class="alert-row ${n.read ? '' : 'unread'}" href="${esc(n.url || '#/agents')}" ${inApp || !n.url ? '' : 'target="_blank" rel="noopener noreferrer"'}>
        <span class="ar-icon">${n.kind === 'price_drop' ? '🏷' : n.kind === 'monitor' ? '📡' : '⚠️'}</span>
        <span class="ar-main"><span class="ar-title">${esc(n.title)}</span><span class="ar-body">${esc((n.body || '').split('\n')[0])}</span></span>
        <span class="ar-time">${ago(n.created_at)}</span></a>`; }).join('')}</div>`).join('');
  } else if (S.agentTab === 'prices') {
    body.innerHTML = watches.length ? `<div class="w-grid">${watches.map(watchCardHTML).join('')}</div>`
      : emptyState('🏷', 'No price watches', 'Describe one above, for example "tell me when this drops below $180" with a product link.');
    watches.forEach(drawSpark);
  } else {
    body.innerHTML = monitors.length ? `<div class="ag-list">${monitors.map(agentRowHTML).join('')}</div>`
      : `<div class="ag-types">${AGENT_TYPES.map((t) => `<button class="ag-type" data-new="${t.type}"><span class="ag-type-icon">${t.icon}</span><b>${t.label}</b><span class="muted small">${t.desc}</span></button>`).join('')}</div>`;
    body.querySelectorAll('.ag-type').forEach((b) => { b.onclick = () => newAgentOfType(b.dataset.new); });
    if (S.agentFocus) { document.getElementById(`mon-${S.agentFocus}`)?.scrollIntoView({ block: 'start' }); S.agentFocus = null; }
  }
}
const emptyState = (icon, title, text) => `<div class="ag-empty"><div class="ag-empty-icon">${icon}</div><b>${title}</b><p class="muted">${text}</p></div>`;

const KIND_LABEL = { jobs: '💼 Jobs', news: '📰 News', page: '📄 Page', price: '🏷 Price' };
const KIND_ICON = { jobs: '💼', news: '📰', page: '📄' };
const freqLabel = (v) => (INTERVALS.find(([x]) => x === v)?.[1] || '').replace(/ \(hourly\)/, '').toLowerCase();
function agentSummary(m) {
  if (m.kind === 'page') { let host = m.url; try { host = new URL(m.url).hostname; } catch {} return `${host} · ${m.criteria ? `when: ${m.criteria}` : 'any change'}`; }
  const q = monTerms(m.query); return `${q.slice(0, 2).join(', ')}${q.length > 2 ? ` +${q.length - 2}` : ''}${m.location ? ` · ${m.location}` : ''}`;
}
const monTerms = (q) => String(q || '').split(',').map((t) => t.trim()).filter(Boolean);
function agentRowHTML(m) {
  const open = S.agentOpen.has(m.id);
  const fresh = m.items.filter((it) => it.found_at > (m.last_run_at || 0) - 60_000 && !it.feedback).length;
  return `<article class="ag-row ${open ? 'open' : ''} ${m.status}" id="mon-${m.id}" data-mon="${m.id}">
    <div class="ag-row-head" data-toggle>
      <span class="ag-kind" title="${esc(m.kind)}">${KIND_ICON[m.kind]}</span>
      <span class="ag-row-main"><span class="ag-row-name">${esc(m.name)}${m.status !== 'active' ? ` <span class="badge">${m.status === 'paused' ? 'Paused' : 'Stopped'}</span>` : ''}</span>
        <span class="ag-row-sub">${esc(agentSummary(m))}</span></span>
      ${m.last_error ? '<span class="ag-warn" title="' + esc(m.last_error) + '">⚠</span>' : ''}
      ${fresh ? `<span class="new-pill">${fresh} new</span>` : m.items.length ? `<span class="ag-count">${m.items.length} found</span>` : ''}
      <span class="ag-meta" title="Last run ${ago(m.last_run_at)}">${esc(freqLabel(m.interval_minutes))}</span>
      <button class="btn small ghost ag-menu-btn" data-menu aria-label="More actions">⋯</button>
      <span class="ag-chev">${open ? '▾' : '▸'}</span></div>
    ${open ? `<div class="ag-row-body">
      ${m.last_error ? `<div class="err-box warn small">⚠ ${esc(m.last_error)}</div>` : ''}
      ${m.items.length ? m.items.map(itemHTML).join('') : `<div class="muted small ag-none">${m.kind === 'page' ? 'Nothing yet. You will be alerted when the condition is met.' : 'No matches yet. New ones will appear here.'}</div>`}
      <div class="ag-foot muted small">Checks ${esc(freqLabel(m.interval_minutes))} · last run ${ago(m.last_run_at)}${m.status === 'active' ? ` · next ${until(m.next_run_at)}` : ''}${m.kind !== 'page' ? ` · 👍/👎 teach this agent what you want` : ''}</div></div>` : ''}
  </article>`;
}
function itemHTML(it) {
  const meta = [it.company, it.location, it.published_at && ago(it.published_at)].filter(Boolean).map(esc).join(' · ');
  return `<div class="mon-item" data-item="${it.id}"><div class="mi-main">
      <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer" class="mi-title">${esc(it.title)}</a>
      ${meta ? `<div class="mi-meta">${meta}</div>` : ''}
      ${it.reason ? `<div class="mi-reason" title="${it.score != null ? `AI match ${Math.round(it.score * 100)}%` : ''}">${esc(it.reason)}</div>` : ''}</div>
    <div class="mi-fb"><button class="icon-btn ${it.feedback === 1 ? 'on' : ''}" data-fb="1" title="Useful: more like this">👍</button>
      <button class="icon-btn" data-fb="-1" title="Not relevant: hide it">👎</button>
      ${it.source !== 'page' ? `<button class="icon-btn" data-mi-ask title="Open a chat about this">💬</button>` : ''}</div></div>`;
}

// Small popover menu for row actions.
function openMenu(anchor, items) {
  document.querySelector('.pop-menu')?.remove();
  const r = anchor.getBoundingClientRect();
  const m = document.createElement('div'); m.className = 'pop-menu';
  m.innerHTML = items.map(([k, label, danger]) => `<button data-k="${k}" class="${danger ? 'danger' : ''}">${label}</button>`).join('');
  m.style.top = `${r.bottom + 4}px`; m.style.left = `${Math.max(8, r.right - 170)}px`;
  document.body.appendChild(m);
  return new Promise((ok) => {
    const close = (v) => { m.remove(); document.removeEventListener('mousedown', outside, true); ok(v); };
    const outside = (e) => { if (!m.contains(e.target)) close(null); };
    m.onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) close(b.dataset.k); };
    setTimeout(() => document.addEventListener('mousedown', outside, true));
  });
}

const AGENT_TYPES = [
  { type: 'jobs', icon: '💼', label: 'Job openings', desc: 'New roles matching a title, location and level, from AI and tech company career pages and job boards.' },
  { type: 'news', icon: '📰', label: 'News on a topic', desc: 'New articles about a company, product or topic, screened so only real matches reach you.' },
  { type: 'price', icon: '🏷', label: 'Price drop', desc: 'A product link: alert when it drops below your price, checked up to 24 times a day.' },
  { type: 'page', icon: '📄', label: 'Page change', desc: 'Any web page: alert when it changes, or when it starts saying something, such as "applications are open".' },
];
// Manual setup: an empty plan of the chosen type, no AI planning step.
async function newAgentOfType(type) {
  if (type === 'price') return openWatchModal();
  try { catalog = catalog || await api('GET', '/api/agents/catalog'); } catch (e) { return fail(e); }
  const p = { type, name: '', query: '', location: '', exclude: '', criteria: '', url: '', interval_minutes: type === 'news' ? 360 : type === 'jobs' ? 720 : 288,
    companies: type === 'jobs' ? catalog.company_presets : [], summary: AGENT_TYPES.find((t) => t.type === type).desc };
  const { el, close } = modal({ title: `New ${AGENT_TYPES.find((t) => t.type === type).label.toLowerCase()} agent`, body: planCardHTML(p) });
  wirePlanCard(el, p, () => close());
  setTimeout(() => el.querySelector('[data-pf="query"], [data-pf="url"]')?.focus(), 0);
}

async function planAgent() {
  const input = $('#ag-req'); const req = input.value.trim();
  if (req.length < 8) { input.focus(); return toast('Describe what to keep an eye on'); }
  const b = $('#ag-plan'); b.disabled = true; b.textContent = 'Planning…';
  try {
    catalog = catalog || await api('GET', '/api/agents/catalog');
    const p = await api('POST', '/api/agents/plan', { request: req });
    if (p.type === 'price') { input.value = ''; openWatchModal({ url: p.url, target: Number(p.target_price) || null, interval: p.interval_minutes }); return; }
    const { el, close } = modal({ title: 'New agent', body: planCardHTML(p) });
    wirePlanCard(el, p, () => { close(); input.value = ''; });
  } catch (e) { fail(e); }
  finally { b.disabled = false; b.textContent = 'Set up'; }
}

function planCardHTML(p) {
  const field = (k, label, val, ph = '') => `<label class="small">${label}<input class="input" data-pf="${k}" value="${esc(val ?? '')}" placeholder="${esc(ph)}"></label>`;
  const ints = INTERVALS.map(([v, l]) => `<option value="${v}" ${v === p.interval_minutes ? 'selected' : ''}>${l}</option>`).join('');
  let fields = '';
  if (p.type === 'price') fields = field('url', 'Product link', p.url) + `<div class="pf-row">${field('target_price', 'Alert at or below', p.target_price, 'e.g. 180')}</div>`;
  if (p.type === 'jobs' || p.type === 'news') fields = field('query', p.type === 'jobs' ? 'Roles (comma-separated, include synonyms)' : 'Topics (comma-separated)', p.query, p.type === 'jobs' ? 'AI Product Manager, AI PM, Associate Product Manager' : 'OpenAI launch, Anthropic Claude, GPT-6')
    + (p.type === 'jobs' ? `<div class="pf-row">${field('location', 'Location (optional)', p.location, 'London, Remote')}${field('exclude', 'Leave out titles with', p.exclude, 'Senior, Director')}</div>` : '')
    + field('criteria', 'What counts (the AI screener uses this)', p.criteria, 'e.g. entry-level PM roles focused on AI products')
    + `<div class="small"><b>Sources</b><div class="eval-crit">${catalog.sources.filter((x) => x.kind === p.type).map((x) => `<label class="chk"><input type="checkbox" data-src="${x.key}" ${p.type === 'news' || x.key !== 'companies' || p.companies?.length ? 'checked' : ''}> ${esc(x.label)}${x.key === 'companies' ? ` (${catalog.company_presets.length} AI & tech companies)` : ''}</label>`).join('')}</div></div>`;
  if (p.type === 'page') fields = field('url', 'Page link', p.url) + field('criteria', 'Alert when the page says (leave empty to alert on any change)', p.criteria, 'e.g. applications are open');
  return `<div class="plan-card"><div class="plan-head"><span class="badge">${KIND_LABEL[p.type]}</span> <input class="input plan-name" data-pf="name" value="${esc(p.name || '')}" aria-label="Name" placeholder="Name (optional)"></div>
    ${p.summary ? `<div class="small muted">${esc(p.summary)}</div>` : ''}
    ${fields}
    <label class="small">How often<select class="select" data-pf="interval_minutes">${ints}</select></label>
    <div class="plan-actions"><span class="muted small" style="margin-right:auto">Check the details, then create it.${p.planner_model ? ` Planned by ${esc(shortName(p.planner_model))}.` : ''}</span>
      ${p.type !== 'price' ? '<button class="btn" data-plan="preview">Preview results</button>' : ''}<button class="btn primary" data-plan="create">Create agent</button></div>
    <div class="plan-preview"></div></div>`;
}

function wirePlanCard(root, p, done = () => {}) {
  const read = () => {
    const v = { ...p };
    root.querySelectorAll('[data-pf]').forEach((x) => { v[x.dataset.pf] = x.value.trim(); });
    v.interval_minutes = Number(v.interval_minutes);
    if (p.type === 'jobs' || p.type === 'news') {
      v.sources = [...root.querySelectorAll('[data-src]:checked')].map((x) => x.dataset.src);
      v.companies = v.sources.includes('companies') ? catalog.company_presets : [];
    }
    return v;
  };
  root.querySelector('[data-plan="create"]').onclick = async (e) => {
    const v = read(); const b = e.target; b.disabled = true; b.textContent = 'Creating…';
    try {
      if (v.type === 'price') {
        // Price trackers reuse the price-watch flow (it previews the product first).
        root.innerHTML = ''; openWatchModal({ url: v.url, target: Number(v.target_price) || null, interval: v.interval_minutes });
        return;
      }
      b.textContent = v.type === 'page' ? 'Checking the page…' : 'Searching sources and screening results…';
      const m = await api('POST', '/api/monitors', { kind: v.type, name: v.name, request: v.request, query: v.query, location: v.location, exclude: v.exclude, criteria: v.criteria, url: v.url, sources: v.sources, companies: v.companies, interval_minutes: v.interval_minutes });
      done();
      toast(m.first_run?.ok === false ? `Created, but the first run failed: ${m.first_run.error}` : v.type === 'page' ? 'Agent created. You will be alerted when the page matches.' : `Agent created. First run found ${m.first_run?.new_relevant ?? 0} matches.`, 6000);
      ensureNotifyPermission(); S.agentTab = 'trackers'; S.agentOpen.add(m.id); loadAgents();
    } catch (err) { b.disabled = false; b.textContent = 'Create agent'; root.querySelector('.plan-preview').innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }
  };
  const pv = root.querySelector('[data-plan="preview"]');
  if (pv) pv.onclick = async () => {
    const v = read(); const box = root.querySelector('.plan-preview'); pv.disabled = true; pv.textContent = 'Searching…';
    box.innerHTML = '<div class="muted small">Searching every source and screening results with AI. This can take up to a minute.</div>';
    try {
      const r = await api('POST', '/api/monitors/preview', { kind: v.type, name: v.name, query: v.query, location: v.location, exclude: v.exclude, criteria: v.criteria, url: v.url, sources: v.sources, companies: v.companies, interval_minutes: v.interval_minutes });
      box.innerHTML = v.type === 'page'
        ? `<div class="small">${r.verdict ? `Right now the condition is <b>${r.verdict.met ? 'met' : 'not met'}</b>${r.verdict.evidence ? `: “${esc(r.verdict.evidence)}”` : ''}.` : 'The page was read. You will be alerted when it changes.'}</div>`
        : `<div class="small muted">Scanned ${r.scanned} items, ${r.matched} matched your keywords, ${r.items.filter((x) => x.relevant).length} passed AI screening.${r.errors.length ? ` Some sources failed: ${esc(r.errors.join('; '))}` : ''}</div>
          <div class="mon-items">${r.items.slice(0, 10).map((it) => `<div class="mon-item ${it.relevant ? '' : 'dim'}"><div style="flex:1;min-width:0"><a class="mi-title" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>
            <div class="muted small">${[it.company, it.location].filter(Boolean).map(esc).join(' · ')}</div><div class="small mi-reason">${it.score == null ? '…' : it.relevant ? '✓' : '✗'} ${esc(it.reason || '')}${it.score != null ? ` <span class="muted">(${Math.round(it.score * 100)}%)</span>` : ''}</div></div></div>`).join('') || '<div class="muted small">Nothing right now. The agent will keep checking.</div>'}</div>`;
    } catch (err) { box.innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }
    pv.disabled = false; pv.textContent = 'Preview results';
  };
}

document.addEventListener('click', async (e) => {
  const fb = e.target.closest('[data-fb]'), menu = e.target.closest('.ag-row [data-menu]'), ask = e.target.closest('[data-mi-ask]'), toggle = e.target.closest('.ag-row [data-toggle]');
  if (!fb && !menu && !ask && !toggle) return;
  const card = e.target.closest('[data-mon]'); const m = agentsData.monitors.find((x) => x.id === card?.dataset.mon);
  try {
    if (menu) {
      e.stopPropagation();
      const k = await openMenu(menu, [['run', 'Run now'], [m.status === 'active' ? 'pause' : 'resume', m.status === 'active' ? 'Pause' : 'Resume'], ['delete', 'Delete', true]]);
      if (k === 'run') { toast('Running…'); const r = await api('POST', `/api/monitors/${m.id}/run`); S.agentOpen.add(m.id);
        toast(r.ok ? (m.kind === 'page' ? (r.met ? 'Condition met' : r.changed ? 'The page changed' : 'No change') : `${r.new_relevant} new matches`) : `Run failed: ${r.error}`); loadAgents(); }
      if (k === 'pause' || k === 'resume') { await api('PATCH', `/api/monitors/${m.id}`, { status: k === 'pause' ? 'paused' : 'active' }); loadAgents(); }
      if (k === 'delete' && confirm(`Delete the agent "${m.name}" and its results?`)) { await api('DELETE', `/api/monitors/${m.id}`); loadAgents(); }
      return;
    }
    if (fb) {
      const row = fb.closest('[data-item]'); const v = Number(fb.dataset.fb);
      await api('POST', `/api/monitor-items/${row.dataset.item}/feedback`, { value: v });
      if (v === -1) { row.classList.add('gone'); setTimeout(() => row.remove(), 250); toast('Hidden. This agent will show fewer like it.'); }
      else { fb.classList.add('on'); toast('Got it. This agent will look for more like this.'); }
      const it = m?.items.find((x) => x.id === row.dataset.item); if (it) it.feedback = v;
      return;
    }
    if (ask) {
      const it = m.items.find((x) => x.id === ask.closest('[data-item]').dataset.item);
      newState.text = m.kind === 'jobs' ? `Help me decide whether to apply for this role and what to highlight:\n${it.title}${it.company ? ` at ${it.company}` : ''}${it.location ? ` (${it.location})` : ''}\n${it.url}`
        : `Summarize why this matters and what to watch next:\n${it.title}\n${it.url}`;
      location.hash = '#/new'; return;
    }
    if (toggle) { S.agentOpen.has(m.id) ? S.agentOpen.delete(m.id) : S.agentOpen.add(m.id); card.outerHTML = agentRowHTML(m); }
  } catch (err) { fail(err); }
});

// ---------- keyboard shortcuts ----------
document.addEventListener('keydown', (e) => {
  if (!S.me) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape' && $('#modal-root').innerHTML === '' && S.conv && [...S.resp.values()].some((r) => r.status === 'generating')) { e.preventDefault(); stopAll(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); location.hash = '#/new'; }
  else if (e.key === '/' && !typing) { e.preventDefault(); $('#conv-search')?.focus(); }
});

// ---------- boot ----------
(async () => {
  try { S.me = await api('GET', '/api/me'); await startApp(); }
  catch { if (!S.me) renderAuth('login'); }
})();
