// "Assistants": build, test and publish a RAG assistant from your own documents.
// app.js hands in its helpers so this file stays self-contained.
let H;                                  // { $, api, esc, toast, fail, mobileTop, models, base }
const R = { apps: [], templates: [], app: null, tab: 'docs', thread: [], queries: [], busy: false, poll: null, quality: null };

const fmtDate = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const FLAG_TEXT = {
  no_relevant_source: 'No matching document', prompt_injection: 'Manipulation attempt blocked', too_long: 'Question too long',
  suspicious_source: 'A document tried to give orders', unsupported_price: 'Invented price withheld', invalid_citation: 'Bad citation removed',
  uncited: 'Answer without citation', keyword_only: 'Smart search unavailable', blocked_phrase: 'Blocked phrase', model_error: 'Model error', empty_answer: 'Empty reply withheld',
};

export function renderRag(helpers, hash) {
  H = helpers; clearInterval(R.poll);
  const id = hash.match(/^#\/assistants\/([\w-]+)/)?.[1];
  if (id) return openApp(id); R.app = null;
  return renderList();
}

// ---------- list ----------
async function renderList() {
  const { $, esc, api, fail } = H;
  $('#main').innerHTML = `${H.mobileTop('Assistants')}<div class="rag-wrap"><h1>Assistants</h1>
    <p class="muted">Upload your business documents, test how well an AI answers from them, then put it on your website. Answers always cite your documents.</p>
    <div id="rag-list" class="muted">Loading…</div></div>`;
  try { const r = await api('GET', '/api/rag/apps'); R.apps = r.apps; R.templates = r.templates; }
  catch (e) {
    fail(e);
    const old = /not found/i.test(e.message);
    $('#rag-list').innerHTML = `<div class="err-box"><b>Could not load assistants.</b> ${esc(e.message)}${old ? '<br>The app server is probably running an older version without this feature. Stop it and start it again with <code>npm start</code>, then reload this page.' : ''}
      <div style="margin-top:8px"><button class="btn small" id="rag-retry">Try again</button></div></div>`;
    $('#rag-retry').onclick = () => renderList();
    return;
  }
  const tpl = R.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
  $('#rag-list').innerHTML = `<div class="rag-new"><input class="input" id="rag-name" placeholder="Business name, for example Maple Street Bakery" maxlength="120">
      <select class="select" id="rag-tpl">${tpl}</select>
      <label class="small"><input type="checkbox" id="rag-sample" checked> Add a sample FAQ so I can try it now</label>
      <button class="btn primary" id="rag-create">Create assistant</button></div>
    <div class="rag-cards">${R.apps.length ? R.apps.map((a) => `<a class="rag-card" href="#/assistants/${esc(a.id)}"><b>${esc(a.name)}</b>
      <span class="muted small">${a.docs} document${a.docs === 1 ? '' : 's'} · ${a.queries} question${a.queries === 1 ? '' : 's'}${a.published ? ' · <span class="tag ok">live</span>' : ''}</span></a>`).join('')
      : '<div class="muted">No assistants yet. Create your first one above.</div>'}</div>`;
  $('#rag-create').onclick = async () => {
    const btn = $('#rag-create'); btn.disabled = true;
    try {
      const a = await api('POST', '/api/rag/apps', { name: $('#rag-name').value.trim() || 'My assistant', template: $('#rag-tpl').value, sample: $('#rag-sample').checked });
      location.hash = `#/assistants/${a.id}`;
    } catch (e) { fail(e); btn.disabled = false; }
  };
}

// ---------- one assistant ----------
async function openApp(id) {
  const { $, api, fail } = H;
  $('#main').innerHTML = `${H.mobileTop('Assistant')}<div class="rag-wrap muted">Loading…</div>`;
  try { R.app = await api('GET', `/api/rag/apps/${id}`); } catch (e) { fail(e); location.hash = '#/assistants'; return; }
  if (R.app.id !== R.threadFor) { R.thread = []; R.threadFor = R.app.id; }
  drawApp();
}

function modelOptions(selected) {
  const { esc } = H;
  const ms = [...H.models()].filter((m) => m.tags?.includes('free') || m.free).slice(0, 60);
  if (selected && !ms.some((m) => m.id === selected)) ms.unshift({ id: selected, name: selected });
  return `<option value="">Choose a model…</option>` + ms.map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.name || m.id)}</option>`).join('');
}

function drawApp() {
  const { $, esc } = H;
  const a = R.app;
  const tabs = [['docs', 'Documents'], ['try', 'Try it'], ['tests', 'Test set'], ['quality', 'Quality'], ['settings', 'Settings'], ['publish', 'Publish'], ['log', 'Questions']];
  $('#main').innerHTML = `${H.mobileTop(a.name)}<div class="rag-wrap">
    <div class="rag-head"><a href="#/assistants" class="btn small ghost">← All assistants</a><h1>${esc(a.name)}</h1>${a.published ? '<span class="tag ok">live</span>' : '<span class="tag">draft</span>'}</div>
    <div class="rag-tabs">${tabs.map(([k, l]) => `<button class="chip ${R.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="rag-pane"></div></div>`;
  $('#main').querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { R.tab = b.dataset.tab; drawApp(); }));
  clearInterval(R.poll);
  ({ docs: paneDocs, try: paneTry, tests: paneTests, quality: paneQuality, settings: paneSettings, publish: panePublish, log: paneLog })[R.tab]();
}

