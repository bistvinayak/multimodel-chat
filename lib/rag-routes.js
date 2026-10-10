// HTTP routes for the RAG builder: apps, documents, playground, and the public query endpoint
// that the embed widget and the hosted API use. server.js passes in its helpers.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chunkText, normalizeConfig, answerQuestion, maskPII, DEFAULT_CONFIG } from './rag.js';
import { embedTexts, pack, unpack } from './embeddings.js';
import { RULES, RED_TEAM, evaluateCase, judgeMessages, parseJudge, generationMessages, unanswerableMessages, parseGenerated, parseUnanswerable,
  sampleChunks, summarize, findOutliers, liveInsights, suggest, fingerprint, overlappingTopics } from './rag-eval.js';

const TEMPLATES = {
  support: { label: 'Customer support', config: { tone: 'warm, patient and concise', strictness: 'strict', handoff_message: '' } },
  catalog: { label: 'Product catalog', config: { tone: 'helpful and precise about product details', strictness: 'strict', top_k: 6 } },
  policies: { label: 'Policies and HR', config: { tone: 'clear and neutral', strictness: 'strict', min_coverage: 0.4 } },
  booking: { label: 'Booking and hours', config: { tone: 'friendly and brief', strictness: 'strict', top_k: 4 } },
};

const SAMPLE_DOC = `# About us
Maple Street Bakery is a family-run bakery. We bake fresh bread, cakes and pastries every morning.

# Opening hours
We are open Monday to Friday from 7am to 6pm, Saturday from 8am to 3pm. We are closed on Sundays and public holidays.

# Delivery
We deliver within 10 km of the shop. Delivery costs $4.99, and is free for orders over $40. Orders placed before 2pm are delivered the same day.

# Custom cakes
Custom cakes need 3 days notice. A 20 cm cake serves 10 people and starts at $45. We can make eggs-free and gluten-free cakes with 5 days notice.

# Returns and refunds
If your order arrives damaged or wrong, contact us within 24 hours with a photo and we will replace it or refund you. Fresh food cannot be returned for change of mind.

# Allergies
Our kitchen handles nuts, milk, eggs, wheat and soy. We cannot guarantee that any item is completely free of traces.`;

// The embed script is cached for hours by Cloudflare, so its URL carries a hash of its contents: a changed file is a new URL.
const EMBED_VERSION = (() => { try { return crypto.createHash('sha256').update(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'embed.js'))).digest('hex').slice(0, 8); } catch { return '1'; } })();
const MAX_DOC_BYTES = 5 * 1024 * 1024;
const MAX_DOCS = 50;
const MAX_CHUNKS = 5000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashToken = (t) => sha(`rag-token:${t}`);