// ---- documents ----
function paneDocs() {
  const { $, esc, api, fail, toast } = H;
  const a = R.app;
  const sx = a.search || { enabled: false, total: 0, embedded: 0 };
  const searchBanner = !sx.total ? '' : !sx.enabled ? '<div class="rag-gate na small"><b>Smart search is off.</b> Customers must use the same words as your documents. Turn it on in Settings.</div>'
    : sx.embedded >= sx.total ? `<div class="rag-gate ok small"><b>✓ Smart search ready</b> for all ${sx.total} sections. It understands meaning, so "money back" finds your refund policy.</div>`
    : `<div class="rag-gate stop small"><b>Smart search is ready for ${sx.embedded} of ${sx.total} sections.</b> The rest only match exact words. <button class="btn small" id="rag-reindex">Finish setting up</button></div>`;
  $('#rag-pane').innerHTML = `${searchBanner}<p class="muted small">Add what customers ask about: price lists, FAQs, policies, menus, manuals. PDF, text, markdown and CSV work. Pasted text works too.</p>
    <div class="rag-drop" id="rag-drop"><b>Drop files here</b> or <button class="btn small" id="rag-pick">choose files</button><input type="file" id="rag-file" multiple hidden accept=".pdf,.txt,.md,.markdown,.csv,.json,.html,.htm"></div>
    <details class="rag-paste"><summary>Paste text instead</summary><input class="input" id="rag-pname" placeholder="Name, for example Delivery policy"><textarea class="textarea" id="rag-ptext" rows="6" placeholder="Paste text here"></textarea><button class="btn" id="rag-padd">Add text</button></details>
    <table class="rag-table"><thead><tr><th>Document</th><th>Sections</th><th>Added</th><th></th></tr></thead><tbody>${a.docs.length ? a.docs.map((d) => `<tr><td>${esc(d.name)}</td><td>${d.chunks}</td><td>${fmtDate(d.created_at)}</td><td><button class="btn small ghost danger" data-del="${esc(d.id)}">Remove</button></td></tr>`).join('') : '<tr><td colspan="4" class="muted">No documents yet.</td></tr>'}</tbody></table>`;
  const ri = $('#rag-reindex'); if (ri) ri.onclick = async () => { ri.disabled = true; ri.textContent = 'Working…'; try { await api('POST', `/api/rag/apps/${a.id}/search/index`); R.app = await api('GET', `/api/rag/apps/${a.id}`); drawApp(); } catch (e) { fail(e); ri.disabled = false; ri.textContent = 'Finish setting up'; } };
  const upload = async (files) => {
    for (const f of files) {
      try {
        const r = await fetch(`${H.base}/api/rag/apps/${a.id}/upload`, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `Upload failed (${r.status})`);
        toast(`Added ${f.name} (${body.chunks} sections)`);
      } catch (e) { fail(e); }
    }
    R.app = await api('GET', `/api/rag/apps/${a.id}`); drawApp();
  };
  $('#rag-pick').onclick = () => $('#rag-file').click();
  $('#rag-file').onchange = (e) => upload([...e.target.files]);
  const drop = $('#rag-drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); };
  $('#rag-padd').onclick = async () => {
    try { await api('POST', `/api/rag/apps/${a.id}/docs`, { name: $('#rag-pname').value || 'Pasted text', text: $('#rag-ptext').value }); R.app = await api('GET', `/api/rag/apps/${a.id}`); drawApp(); } catch (e) { fail(e); }
  };
  $('#rag-pane').querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this document? Answers will no longer use it.')) return;
    try { await api('DELETE', `/api/rag/apps/${a.id}/docs/${b.dataset.del}`); R.app = await api('GET', `/api/rag/apps/${a.id}`); drawApp(); } catch (e) { fail(e); }
  }));
}

// ---- playground ----
const answerHTML = (text, sources, cited) => {
  const { esc } = H;
  return esc(text).replace(/\[(\d{1,2})\]/g, (m, n) => `<sup class="cite" data-cite="${n}" title="${esc(sources[n - 1] ? `${sources[n - 1].doc_name}${sources[n - 1].heading ? ' · ' + sources[n - 1].heading : ''}` : '')}">${n}</sup>`).replace(/\n/g, '<br>');
};
function turnHTML(t) {
  const { esc } = H;
  const flags = t.flags.map((f) => `<span class="tag ${['no_relevant_source', 'uncited'].includes(f) ? '' : 'busy'}">${esc(FLAG_TEXT[f] || f)}</span>`).join(' ');
  return `<div class="rag-turn"><div class="rag-q">${esc(t.question)}</div>
    <div class="rag-a ${t.refused ? 'refused' : ''}">${answerHTML(t.answer, t.sources, t.cited)}</div>
    ${t.error ? `<div class="small err-text">The model said: ${esc(String(t.error).slice(0, 200))} Try again, or choose another model.</div>` : ''}
    <div class="small muted">${flags} ${t.model ? esc(t.model) + ' · ' : ''}${t.latency_ms} ms · match ${Math.round(Math.max(t.coverage || 0, t.similarity || 0) * 100)}%
      <button class="btn small ghost" data-rate="1" data-q="${esc(t.query_id)}" title="Good answer">👍</button><button class="btn small ghost" data-rate="-1" data-q="${esc(t.query_id)}" title="Bad answer">👎</button></div>
    ${t.sources.length ? `<details class="rag-src"><summary>${t.sources.length} source${t.sources.length === 1 ? '' : 's'} used</summary>${t.sources.map((s, i) =>
      `<div class="rag-snip"><b>[${i + 1}] ${esc(s.doc_name)}${s.heading ? ' · ' + esc(s.heading) : ''}</b> <span class="muted small">words ${Math.round(s.coverage * 100)}%${s.sim != null ? ` · meaning ${Math.round(s.sim * 100)}%` : ''}</span><div>${esc(s.text)}</div></div>`).join('')}</details>` : ''}</div>`;
}
function paneTry() {
  const { $, esc, api, fail } = H;
  const a = R.app;
  $('#rag-pane').innerHTML = `<div class="rag-try"><div class="rag-model"><label class="small muted">Model</label><select class="select" id="rag-model">${modelOptions(a.config.model)}</select></div>
    <div id="rag-thread">${R.thread.length ? R.thread.map(turnHTML).join('') : '<div class="muted">Ask a question a customer might ask. You will see the answer, which documents it came from, and which safety checks fired.</div>'}</div>
    <div class="rag-ask"><textarea class="textarea" id="rag-q" rows="2" placeholder="Ask a question…"></textarea><button class="btn primary" id="rag-go">Ask</button></div></div>`;
  const go = async () => {
    const q = $('#rag-q').value.trim(); if (!q || R.busy) return;
    const model = $('#rag-model').value; if (!model) return fail(new Error('Choose a model first.'));
    R.busy = true; $('#rag-go').disabled = true; $('#rag-go').textContent = 'Thinking…';
    try {
      const r = await api('POST', `/api/rag/apps/${a.id}/ask`, { question: q, model });
      if (model !== a.config.model) { R.app = await api('PATCH', `/api/rag/apps/${a.id}`, { config: { model } }); R.app.docs = a.docs; }
      R.thread.push(r); $('#rag-q').value = '';
    } catch (e) { fail(e); } finally { R.busy = false; }
    paneTry(); $('#rag-thread').lastElementChild?.scrollIntoView({ block: 'nearest' });
  };
  $('#rag-go').onclick = go;
  $('#rag-q').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } };
  $('#rag-thread').onclick = async (e) => {
    const b = e.target.closest('[data-rate]'); if (!b) return;
    try { await api('PATCH', `/api/rag/queries/${b.dataset.q}`, { rating: Number(b.dataset.rate) }); b.classList.add('on'); } catch (err) { fail(err); }
  };
}

// ---- settings ----
function paneSettings() {
  const { $, esc, api, fail, toast } = H;
  const a = R.app, c = a.config;
  const num = (k, label, min, max, step, hint) => `<label class="rag-field"><span>${label}</span><input class="input" type="number" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${c[k]}"><small class="muted">${hint}</small></label>`;
  $('#rag-pane').innerHTML = `<div class="rag-form">
    <label class="rag-field"><span>Assistant name</span><input class="input" id="s-name" value="${esc(a.name)}"></label>
    <label class="rag-field"><span>Model</span><select class="select" data-k="model">${modelOptions(c.model)}</select><small class="muted">Free models work. Try several in the Test tab and keep the one that answers best.</small></label>
    <label class="rag-field"><span>How strict should it be?</span><select class="select" data-k="strictness"><option value="strict" ${c.strictness === 'strict' ? 'selected' : ''}>Strict: answer only from my documents</option><option value="friendly" ${c.strictness === 'friendly' ? 'selected' : ''}>Friendly: may add a short general note, clearly labelled</option></select></label>
    <label class="rag-field"><span>Tone</span><input class="input" data-k="tone" value="${esc(c.tone)}"></label>
    <label class="rag-field"><span>When it does not know, say</span><textarea class="textarea" rows="2" data-k="refusal_message">${esc(c.refusal_message)}</textarea></label>
    <label class="rag-field"><span>Hand-off line (added to every refusal)</span><input class="input" data-k="handoff_message" value="${esc(c.handoff_message)}" placeholder="For example: Call us on 555 0100."></label>
    <label class="rag-field"><span>Words it must never use</span><input class="input" data-k="blocked_phrases" value="${esc(c.blocked_phrases.join(', '))}" placeholder="guarantee, cheapest"><small class="muted">Separate with commas. If an answer uses one, it is replaced with the refusal.</small></label>
    <label class="rag-field"><span>Smart search</span><select class="select" data-k="embedding_model"><option value="nvidia/nemotron-3-embed-1b:free" ${c.embedding_model && c.embedding_model !== '' ? 'selected' : ''}>On: understands meaning (free)</option><option value="" ${!c.embedding_model ? 'selected' : ''}>Off: exact words only</option></select><small class="muted">Lets "money back" find your refund policy. Changing it re-indexes your documents.</small></label>
    <details><summary>Advanced</summary>
      ${num('min_similarity', 'Closeness in meaning needed (0 to 1)', 0, 1, 0.01, 'Below this, and with no matching words, it says "I don\'t know".')}
      ${num('top_k', 'Sections sent to the model', 1, 12, 1, 'More gives more context but costs more.')}
      ${num('min_coverage', 'Relevance needed (0 to 1)', 0, 1, 0.05, 'Below this, it refuses without calling the model.')}
      ${num('chunk_tokens', 'Section size', 100, 1500, 50, 'Changing this re-splits your documents.')}
      ${num('overlap_tokens', 'Section overlap', 0, 300, 10, 'Shared text between neighbouring sections.')}
      ${num('daily_cap', 'Public questions per day', 1, 100000, 10, 'Protects your OpenRouter key from heavy use.')}</details>
    <div><button class="btn primary" id="s-save">Save settings</button> <button class="btn danger" id="s-del">Delete assistant</button></div></div>`;
  $('#s-save').onclick = async () => {
    const config = {};
    $('#rag-pane').querySelectorAll('[data-k]').forEach((el) => { config[el.dataset.k] = el.type === 'number' ? Number(el.value) : el.value; });
    try { const docs = a.docs; R.app = await api('PATCH', `/api/rag/apps/${a.id}`, { name: $('#s-name').value, config }); R.app.docs = (await api('GET', `/api/rag/apps/${a.id}`)).docs; toast('Saved'); drawApp(); } catch (e) { fail(e); }
  };
  $('#s-del').onclick = async () => {
    if (!confirm(`Delete "${a.name}" and all its documents and history?`)) return;
    try { await api('DELETE', `/api/rag/apps/${a.id}`); location.hash = '#/assistants'; } catch (e) { fail(e); }
  };
}