export function registerRag(d) {
  const { route, db, send, readJson, HttpError, uid, now, keyFor, chargeTrial, getModel, complete, detect, safeName, extractPdfText, userById, log } = d;

  const own = (user, id) => {
    const a = db.prepare('SELECT * FROM rag_apps WHERE id=? AND user_id=?').get(id, user.id);
    if (!a) throw new HttpError(404, 'Assistant not found');
    return a;
  };
  const cfgOf = (a) => normalizeConfig(JSON.parse(a.config || '{}'));
  const publicApp = (a) => ({
    id: a.id, name: a.name, config: cfgOf(a), published: !!a.published, token_last4: a.token_last4 || null,
    allowed_origins: JSON.parse(a.allowed_origins || '[]'), created_at: a.created_at, updated_at: a.updated_at, embed_version: EMBED_VERSION,
  });
  // Chunks with their vectors. Cached per assistant until its documents or search model change.
  const chunkCache = new Map();
  const chunksOf = (appId) => {
    const app = db.prepare('SELECT updated_at, config FROM rag_apps WHERE id=?').get(appId);
    const n = db.prepare('SELECT COUNT(*) n, COUNT(embedding) e FROM rag_chunks WHERE app_id=?').get(appId);
    const stamp = `${app?.updated_at}:${n.n}:${n.e}:${normalizeConfig(JSON.parse(app?.config || '{}')).embedding_model}`;
    const hit = chunkCache.get(appId);
    if (hit?.stamp === stamp) return hit.chunks;
    const model = normalizeConfig(JSON.parse(app?.config || '{}')).embedding_model;
    const rows = db.prepare(`SELECT c.id, c.doc_id, c.ord, c.heading, c.text, c.embedding, c.emb_model, d.name AS doc_name FROM rag_chunks c JOIN rag_docs d ON d.id=c.doc_id WHERE c.app_id=? ORDER BY d.created_at, c.ord`).all(appId);
    const chunks = rows.map(({ embedding, emb_model, ...r }) => ({ ...r, vec: embedding && model && emb_model === model ? unpack(embedding) : null }));
    chunkCache.set(appId, { stamp, chunks });
    if (chunkCache.size > 50) chunkCache.delete(chunkCache.keys().next().value);
    return chunks;
  };
  const searchStatus = (app) => {
    const model = cfgOf(app).embedding_model;
    const t = db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN embedding IS NOT NULL AND emb_model=? THEN 1 ELSE 0 END) e FROM rag_chunks WHERE app_id=?').get(model, app.id);
    return { model, enabled: !!model, total: t.n, embedded: t.e || 0 };
  };
  /** Embed every section that has no up-to-date vector. Never throws: a failure just leaves keyword search in charge. */
  async function embedPending(app, apiKey) {
    const model = cfgOf(app).embedding_model;
    if (!model || !apiKey) return searchStatus(app);
    const rows = db.prepare('SELECT id, heading, text FROM rag_chunks WHERE app_id=? AND (embedding IS NULL OR emb_model IS NOT ?)').all(app.id, model);
    if (rows.length) {
      try {
        const vecs = await embedTexts({ apiKey, model, inputs: rows.map((r) => `${r.heading ? r.heading + '\n' : ''}${r.text}`) });
        const up = db.prepare('UPDATE rag_chunks SET embedding=?, emb_model=? WHERE id=?');
        db.exec('BEGIN'); try { rows.forEach((r, i) => up.run(pack(vecs[i]), model, r.id)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      } catch (e) { log?.(`[rag] embedding failed: ${e.message}`); }
    }
    db.prepare('UPDATE rag_apps SET updated_at=? WHERE id=?').run(now(), app.id);
    return searchStatus(app);
  }
  const embedKeyFor = (user) => { try { return keyFor(user, { charged: true }).key; } catch { return null; } };

  function indexDoc(app, docId, text) {
    const cfg = cfgOf(app);
    const chunks = chunkText(text, cfg);
    const have = db.prepare('SELECT COUNT(*) n FROM rag_chunks WHERE app_id=? AND doc_id<>?').get(app.id, docId).n;
    if (have + chunks.length > MAX_CHUNKS) throw new HttpError(400, 'This assistant has reached its size limit. Remove a document first.');
    db.prepare('DELETE FROM rag_chunks WHERE doc_id=?').run(docId);
    const ins = db.prepare('INSERT INTO rag_chunks (id, app_id, doc_id, ord, heading, text) VALUES (?,?,?,?,?,?)');
    db.exec('BEGIN');
    try { for (const c of chunks) ins.run(uid(), app.id, docId, c.ord, c.heading, c.text); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    return chunks.length;
  }
  function addDoc(app, { name, kind, text }) {
    if (!text.trim()) throw new HttpError(400, 'That document has no readable text.');
    if (db.prepare('SELECT COUNT(*) n FROM rag_docs WHERE app_id=?').get(app.id).n >= MAX_DOCS) throw new HttpError(400, `At most ${MAX_DOCS} documents per assistant.`);
    const hash = sha(text);
    const dup = db.prepare('SELECT id FROM rag_docs WHERE app_id=? AND sha256=?').get(app.id, hash);
    if (dup) throw new HttpError(409, 'This document is already added.');
    const id = uid();
    db.prepare('INSERT INTO rag_docs (id, app_id, name, kind, char_count, sha256, content, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, app.id, name, kind, text.length, hash, text, now());
    try { const n = indexDoc(app, id, text); db.prepare('UPDATE rag_apps SET updated_at=? WHERE id=?').run(now(), app.id); return { id, name, chunks: n }; }
    catch (e) { db.prepare('DELETE FROM rag_docs WHERE id=?').run(id); throw e; }
  }
  const reindexAll = (app) => { for (const doc of db.prepare('SELECT id, content FROM rag_docs WHERE app_id=?').all(app.id)) indexDoc(app, doc.id, doc.content); };

  // ---------- apps ----------
  route('GET', '/api/rag/apps', async (req, res, { user }) => {
    const rows = db.prepare('SELECT * FROM rag_apps WHERE user_id=? ORDER BY updated_at DESC').all(user.id);
    send(res, 200, { templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label })), apps: rows.map((a) => ({
      ...publicApp(a),
      docs: db.prepare('SELECT COUNT(*) n FROM rag_docs WHERE app_id=?').get(a.id).n,
      queries: db.prepare('SELECT COUNT(*) n FROM rag_queries WHERE app_id=?').get(a.id).n })) });
  });

  route('POST', '/api/rag/apps', async (req, res, { user }) => {
    const { name, template, sample } = await readJson(req);
    if (db.prepare('SELECT COUNT(*) n FROM rag_apps WHERE user_id=?').get(user.id).n >= 20) throw new HttpError(400, 'At most 20 assistants.');
    const id = uid(), t = now();
    const config = normalizeConfig({ ...(TEMPLATES[template]?.config || {}), business_name: String(name || '').slice(0, 120) });
    db.prepare('INSERT INTO rag_apps (id, user_id, name, config, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, user.id, String(name || 'My assistant').trim().slice(0, 120) || 'My assistant', JSON.stringify(config), t, t);
    const app = db.prepare('SELECT * FROM rag_apps WHERE id=?').get(id);
    if (sample) { addDoc(app, { name: 'Sample: Maple Street Bakery FAQ.md', kind: 'paste', text: SAMPLE_DOC }); await embedPending(app, embedKeyFor(user)); }
    send(res, 201, publicApp(app));
  });

  route('GET', '/api/rag/apps/:id', async (req, res, { user, params }) => {
    const a = own(user, params.id);
    const docs = db.prepare('SELECT d.id, d.name, d.kind, d.char_count, d.created_at, (SELECT COUNT(*) FROM rag_chunks c WHERE c.doc_id=d.id) AS chunks FROM rag_docs d WHERE d.app_id=? ORDER BY d.created_at').all(a.id);
    send(res, 200, { ...publicApp(a), docs, search: searchStatus(a) });
  });

  route('POST', '/api/rag/apps/:id/search/index', async (req, res, { user, params }) => {
    const a = own(user, params.id);
    const key = embedKeyFor(user);
    if (!key) throw new HttpError(402, 'Smart search needs your OpenRouter key. Add it in Settings.', { code: 'needs_key' });
    send(res, 200, await embedPending(a, key));
  });

  route('PATCH', '/api/rag/apps/:id', async (req, res, { user, params }) => {
    const a = own(user, params.id);
    const body = await readJson(req);
    const before = cfgOf(a);
    const config = body.config ? normalizeConfig(body.config, before) : before;
    const name = body.name != null ? String(body.name).trim().slice(0, 120) || a.name : a.name;
    let origins = JSON.parse(a.allowed_origins || '[]');
    if (body.allowed_origins) {
      origins = (Array.isArray(body.allowed_origins) ? body.allowed_origins : String(body.allowed_origins).split(/[\s,]+/))
        .map((o) => { try { return new URL(String(o).trim()).origin; } catch { return ''; } }).filter(Boolean).slice(0, 20);
    }
    db.prepare('UPDATE rag_apps SET name=?, config=?, allowed_origins=?, updated_at=? WHERE id=?').run(name, JSON.stringify(config), JSON.stringify(origins), now(), a.id);
    const fresh = db.prepare('SELECT * FROM rag_apps WHERE id=?').get(a.id);
    if (config.chunk_tokens !== before.chunk_tokens || config.overlap_tokens !== before.overlap_tokens) reindexAll(fresh);
    if (config.embedding_model !== before.embedding_model || config.chunk_tokens !== before.chunk_tokens || config.overlap_tokens !== before.overlap_tokens) await embedPending(fresh, embedKeyFor(user));
    send(res, 200, publicApp(fresh));
  });

  route('DELETE', '/api/rag/apps/:id', async (req, res, { user, params }) => {
    own(user, params.id);
    db.prepare('DELETE FROM rag_apps WHERE id=?').run(params.id);
    send(res, 200, { ok: true });
  });

  // ---------- documents ----------
  route('POST', '/api/rag/apps/:id/docs', async (req, res, { user, params }) => {
    const a = own(user, params.id);
    const { name, text } = await readJson(req);
    const added = addDoc(a, { name: safeName(name || 'Pasted text'), kind: 'paste', text: String(text || '') });
    send(res, 201, { ...added, search: await embedPending(a, embedKeyFor(user)) });
  });

  route('POST', '/api/rag/apps/:id/upload', async (req, res, { user, params }) => {
    const a = own(user, params.id);
    const name = safeName(decodeURIComponent(String(req.headers['x-filename'] || 'file')));
    const parts = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_DOC_BYTES) throw new HttpError(413, 'Documents can be at most 5 MB.'); parts.push(c); }
    const buf = Buffer.concat(parts);
    const kind = detect(buf, name);
    if (!kind || kind.kind === 'image') throw new HttpError(400, 'Upload a PDF, text, markdown or CSV file.');
    let text = kind.text;
    if (kind.kind === 'pdf') {
      const cfg = cfgOf(a);
      const dir = await mkdtemp(path.join(os.tmpdir(), 'rag-'));
      try {
        const file = path.join(dir, 'doc.pdf');
        await writeFile(file, buf, { mode: 0o600 });
        await chargeTrial(user, []);
        text = await extractPdfText({ apiKey: keyFor(user, { charged: true }).key, model: cfg.model || 'openrouter/auto', filePath: file, filename: name });
      } catch (e) { throw e instanceof HttpError ? e : new HttpError(422, `Could not read that PDF: ${e.message}`); }
      finally { await rm(dir, { recursive: true, force: true }); }
    }
    const added = addDoc(a, { name, kind: 'file', text });
    send(res, 201, { ...added, search: await embedPending(a, embedKeyFor(user)) });
  });

  route('GET', '/api/rag/apps/:id/docs/:doc', async (req, res, { user, params }) => {
    own(user, params.id);
    const doc = db.prepare('SELECT id, name, content FROM rag_docs WHERE id=? AND app_id=?').get(params.doc, params.id);
    if (!doc) throw new HttpError(404, 'Document not found');
    send(res, 200, { id: doc.id, name: doc.name, text: doc.content });
  });

  route('DELETE', '/api/rag/apps/:id/docs/:doc', async (req, res, { user, params }) => {
    own(user, params.id);
    db.prepare('DELETE FROM rag_docs WHERE id=? AND app_id=?').run(params.doc, params.id);
    db.prepare('UPDATE rag_apps SET updated_at=? WHERE id=?').run(now(), params.id);
    send(res, 200, { ok: true });
  });

  // ---------- asking ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RETRY_MS = Number(process.env.RAG_EVAL_RETRY_MS ?? 2500);
  /**
   * One model call. Patient by default (quality checks can wait): retried twice, since thinking models can spend the whole
   * token budget reasoning and return nothing. In `quick` mode (a person is watching) it gives up fast: one retry, a short
   * timeout, and a timeout is final, so the screen can say "too slow, try another model" instead of hanging for a minute.
   */
  const QUICK_TIMEOUT_MS = Number(process.env.RAG_QUICK_TIMEOUT_MS ?? 25_000);
  async function llm({ apiKey, model, messages, maxTokens, quick = false }) {
    let tokens = maxTokens; const tries = quick ? 2 : 3;
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await complete({ apiKey, model, messages, maxTokens: tokens, timeoutMs: quick ? QUICK_TIMEOUT_MS : 90_000 });
        if (process.env.RAG_DEBUG_RAW) console.log(`[rag raw] ${model} (max ${tokens}): ${JSON.stringify(out).slice(0, 600)}`);
        if (out.trim()) return out;
        throw Object.assign(new Error('The model sent an empty reply. It may have used its whole budget thinking.'), { kind: 'empty' });
      } catch (e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') throw Object.assign(new Error('The model took too long to answer.'), { kind: 'timeout' });
        if (attempt >= tries - 1 || ['invalid_key', 'no_key', 'safety', 'insufficient_credits'].includes(e.kind)) throw e;
        if (e.kind === 'empty') tokens = Math.min(8000, Math.round(tokens * 2.5));
        await sleep(quick ? Math.min(RETRY_MS, 1000) : RETRY_MS * (attempt + 1));
      }
    }
  }
  const answerFor = (app, chunks, question, model, apiKey, { quick = false } = {}) => {
    const cfg = cfgOf(app);
    return answerQuestion({ chunks, question, config: { ...cfg, model },
      complete: (messages, { maxTokens }) => llm({ apiKey, model, messages, maxTokens, quick }),
      embed: cfg.embedding_model ? (q) => embedTexts({ apiKey, model: cfg.embedding_model, inputs: [q], retryMs: 400 }).then((v) => v[0]) : null });
  };

  async function ask({ app, owner, question, source, model, apiKey, quick = false }) {
    const cfg = cfgOf(app);
    const useModel = String(model || cfg.model || '').trim();
    if (!useModel) throw new HttpError(400, 'Pick a model for this assistant first.');
    const chunks = chunksOf(app.id);
    if (!chunks.length) throw new HttpError(400, 'Add at least one document first.');
    const result = await answerFor(app, chunks, question, useModel, apiKey, { quick });
    const qid = uid();
    db.prepare(`INSERT INTO rag_queries (id, app_id, source, question, answer, sources, cited, flags, refused, coverage, top_score, model, latency_ms, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(qid, app.id, source, maskPII(question).slice(0, 2000), result.answer, JSON.stringify(result.sources.map((s) => ({ doc: s.doc_name, heading: s.heading, score: s.score }))),
        JSON.stringify(result.cited), JSON.stringify(result.flags), result.refused ? 1 : 0, result.coverage, result.top_score, useModel, result.latency_ms, now());
    return { ...result, query_id: qid, model: useModel };
  }

  route('POST', '/api/rag/apps/:id/ask', async (req, res, { user, params }) => {
    const a = own(user, params.id);
    const { question, model, quick } = await readJson(req);
    const q = String(question || '').trim();
    if (!q) throw new HttpError(400, 'Type a question.');
    const useModel = String(model || cfgOf(a).model || '').trim();
    if (!useModel) throw new HttpError(400, 'Pick a model for this assistant first.');
    if (!chunksOf(a.id).length) throw new HttpError(400, 'Add at least one document first.');
    await chargeTrial(user, [useModel]);
    send(res, 200, await ask({ app: a, owner: user, question: q, source: 'playground', model: useModel, apiKey: keyFor(user, { charged: true }).key, quick: quick === true }));
  });

  route('GET', '/api/rag/apps/:id/queries', async (req, res, { user, params }) => {
    own(user, params.id);
    const rows = db.prepare('SELECT * FROM rag_queries WHERE app_id=? ORDER BY created_at DESC LIMIT 100').all(params.id);
    send(res, 200, rows.map((r) => ({ ...r, sources: JSON.parse(r.sources), cited: JSON.parse(r.cited), flags: JSON.parse(r.flags), refused: !!r.refused })));
  });

  route('PATCH', '/api/rag/queries/:id', async (req, res, { user, params }) => {
    const q = db.prepare('SELECT q.id FROM rag_queries q JOIN rag_apps a ON a.id=q.app_id WHERE q.id=? AND a.user_id=?').get(params.id, user.id);
    if (!q) throw new HttpError(404, 'Not found');
    const { rating } = await readJson(req);
    db.prepare('UPDATE rag_queries SET rating=? WHERE id=?').run(rating === 1 || rating === -1 ? rating : null, q.id);
    send(res, 200, { ok: true });
  });

  // ---------- publishing ----------
  route('POST', '/api/rag/apps/:id/token', async (req, res, { user, params }) => {
    const a = own(user, params.id);
    const { override } = await readJson(req);
    if (!cfgOf(a).model) throw new HttpError(400, 'Choose a model in Settings before publishing.');
    if (!db.prepare('SELECT 1 FROM rag_docs WHERE app_id=? LIMIT 1').get(a.id)) throw new HttpError(400, 'Add at least one document before publishing.');
    const gate = gateNow(a);
    if (!gate.ok && override !== true) throw new HttpError(409, gate.reason, { code: 'gate', gate });
    const token = `rag_${crypto.randomBytes(24).toString('base64url')}`;
    db.prepare('UPDATE rag_apps SET token_hash=?, token_last4=?, published=1, updated_at=? WHERE id=?').run(hashToken(token), token.slice(-4), now(), a.id);
    send(res, 200, { token, note: 'Copy this now. It is shown once.', overridden: !gate.ok });
  });
  route('DELETE', '/api/rag/apps/:id/token', async (req, res, { user, params }) => {
    const a = own(user, params.id);
    db.prepare('UPDATE rag_apps SET token_hash=NULL, token_last4=NULL, published=0, updated_at=? WHERE id=?').run(now(), a.id);
    send(res, 200, { ok: true });
  });

  // ---------- evaluation ----------
  const evalKey = (user) => {
    try { return keyFor(user, { agent: true }).key; }
    catch { throw new HttpError(402, 'Quality checks make many model calls, so they run on your own OpenRouter key. Add it in Settings.', { code: 'needs_key' }); }
  };
  const docsOf = (appId) => db.prepare('SELECT id, name, sha256, created_at FROM rag_docs WHERE app_id=?').all(appId);
  const fpOf = (app) => fingerprint(cfgOf(app), docsOf(app.id));
  const parseRun = (r) => ({ ...r, config: undefined, summary: r.summary ? JSON.parse(r.summary) : null });
  const loadResults = (runId) => db.prepare('SELECT * FROM rag_run_results WHERE run_id=?').all(runId).map((r) => ({
    ...r, sources: JSON.parse(r.sources), flags: JSON.parse(r.flags), judge: r.judge ? JSON.parse(r.judge) : null, checks: JSON.parse(r.checks),
    refused: !!r.refused, passed: !!r.passed, cited: JSON.parse(r.cited || '[]') }));
  const testsOf = (appId, approvedOnly = true) => db.prepare(`SELECT * FROM rag_tests WHERE app_id=? ${approvedOnly ? 'AND approved=1' : ''} ORDER BY created_at, id`).all(appId);

  /** Can this assistant be published? Only if the newest run for the exact current settings and documents passed. */
  function gateNow(app) {
    const fp = fpOf(app);
    const runs = db.prepare(`SELECT * FROM rag_runs WHERE app_id=? AND status='done' ORDER BY created_at DESC LIMIT 20`).all(app.id);
    const same = runs.find((r) => r.fingerprint === fp);
    if (same) { const sm = JSON.parse(same.summary); return { ok: sm.gate.ok, reason: sm.gate.reason, run_id: same.id, health: sm.health, stale: false }; }
    return { ok: false, stale: runs.length > 0, reason: runs.length ? 'Your settings or documents changed since the last quality check. Run it again before publishing.' : 'Run a quality check before publishing, so you know the assistant answers well.' };
  }

  const activeRuns = new Set();
  db.prepare(`UPDATE rag_runs SET status='failed', error='Interrupted by a server restart' WHERE status='running'`).run();

  async function executeRun(runId, app, apiKey, judgeModel) {
    const run = db.prepare('SELECT * FROM rag_runs WHERE id=?').get(runId);
    const cfg = { ...cfgOf(app), model: run.model };
    const chunks = chunksOf(app.id);
    const cases = [...testsOf(app.id).map((t) => ({ id: t.id, kind: t.kind, question: t.question, expected_answer: t.expected_answer })),
      ...RED_TEAM.map((q) => ({ id: null, kind: 'redteam', question: q, expected_answer: '' }))];
    db.prepare('UPDATE rag_runs SET total=? WHERE id=?').run(cases.length, runId);
    const ins = db.prepare(`INSERT INTO rag_run_results (id, run_id, test_id, kind, question, expected_answer, answer, sources, flags, refused, latency_ms, coverage, hit, rr, judge, checks, passed, error, cited)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let next = 0;
    const worker = async () => {
      while (next < cases.length) {
        const c = cases[next++];
        let row;
        try {
          const result = await answerFor({ ...app, config: JSON.stringify(cfg) }, chunks, c.question, run.model, apiKey);
          if (result.flags.includes('model_error')) row = { error: result.error || 'The model did not answer', result };
          else {
            let judge = null;
            if (c.kind === 'answerable' && result.refused) judge = { groundedness: 4, correctness: 0, completeness: 0, unsupported_claims: [], reason: 'The assistant said it did not know, but the documents have the answer.', synthetic: true };
            else if (c.kind === 'answerable') {
              for (let i = 0; i < 2 && !judge; i++) {
                try { judge = parseJudge(await llm({ apiKey, model: judgeModel, messages: judgeMessages({ question: c.question, expected: c.expected_answer, sources: result.sources, answer: result.answer }), maxTokens: 1500 })); } catch { /* try once more */ }
              }
            }
            const ev = evaluateCase({ test: c, result, judge, config: cfg });
            row = { result, judge, ev };
          }
        } catch (e) { row = { error: e.message || 'failed' }; }
        const r = row.result;
        ins.run(uid(), runId, c.id, c.kind, c.question, c.expected_answer, r?.answer || '', JSON.stringify((r?.sources || []).map((s) => ({ doc_name: s.doc_name, heading: s.heading, text: String(s.text).slice(0, 700), score: s.score, coverage: s.coverage, sim: s.sim }))),
          JSON.stringify(r?.flags || []), r?.refused ? 1 : 0, r?.latency_ms ?? null, r?.coverage ?? null, row.ev?.hit ?? null, row.ev?.rr ?? null,
          row.judge ? JSON.stringify(row.judge) : null, JSON.stringify(row.ev?.checks || {}), row.ev?.passed ? 1 : 0, row.error || null, JSON.stringify(r?.cited || []));
        db.prepare('UPDATE rag_runs SET done=done+1 WHERE id=?').run(runId);
      }
    };
    try {
      await Promise.all([worker(), worker(), worker()]);
      const summary = summarize(loadResults(runId), { config: cfg });
      db.prepare(`UPDATE rag_runs SET status='done', summary=?, finished_at=? WHERE id=?`).run(JSON.stringify(summary), now(), runId);
    } catch (e) {
      db.prepare(`UPDATE rag_runs SET status='failed', error=?, finished_at=? WHERE id=?`).run(String(e.message).slice(0, 300), now(), runId);
    } finally { activeRuns.delete(app.id); }
  }

  route('GET', '/api/rag/apps/:id/tests', async (req, res, { user, params }) => { own(user, params.id); send(res, 200, testsOf(params.id, false)); });

  route('POST', '/api/rag/apps/:id/tests', async (req, res, { user, params }) => {
    own(user, params.id);
    const { question, expected_answer = '', kind = 'answerable' } = await readJson(req);
    const q = String(question || '').trim();
    if (q.length < 5) throw new HttpError(400, 'Write the question a customer would ask.');
    if (!['answerable', 'unanswerable'].includes(kind)) throw new HttpError(400, 'Kind must be answerable or unanswerable.');
    if (kind === 'answerable' && !String(expected_answer).trim()) throw new HttpError(400, 'Write the correct answer, so answers can be checked against it.');
    if (db.prepare('SELECT COUNT(*) n FROM rag_tests WHERE app_id=?').get(params.id).n >= 100) throw new HttpError(400, 'At most 100 test questions.');
    const id = uid();
    db.prepare('INSERT INTO rag_tests (id, app_id, question, expected_answer, kind, origin, approved, created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, params.id, q.slice(0, 300), String(expected_answer).trim().slice(0, 600), kind, 'manual', now());
    send(res, 201, db.prepare('SELECT * FROM rag_tests WHERE id=?').get(id));
  });

  const ownTest = (user, id) => {
    const t = db.prepare('SELECT t.* FROM rag_tests t JOIN rag_apps a ON a.id=t.app_id WHERE t.id=? AND a.user_id=?').get(id, user.id);
    if (!t) throw new HttpError(404, 'Test question not found');
    return t;
  };
  route('PATCH', '/api/rag/tests/:id', async (req, res, { user, params }) => {
    const t = ownTest(user, params.id);
    const b = await readJson(req);
    const kind = ['answerable', 'unanswerable'].includes(b.kind) ? b.kind : t.kind;
    db.prepare('UPDATE rag_tests SET question=?, expected_answer=?, kind=?, approved=? WHERE id=?')
      .run(String(b.question ?? t.question).trim().slice(0, 300), String(b.expected_answer ?? t.expected_answer).trim().slice(0, 600), kind, b.approved == null ? t.approved : (b.approved ? 1 : 0), t.id);
    send(res, 200, db.prepare('SELECT * FROM rag_tests WHERE id=?').get(t.id));
  });
  route('DELETE', '/api/rag/tests/:id', async (req, res, { user, params }) => { ownTest(user, params.id); db.prepare('DELETE FROM rag_tests WHERE id=?').run(params.id); send(res, 200, { ok: true }); });
  route('POST', '/api/rag/apps/:id/tests/approve-all', async (req, res, { user, params }) => {
    own(user, params.id); send(res, 200, { approved: db.prepare('UPDATE rag_tests SET approved=1 WHERE app_id=? AND approved=0').run(params.id).changes });
  });

  /** Turn a real customer question or an outlier from a run into a permanent test. */
  route('POST', '/api/rag/apps/:id/tests/from', async (req, res, { user, params }) => {
    own(user, params.id);
    const { query_id, result_id, kind = 'answerable', expected_answer = '' } = await readJson(req);
    let question = '';
    if (query_id) question = db.prepare('SELECT question FROM rag_queries WHERE id=? AND app_id=?').get(String(query_id), params.id)?.question;
    else if (result_id) question = db.prepare('SELECT r.question FROM rag_run_results r JOIN rag_runs u ON u.id=r.run_id WHERE r.id=? AND u.app_id=?').get(String(result_id), params.id)?.question;
    if (!question) throw new HttpError(404, 'Question not found');
    if (kind === 'answerable' && !String(expected_answer).trim()) throw new HttpError(400, 'Write the correct answer for this question.');
    if (db.prepare('SELECT 1 FROM rag_tests WHERE app_id=? AND lower(question)=lower(?)').get(params.id, question)) throw new HttpError(409, 'That question is already in your test set.');
    const id = uid();
    db.prepare('INSERT INTO rag_tests (id, app_id, question, expected_answer, kind, origin, approved, created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, params.id, question, String(expected_answer).trim().slice(0, 600), kind, 'real', now());
    send(res, 201, db.prepare('SELECT * FROM rag_tests WHERE id=?').get(id));
  });

  route('POST', '/api/rag/apps/:id/tests/generate', async (req, res, { user, params }) => {
    const a = own(user, params.id);
    const body = await readJson(req);
    const model = String(body.model || cfgOf(a).model || '').trim();
    if (!model) throw new HttpError(400, 'Choose a model first. It writes the questions.');
    const chunks = chunksOf(a.id);
    if (!chunks.length) throw new HttpError(400, 'Add at least one document first.');
    const apiKey = evalKey(user);
    const sample = sampleChunks(chunks, 12);
    const batches = []; for (let i = 0; i < sample.length; i += 3) batches.push(sample.slice(i, i + 3));
    const calls = batches.map((b) => () => llm({ apiKey, model, messages: generationMessages(b, 3), maxTokens: 3500 }).then((t) => parseGenerated(t, b)).catch(() => []));
    const docs = docsOf(a.id);
    calls.push(() => llm({ apiKey, model, messages: unanswerableMessages(docs.map((d) => d.name), [...new Set(chunks.map((c) => c.heading).filter(Boolean))], 4), maxTokens: 1500 }).then(parseUnanswerable).catch(() => []));
    const made = (await Promise.all(calls.map((f) => f()))).flat();
    if (!made.length) throw new HttpError(502, 'The model did not return usable questions. Try a different model.');
    const have = new Set(db.prepare('SELECT lower(question) q FROM rag_tests WHERE app_id=?').all(a.id).map((r) => r.q));
    const room = 100 - have.size;
    const ins = db.prepare('INSERT INTO rag_tests (id, app_id, question, expected_answer, kind, origin, source_doc, approved, created_at) VALUES (?,?,?,?,?,?,?,0,?)');
    let added = 0;
    for (const t of made) {
      if (added >= room || have.has(t.question.toLowerCase())) continue;
      have.add(t.question.toLowerCase()); ins.run(uid(), a.id, t.question, t.expected_answer, t.kind, 'generated', t.source_doc, now()); added++;
    }
    send(res, 201, { added, answerable: made.filter((t) => t.kind === 'answerable').length });
  });

  route('POST', '/api/rag/apps/:id/eval/run', async (req, res, { user, params }) => {
    const a = own(user, params.id);
    const body = await readJson(req);
    if (activeRuns.has(a.id)) throw new HttpError(409, 'A quality check is already running.');
    const cfg = cfgOf(a);
    const model = String(body.model || cfg.model || '').trim();
    if (!model) throw new HttpError(400, 'Choose a model in Settings first.');
    const judgeModel = String(body.judge_model || model).trim();
    const tests = testsOf(a.id);
    if (tests.filter((t) => t.kind === 'answerable').length < 1) throw new HttpError(400, 'Add some test questions first (the Test set tab can draft them for you).');
    if (!chunksOf(a.id).length) throw new HttpError(400, 'Add at least one document first.');
    const apiKey = evalKey(user);
    const id = uid();
    // The run tests the settings as they will be published, with the chosen model.
    const tested = { ...a, config: JSON.stringify({ ...cfg, model }) };
    db.prepare(`INSERT INTO rag_runs (id, app_id, status, model, judge_model, fingerprint, config, total, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, a.id, 'running', model, judgeModel, fingerprint({ ...cfg, model }, docsOf(a.id)), JSON.stringify({ ...cfg, model }), tests.length + RED_TEAM.length, now());
    activeRuns.add(a.id);
    executeRun(id, tested, apiKey, judgeModel).catch((e) => { log?.(e); activeRuns.delete(a.id); });
    send(res, 202, { run_id: id });
  });

  route('GET', '/api/rag/eval/runs/:id', async (req, res, { user, params }) => {
    const r = db.prepare('SELECT u.* FROM rag_runs u JOIN rag_apps a ON a.id=u.app_id WHERE u.id=? AND a.user_id=?').get(params.id, user.id);
    if (!r) throw new HttpError(404, 'Run not found');
    const results = loadResults(r.id);
    send(res, 200, { ...parseRun(r), results, outliers: r.status === 'done' ? findOutliers(results, { summary: JSON.parse(r.summary) }) : [] });
  });

  route('GET', '/api/rag/apps/:id/quality', async (req, res, { user, params }) => {
    const a = own(user, params.id);
    const cfg = cfgOf(a);
    const tests = testsOf(a.id, false);
    const runs = db.prepare('SELECT * FROM rag_runs WHERE app_id=? ORDER BY created_at DESC LIMIT 30').all(a.id).map(parseRun);
    const done = runs.filter((r) => r.status === 'done');
    const latest = done[0] || null;
    const fp = fpOf(a);
    const queries = db.prepare('SELECT * FROM rag_queries WHERE app_id=? ORDER BY created_at DESC LIMIT 300').all(a.id).map((q) => ({ ...q, flags: JSON.parse(q.flags) }));
    const live = queries.length ? liveInsights(queries) : null;
    const results = latest ? loadResults(latest.id) : [];
    const chunks = chunksOf(a.id);
    const running = runs.find((r) => r.status === 'running');
    send(res, 200, {
      fingerprint: fp, current: !!latest && latest.fingerprint === fp, gate: gateNow(a),
      tests: { approved: tests.filter((t) => t.approved).length, answerable: tests.filter((t) => t.approved && t.kind === 'answerable').length, unanswerable: tests.filter((t) => t.approved && t.kind === 'unanswerable').length, pending: tests.filter((t) => !t.approved).length },
      latest: latest ? { id: latest.id, created_at: latest.created_at, model: latest.model, judge_model: latest.judge_model, summary: latest.summary, current: latest.fingerprint === fp } : null,
      running: running ? { id: running.id, done: running.done, total: running.total } : null,
      runs: runs.map((r) => ({ id: r.id, created_at: r.created_at, status: r.status, model: r.model, judge_model: r.judge_model, health: r.summary?.health ?? null, gate_ok: r.summary?.gate?.ok ?? null, current: r.fingerprint === fp, done: r.done, total: r.total, error: r.error })),
      rules: latest ? latest.summary.rules : RULES.map((r) => ({ ...r, value: null, status: 'na' })),
      outliers: latest ? findOutliers(results, { summary: latest.summary }) : [],
      live, overlaps: overlappingTopics(chunks),
      suggestions: suggest({ summary: latest?.summary || null, config: cfg, docs: docsOf(a.id), live, runs: done, haveTests: tests.some((t) => t.approved), search: searchStatus(a) }),
      search: searchStatus(a),
    });
  });

  // ---------- public endpoint (widget and hosted API) ----------
  const hits = new Map(); // `${app}:${ip}` -> timestamps
  const limited = (key, max = 12, windowMs = 60_000) => {
    const t = now(); const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return true; }
    arr.push(t); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    return false;
  };

  /** Handles /pub/rag/:id/(query|feedback). Returns false when the path is not ours. */
  async function handlePublic(req, res, pathname) {
    const m = pathname.match(/^\/pub\/rag\/([\w-]+)\/(query|feedback)$/);
    if (!m) return false;
    const [, appId, action] = m;
    const origin = req.headers.origin || '';
    const app = db.prepare('SELECT * FROM rag_apps WHERE id=?').get(appId);
    const allowed = app ? JSON.parse(app.allowed_origins || '[]') : [];
    const cors = origin && allowed.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, X-RAG-Key', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '600' } : { 'Vary': 'Origin' };
    const fail = (status, msg) => send(res, status, { error: msg }, cors);
    // Test switch: behave like Catalyst's gateway, which answers preflights itself with an empty 200 and no CORS headers.
    if (req.method === 'OPTIONS' && process.env.RAG_SIMULATE_GATEWAY_PREFLIGHT) { res.writeHead(200, { 'Content-Length': 0 }); res.end(); return true; }
    if (req.method === 'OPTIONS') { res.writeHead(origin && cors['Access-Control-Allow-Origin'] ? 204 : 403, cors); res.end(); return true; }
    if (req.method !== 'POST') { fail(405, 'Use POST'); return true; }
    try {
      if (!app || !app.published || !app.token_hash) return fail(404, 'This assistant is not available.'), true;
      // The key is accepted in a header (servers) or in the body (the chat box). The chat box sends text/plain with the key in the
      // body because that is a "simple" cross-origin request: browsers send it without a preflight, and Catalyst's gateway answers
      // preflights itself, without CORS headers, which would block every embedded chat box.
      const body = await readJson(req);
      const given = String(req.headers['x-rag-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || body.key || '');
      const a = Buffer.from(hashToken(given)), b = Buffer.from(app.token_hash);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(401, 'Invalid key.'), true;
      if (origin && !cors['Access-Control-Allow-Origin']) return fail(403, 'This website is not allowed to use this assistant.'), true;
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (limited(`${appId}:${ip}`)) return fail(429, 'Too many questions. Please wait a minute.'), true;
      if (action === 'feedback') {
        const r = db.prepare('UPDATE rag_queries SET rating=? WHERE id=? AND app_id=?').run(body.rating === 1 ? 1 : body.rating === -1 ? -1 : null, String(body.query_id || ''), appId);
        send(res, 200, { ok: r.changes > 0 }, cors); return true;
      }
      const question = String(body.question || '').trim();
      if (!question) return fail(400, 'Type a question.'), true;
      const cfg = cfgOf(app);
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const today = db.prepare(`SELECT COUNT(*) n FROM rag_queries WHERE app_id=? AND source<>'playground' AND created_at>=?`).get(appId, startOfDay.getTime()).n;
      if (today >= cfg.daily_cap) return fail(429, 'This assistant has reached its daily limit. Please contact the business directly.'), true;
      const owner = userById(app.user_id);
      let key;
      try { key = keyFor(owner, { agent: true }).key; } catch { return fail(503, 'This assistant is not available right now.'), true; }
      const r = await ask({ app, owner, question, source: origin ? 'widget' : 'api', apiKey: key });
      send(res, 200, { answer: r.answer, refused: r.refused, query_id: r.query_id,
        sources: r.sources.filter((s) => r.cited.includes(r.sources.indexOf(s) + 1)).map((s) => ({ doc: s.doc_name, heading: s.heading })) }, cors);
    } catch (e) {
      if (!(e instanceof HttpError)) log?.(e);
      fail(e.status || 500, e.status ? e.message : 'Something went wrong.');
    }
    return true;
  }

  return { handlePublic, TEMPLATES, DEFAULT_CONFIG };
}