// ---- publish ----
async function panePublish() {
  const { $, esc, api, fail, toast } = H;
  const a = R.app;
  const origin = location.origin + H.base;
  const snippet = (token) => `<script src="${origin}/embed.js" data-assistant="${a.id}" data-key="${token}" data-title="${esc(a.name)}" async></script>`;
  $('#rag-pane').innerHTML = '<div class="muted">Loading…</div>';
  let q; try { q = await api('GET', `/api/rag/apps/${a.id}/quality`); } catch (e) { return fail(e); }
  const g = q.gate;
  $('#rag-pane').innerHTML = `<div class="rag-form">
    <div class="rag-gate ${g.ok ? 'ok' : 'stop'}" id="p-gate"><b>${g.ok ? '✓ Ready to publish' : '✕ Not ready to publish'}</b><div>${esc(g.reason)}</div>
      ${g.ok ? '' : '<div style="margin-top:8px"><button class="btn small" id="p-check">Go to quality check</button></div>'}</div>
    <p class="muted small">Publishing gives you a key. Visitors' questions run on <b>your</b> OpenRouter key (set in Settings), so there is a daily limit and you choose which websites may use it.</p>
    <label class="rag-field"><span>Websites allowed to show the chat box</span><textarea class="textarea" id="p-origins" rows="2" placeholder="https://www.mybakery.com">${esc(a.allowed_origins.join('\n'))}</textarea><small class="muted">One per line. Include https://. Leave empty to block all websites (API use only).</small></label>
    <div><button class="btn" id="p-save">Save websites</button></div>
    <div class="rag-sep"></div>
    ${g.ok ? '' : '<label class="small"><input type="checkbox" id="p-override"> Publish anyway. I understand answers have not passed the quality check.</label>'}
    ${a.published ? `<p>Status: <span class="tag ok">live</span> key ending <code>${esc(a.token_last4)}</code></p><button class="btn" id="p-new">Create a new key</button> <button class="btn danger" id="p-off">Turn off</button>` : '<button class="btn primary" id="p-new">Publish and create key</button>'}
    <div id="p-out"></div></div>`;
  const chk = $('#p-check'); if (chk) chk.onclick = () => { R.tab = 'quality'; drawApp(); };
  $('#p-save').onclick = async () => { try { R.app = { ...(await api('PATCH', `/api/rag/apps/${a.id}`, { allowed_origins: $('#p-origins').value })), docs: a.docs }; toast('Saved'); drawApp(); } catch (e) { fail(e); } };
  const off = $('#p-off'); if (off) off.onclick = async () => { try { await api('DELETE', `/api/rag/apps/${a.id}/token`); R.app = { ...a, published: false, token_last4: null }; drawApp(); } catch (e) { fail(e); } };
  $('#p-new').onclick = async () => {
    if (a.published && !confirm('The old key stops working immediately. Continue?')) return;
    try {
      const { token } = await api('POST', `/api/rag/apps/${a.id}/token`, { override: !!$('#p-override')?.checked });
      R.app = { ...a, published: true, token_last4: token.slice(-4) };
      $('#p-out').innerHTML = `<h3>Add this to your website</h3><p class="small muted">Paste it just before the closing &lt;/body&gt; tag. The key is shown once.</p><pre class="rag-code">${esc(snippet(token))}</pre>
        <h3>Or call the API</h3><pre class="rag-code">curl -X POST ${esc(origin)}/pub/rag/${esc(a.id)}/query \\
  -H "X-RAG-Key: ${esc(token)}" -H "Content-Type: application/json" \\
  -d '{"question":"What are your opening hours?"}'</pre>`;
    } catch (e) { fail(e); if (e.data?.code === 'gate') { $('#p-gate').scrollIntoView({ block: 'nearest' }); } }
  };
}

// ---- question log ----
async function paneLog() {
  const { $, esc, api, fail } = H;
  $('#rag-pane').innerHTML = '<div class="muted">Loading…</div>';
  try { R.queries = await api('GET', `/api/rag/apps/${R.app.id}/queries`); } catch (e) { return fail(e); }
  const q = R.queries;
  if (!q.length) { $('#rag-pane').innerHTML = '<div class="muted">No questions yet. Try the Test tab, or publish and share the chat box.</div>'; return; }
  const refused = q.filter((x) => x.refused).length, flagged = q.filter((x) => x.flags.length).length, bad = q.filter((x) => x.rating === -1).length;
  $('#rag-pane').innerHTML = `<div class="rag-stats"><div><b>${q.length}</b><span>questions</span></div><div><b>${Math.round((refused / q.length) * 100)}%</b><span>could not answer</span></div><div><b>${flagged}</b><span>safety checks fired</span></div><div><b>${bad}</b><span>thumbs down</span></div></div>
    <table class="rag-table"><thead><tr><th>When</th><th>Question</th><th>Answer</th><th>Checks</th></tr></thead><tbody>${q.map((x) => `<tr><td class="small">${fmtDate(x.created_at)}<br><span class="muted">${esc(x.source)}</span></td><td>${esc(x.question)}</td>
      <td>${esc(x.answer.slice(0, 220))}${x.answer.length > 220 ? '…' : ''}${x.rating ? (x.rating === 1 ? ' 👍' : ' 👎') : ''}</td>
      <td>${x.flags.map((f) => `<span class="tag busy">${esc(FLAG_TEXT[f] || f)}</span>`).join(' ') || (x.refused ? '<span class="tag">refused</span>' : '')}</td></tr>`).join('')}</tbody></table>`;
}

// ---------- shared bits ----------
const STATUS = { pass: ['✓', 'Pass', 'ok'], fail: ['✕', 'Fail', 'bad'], na: ['–', 'Not measured', 'na'] };
const chip = (st) => { const [i, l, c] = STATUS[st] || STATUS.na; return `<span class="rag-chip ${c}"><span aria-hidden="true">${i}</span> ${l}</span>`; };
function fmtVal(v, unit) {
  if (v == null) return '–';
  if (unit === 'pct') return `${Math.round(v * 100)}%`;
  if (unit === 'of4') return `${v.toFixed(1)} / 4`;
  if (unit === 'ms') return `${(v / 1000).toFixed(1)} s`;
  if (unit === 'num') return v.toFixed(2);
  return String(v);
}
const fmtTarget = (r) => `${r.op === '>=' ? '≥' : '≤'} ${fmtVal(r.target, r.unit)}`;
const modelSelect = (id, selected, extra = '') => `<select class="select" id="${id}" ${extra}>${modelOptions(selected)}</select>`;
const KIND_LABEL = { answerable: 'Documents can answer', unanswerable: 'Not in documents', redteam: 'Attack' };
const OUTLIER_LABEL = { over_refusal: 'Said "I don\'t know" wrongly', wrong_number: 'Wrong number', retrieval_miss: 'Passage not found', wrong_answer: 'Wrong answer', unsupported: 'Not backed by documents', hallucination_risk: 'Guessed instead of saying "I don\'t know"',
  redteam_fail: 'Attack got through', judge_disagreement: 'Checks disagree', slow: 'Slow', error: 'Model error' };

// ---- test set ----
async function paneTests() {
  const { $, esc, api, fail, toast } = H;
  const a = R.app;
  $('#rag-pane').innerHTML = '<div class="muted">Loading…</div>';
  let tests; try { tests = await api('GET', `/api/rag/apps/${a.id}/tests`); } catch (e) { return fail(e); }
  const approved = tests.filter((t) => t.approved), pending = tests.filter((t) => !t.approved);
  $('#rag-pane').innerHTML = `<p class="muted small">Test questions are what the quality check asks. Each one has the <b>correct answer</b> you approve, so answers can be marked right or wrong. Include a few questions your documents do <b>not</b> cover, to check it says "I don't know". ${'12 built-in attack questions always run as well.'}</p>
    <div class="rag-actions"><button class="btn primary" id="t-gen">✨ Draft questions from my documents</button>
      ${pending.length ? `<button class="btn" id="t-approve">Approve all ${pending.length} drafts</button>` : ''}
      <span class="muted small">${approved.length} approved (${approved.filter((t) => t.kind === 'answerable').length} answerable, ${approved.filter((t) => t.kind === 'unanswerable').length} not in documents)${pending.length ? `, ${pending.length} waiting for your review` : ''}</span></div>
    <details class="rag-paste" id="t-add"><summary>Add a question</summary>
      <input class="input" id="t-q" placeholder="A question a customer would ask">
      <label class="small"><input type="radio" name="t-kind" value="answerable" checked> My documents can answer this</label> <label class="small"><input type="radio" name="t-kind" value="unanswerable"> My documents do NOT cover this (it should say it doesn't know)</label>
      <textarea class="textarea" id="t-a" rows="2" placeholder="The correct answer, in your words"></textarea><button class="btn" id="t-save">Add question</button></details>
    <div class="rag-scroll"><table class="rag-table"><thead><tr><th style="width:34%">Question</th><th style="width:34%">Correct answer</th><th>Type</th><th></th></tr></thead><tbody>${tests.length ? tests.map((t) => `<tr class="${t.approved ? '' : 'draft'}">
      <td><textarea class="textarea rag-cell" rows="2" data-t="${esc(t.id)}" data-f="question">${esc(t.question)}</textarea></td>
      <td>${t.kind === 'unanswerable' ? '<span class="muted small">Should say it does not know</span>' : `<textarea class="textarea rag-cell" rows="2" data-t="${esc(t.id)}" data-f="expected_answer">${esc(t.expected_answer)}</textarea>`}${t.source_doc ? `<div class="muted small">From ${esc(t.source_doc)}</div>` : ''}</td>
      <td><span class="tag">${esc(KIND_LABEL[t.kind])}</span>${t.approved ? '' : ' <span class="tag busy">draft</span>'}<div class="muted small">${esc(t.origin)}</div></td>
      <td>${t.approved ? '' : `<button class="btn small" data-ok="${esc(t.id)}">Approve</button> `}<button class="btn small ghost danger" data-rm="${esc(t.id)}">Delete</button></td></tr>`).join('')
      : '<tr><td colspan="4" class="muted">No test questions yet. Click "Draft questions" and the AI will write some from your documents for you to review.</td></tr>'}</tbody></table></div>`;
  const reload = () => paneTests();
  $('#t-gen').onclick = async () => {
    const b = $('#t-gen'); b.disabled = true; b.textContent = 'Writing questions…';
    try { const r = await api('POST', `/api/rag/apps/${a.id}/tests/generate`, {}); toast(`Drafted ${r.added} questions (${r.answerable} answerable). Review them, then approve.`); } catch (e) { fail(e); }
    reload();
  };
  const ap = $('#t-approve'); if (ap) ap.onclick = async () => { try { await api('POST', `/api/rag/apps/${a.id}/tests/approve-all`); } catch (e) { fail(e); } reload(); };
  $('#t-save').onclick = async () => {
    try { await api('POST', `/api/rag/apps/${a.id}/tests`, { question: $('#t-q').value, expected_answer: $('#t-a').value, kind: document.querySelector('input[name="t-kind"]:checked').value }); toast('Added'); reload(); } catch (e) { fail(e); }
  };
  $('#rag-pane').querySelectorAll('[data-ok]').forEach((b) => (b.onclick = async () => { try { await api('PATCH', `/api/rag/tests/${b.dataset.ok}`, { approved: true }); } catch (e) { fail(e); } reload(); }));
  $('#rag-pane').querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { try { await api('DELETE', `/api/rag/tests/${b.dataset.rm}`); } catch (e) { fail(e); } reload(); }));
  $('#rag-pane').querySelectorAll('.rag-cell').forEach((el) => (el.onchange = async () => { try { await api('PATCH', `/api/rag/tests/${el.dataset.t}`, { [el.dataset.f]: el.value }); toast('Saved'); } catch (e) { fail(e); } }));
}

// ---- quality dashboard ----
function ringSVG(v, ok) {
  const r = 52, c = 2 * Math.PI * r, f = v == null ? 0 : Math.max(0, Math.min(1, v / 100));
  const col = v == null ? 'var(--border)' : ok ? 'var(--ok)' : v >= 60 ? 'var(--warn)' : 'var(--err)';
  return `<svg viewBox="0 0 130 130" class="rag-ring" role="img" aria-label="Health score ${v == null ? 'not measured' : v + ' out of 100'}"><circle cx="65" cy="65" r="${r}" fill="none" stroke="var(--border)" stroke-width="10"/>
    <circle cx="65" cy="65" r="${r}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 65 65)"/>
    <text x="65" y="64" text-anchor="middle" font-size="30" font-weight="700" fill="var(--text)">${v == null ? '–' : v}</text><text x="65" y="84" text-anchor="middle" font-size="11" fill="var(--muted)">out of 100</text></svg>`;
}

function trendSVG(runs) {
  const { esc } = H;
  const pts = runs.filter((r) => r.status === 'done' && r.health != null).slice().reverse();
  if (pts.length < 2) return '<div class="muted small">Run the quality check at least twice to see how it changes over time.</div>';
  const W = 640, Ht = 200, L = 36, Rr = 16, T = 26, B = 28, n = pts.length;
  // A line chart may start above zero so small changes are visible. Say so on the chart when it does.
  const lo = Math.max(0, Math.floor((Math.min(...pts.map((p) => p.health)) - 10) / 10) * 10);
  const x = (i) => L + ((W - L - Rr) * i) / (n - 1), y = (v) => T + (Ht - T - B) * (1 - (v - lo) / (100 - lo));
  const d = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const ticks = [...new Set([lo, Math.round((lo + 100) / 20) * 10, 100])];
  const last = pts[n - 1];
  return `<div class="rag-trend" id="rag-trend"><svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="Health score across ${n} quality checks, from ${pts[0].health} to ${last.health}">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${v}</text>`).join('')}
    <polyline points="${pts.map((p, i) => `${x(i)},${y(p.health)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.health)}" r="5" fill="var(--accent)" stroke="var(--panel)" stroke-width="2"/><circle class="hit" data-i="${i}" cx="${x(i)}" cy="${y(p.health)}" r="14" fill="transparent" tabindex="0" aria-label="${esc(d(p.created_at))}: health ${p.health}"/>`).join('')}
    <text x="${x(n - 1)}" y="${y(last.health) - 12}" text-anchor="end" font-size="12" font-weight="600" fill="var(--text)">${last.health}</text>
    <text x="${L}" y="${Ht - 6}" font-size="11" fill="var(--muted)">${esc(d(pts[0].created_at))}</text><text x="${W - Rr}" y="${Ht - 6}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(d(last.created_at))}</text></svg>
    ${lo > 0 ? `<div class="muted small">Scale starts at ${lo}, not 0.</div>` : ''}<div class="rag-tip" hidden></div></div>`;
}

async function paneQuality() {
  const { $, esc, api, fail, toast } = H;
  const a = R.app;
  $('#rag-pane').innerHTML = '<div class="muted">Loading…</div>';
  let q; try { q = R.quality = await api('GET', `/api/rag/apps/${a.id}/quality`); } catch (e) { return fail(e); }
  const sm = q.latest?.summary;
  const m = sm?.metrics || {};
  const rule = (id) => q.rules.find((r) => r.id === id);
  const card = (id, label) => { const r = rule(id); return `<div class="rag-metric"><span class="muted small">${label}</span><b>${fmtVal(r.value, r.unit)}</b><span class="small">${chip(r.status)} <span class="muted">target ${fmtTarget(r)}</span></span></div>`; };
  const g = q.gate;
  let detail = null;
  if (q.latest) { try { detail = await api('GET', `/api/rag/eval/runs/${q.latest.id}`); } catch { /* optional */ } }
  const live = q.live;
  $('#rag-pane').innerHTML = `
    <div class="rag-top">${ringSVG(sm?.health ?? null, g.ok)}
      <div class="rag-top-text"><div class="rag-gate ${g.ok ? 'ok' : q.latest ? 'stop' : 'na'}"><b>${g.ok ? '✓ Ready to publish' : q.latest ? '✕ Not ready to publish' : '– Not checked yet'}</b><div>${esc(g.reason)}</div></div>
        ${q.latest ? `<div class="muted small">Last checked ${fmtDate(q.latest.created_at)} with ${esc(q.latest.model)}, judged by ${esc(q.latest.judge_model)}. ${q.current ? '' : '<b>Your settings or documents changed since then.</b>'}</div>` : ''}
        <div class="rag-run"><label class="small muted">AI judge</label>${modelSelect('q-judge', q.latest?.judge_model || a.config.model, 'style="max-width:300px"')}
          <button class="btn primary" id="q-run" ${q.running ? 'disabled' : ''}>${q.running ? 'Checking…' : q.latest ? 'Run quality check again' : 'Run quality check'}</button></div>
        <div class="rag-progress" id="q-prog" ${q.running ? '' : 'hidden'}><div style="width:${q.running ? Math.round((q.running.done / Math.max(1, q.running.total)) * 100) : 0}%"></div></div>
        <div class="muted small">Asks your ${q.tests.approved} test questions plus 12 attack questions, then scores every answer against the rules below. The judge should be a different, strong model where possible.</div></div></div>
    ${sm ? `<div class="rag-metrics">${card('RET1', 'Finds the right passage')}${card('ANS2', 'Answers correctly')}${card('ANS1', 'Backed by documents')}${card('ANS6', 'Refuses wrongly')}${card('ANS7', 'Admits not knowing')}${card('SAF1', 'Resists attacks')}</div>` : ''}
    ${q.suggestions.length ? `<h3>What to improve</h3><div class="rag-sugg">${q.suggestions.map((s, i) => `<div class="rag-card2 sev${s.severity >= 4 ? 'hi' : s.severity >= 3 ? 'mid' : 'lo'}"><div><b>${esc(s.title)}</b><div class="small muted">${esc(s.why)}</div></div>${s.action ? `<button class="btn small ${s.action.type === 'config' ? 'primary' : ''}" data-sg="${i}">${esc(s.action.label || 'Do it')}</button>` : ''}</div>`).join('')}</div>` : ''}
    ${sm ? `<h3>All evaluation rules</h3><div class="rag-scroll"><table class="rag-table rag-rules"><thead><tr><th>Rule</th><th>How it is checked</th><th>Target</th><th>Result</th><th>Status</th></tr></thead><tbody>${['Finding the answer', 'Answer quality', 'Safety', 'Reliability'].map((grp) =>
      `<tr class="grp"><td colspan="5">${esc(grp)}</td></tr>` + q.rules.filter((r) => r.group === grp).map((r) => `<tr><td><b>${esc(r.id)}</b> ${esc(r.name)}${r.gate ? ' <span class="tag busy" title="Publishing is blocked until this passes">required</span>' : ''}</td><td class="small muted">${esc(r.how)}</td><td>${fmtTarget(r)}</td><td${r.detail ? ' class="wrap"' : ''}><b>${r.detail ? esc(r.detail) : fmtVal(r.value, r.unit)}</b></td><td>${chip(r.status)}</td></tr>`).join('')).join('')}</tbody></table></div>` : ''}
    ${q.runs.length ? `<h3>History</h3>${trendSVG(q.runs)}<div class="rag-scroll"><table class="rag-table"><thead><tr><th>When</th><th>Model</th><th>Judge</th><th>Health</th><th>Publish check</th><th></th></tr></thead><tbody>${q.runs.map((r) => `<tr><td>${fmtDate(r.created_at)}</td><td class="small">${esc(r.model)}</td><td class="small">${esc(r.judge_model)}</td>
      <td><b>${r.health ?? '–'}</b></td><td>${r.status === 'running' ? `Running ${r.done}/${r.total}` : r.status === 'failed' ? `<span class="tag busy">failed</span> ${esc(r.error || '')}` : chip(r.gate_ok ? 'pass' : 'fail')}</td><td>${r.current ? '<span class="tag ok">current settings</span>' : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${detail?.outliers?.length ? `<h3>Cases to look at</h3><p class="muted small">Unusual or failing answers from the last check. Open one to see exactly what was asked, what the assistant said and why it was flagged.</p>
      <div class="rag-outliers">${detail.outliers.map((o) => { const r = detail.results.find((x) => x.id === o.result_id); return `<details class="rag-out"><summary><span class="tag busy">${esc(OUTLIER_LABEL[o.type] || o.type)}</span> ${esc(o.question)}</summary>
        <div class="small"><p><b>Why flagged:</b> ${esc(o.why)}</p>${r ? `<p><b>Assistant said:</b> ${esc(r.answer || '(no answer)')}</p>${r.expected_answer ? `<p><b>Correct answer:</b> ${esc(r.expected_answer)}</p>` : ''}${r.judge ? `<p><b>Judge:</b> grounded ${r.judge.groundedness}/4 · correct ${r.judge.correctness}/4 · complete ${r.judge.completeness}/4. ${esc(r.judge.reason || '')}</p>` : ''}
          ${(r.flags || []).length ? `<p><b>Checks that fired:</b> ${r.flags.map((f) => esc(FLAG_TEXT[f] || f)).join(', ')}</p>` : ''}
          ${r.sources.length ? `<details><summary>${r.sources.length} passages it was given</summary>${r.sources.map((s, i) => `<div class="rag-snip"><b>[${i + 1}] ${esc(s.doc_name)}${s.heading ? ' · ' + esc(s.heading) : ''}</b><div>${esc(s.text)}</div></div>`).join('')}</details>` : ''}` : ''}</div></details>`; }).join('')}</div>` : ''}
    ${live && live.total ? `<h3>From real use</h3><p class="muted small">${live.total} recent questions (${esc(live.from)}). Could not answer: ${Math.round((live.refused_rate || 0) * 100)}%. Safety checks fired: ${live.flagged}. Thumbs down: ${live.thumbs_down}.${live.latency_p95 >= 1000 ? ` Slowest 5% took over ${(live.latency_p95 / 1000).toFixed(1)} s.` : ''}</p>
      ${live.gaps.length ? `<div class="rag-gaps"><b class="small">Topics customers ask about that no document covers</b>${live.gaps.map((g2) => `<div class="small">• <b>${esc(g2.topic)}</b> (${g2.count}): ${g2.examples.map((e) => `"${esc(e)}"`).join(', ')}</div>`).join('')}</div>` : ''}
      ${live.low_rated.length ? `<div class="rag-gaps"><b class="small">Answers marked bad. Turn them into permanent tests.</b>${live.low_rated.map((l) => `<div class="rag-lr small"><div>"${esc(l.question)}"<div class="muted">${esc((l.answer || '').slice(0, 160))}</div></div><span><input class="input" placeholder="Correct answer" data-lra="${esc(l.id)}"> <button class="btn small" data-lr="${esc(l.id)}">Add to test set</button></span></div>`).join('')}</div>` : ''}
      ${live.repeated.length ? `<div class="rag-gaps"><b class="small">Asked again and again</b>${live.repeated.map((r) => `<div class="small">• "${esc(r.question)}" × ${r.count}</div>`).join('')}</div>` : ''}` : ''}
    ${q.overlaps.length ? `<h3>Possible conflicts between documents</h3><p class="muted small">These topics appear in more than one document. If the details differ, customers may get different answers.</p>${q.overlaps.map((o) => `<div class="small">• <b>${esc(o.heading)}</b> in ${o.docs.map(esc).join(' and ')}</div>`).join('')}` : ''}`;

  // actions
  const start = async () => {
    const b = $('#q-run'); b.disabled = true;
    try { await api('POST', `/api/rag/apps/${a.id}/eval/run`, { judge_model: $('#q-judge').value || undefined }); } catch (e) { fail(e); b.disabled = false; return; }
    watchRun();
  };
  $('#q-run').onclick = start;
  const watchRun = () => {
    clearInterval(R.poll);
    R.poll = setInterval(async () => {
      if (R.tab !== 'quality' || !document.querySelector('#q-prog')) return clearInterval(R.poll);
      try {
        const s = await api('GET', `/api/rag/apps/${a.id}/quality`);
        if (s.running) { const p = $('#q-prog'); p.hidden = false; p.firstElementChild.style.width = `${Math.round((s.running.done / Math.max(1, s.running.total)) * 100)}%`; $('#q-run').textContent = `Checking… ${s.running.done}/${s.running.total}`; $('#q-run').disabled = true; }
        else { clearInterval(R.poll); paneQuality(); }
      } catch { clearInterval(R.poll); }
    }, 1500);
  };
  if (q.running) watchRun();
  $('#rag-pane').querySelectorAll('[data-sg]').forEach((b) => (b.onclick = async () => {
    const act = q.suggestions[Number(b.dataset.sg)].action;
    if (act.type === 'run') return start();
    if (act.type === 'index') { try { await api('POST', `/api/rag/apps/${a.id}/search/index`); toast('Smart search updated'); paneQuality(); } catch (e) { fail(e); } return; }
    if (act.type === 'goto') { R.tab = act.tab; return drawApp(); }
    if (act.type === 'config') { try { R.app = { ...(await api('PATCH', `/api/rag/apps/${a.id}`, { config: act.patch })), docs: a.docs }; toast('Applied. Run the quality check again to see the effect.'); paneQuality(); } catch (e) { fail(e); } }
  }));
  $('#rag-pane').querySelectorAll('[data-lr]').forEach((b) => (b.onclick = async () => {
    const ans = document.querySelector(`[data-lra="${b.dataset.lr}"]`).value;
    try { await api('POST', `/api/rag/apps/${a.id}/tests/from`, { query_id: b.dataset.lr, expected_answer: ans }); toast('Added to your test set'); b.disabled = true; } catch (e) { fail(e); }
  }));
  const tr = $('#rag-trend');
  if (tr) {
    const pts = q.runs.filter((r) => r.status === 'done' && r.health != null).slice().reverse(), tip = tr.querySelector('.rag-tip');
    tr.querySelectorAll('.hit').forEach((c) => {
      const show = () => { const p = pts[Number(c.dataset.i)]; const rc = c.getBoundingClientRect(), box = tr.getBoundingClientRect();
        tip.hidden = false; tip.textContent = `Health ${p.health} · ${p.model} · ${fmtDate(p.created_at)}`; tip.style.left = `${Math.min(rc.left - box.left, box.width - 240)}px`; tip.style.top = `${rc.top - box.top - 34}px`; };
      c.onmouseenter = show; c.onfocus = show; c.onmouseleave = () => (tip.hidden = true); c.onblur = () => (tip.hidden = true);
    });
  }
}
