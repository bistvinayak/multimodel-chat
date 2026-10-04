import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './lib/db.js';
import { hashPassword, verifyPassword, createSession, destroySession, userFromRequest, parseCookies, sessionCookie } from './lib/auth.js';
import { getCatalog, getModel, qualityScore, NOT_CHAT } from './lib/models.js';
import { healthOf, recordOk, recordLimited, recordBlocked } from './lib/health.js';
import { buildContext } from './lib/context.js';
import { streamCompletion, ModelError, probeModel } from './lib/openrouter.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_MODELS = Number(process.env.MAX_MODELS || 3);
const RATE_LIMIT_RETRIES = Number(process.env.RATE_LIMIT_RETRIES ?? 4);
// With auto-switch on, retry briefly, then hand the lane to a model that is answering.
const AUTO_SWITCH_RETRIES = Number(process.env.AUTO_SWITCH_RETRIES ?? 1);
const MAX_AUTO_SWITCHES = 2; // per lane per turn
// Exponential backoff with jitter: about 3s, 6s, 11s, 18s (~40s total) before giving up.
const backoffMs = (attempt) => Math.round([3000, 6000, 11000, 18000][Math.min(attempt, 3)] * (0.85 + Math.random() * 0.3));
const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) console.warn('WARNING: OPENROUTER_API_KEY is not set. Model calls will fail.');

const db = openDb(process.env.DB_PATH || path.join(ROOT, 'data', 'app.db'));
const running = new Map(); // response_id -> AbortController
const uid = () => crypto.randomUUID();
const now = () => Date.now();
const DEFAULT_PREFS = { max_output_tokens: 8192, free_only: true, auto_switch: true };

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(data === undefined ? '' : JSON.stringify(data));
}

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1_000_000) throw new HttpError(413, 'Body too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const prefsOf = (user) => ({ ...DEFAULT_PREFS, ...JSON.parse(user.preferences || '{}') });
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, created_at: u.created_at, preferences: prefsOf(u) });

// Every lookup is scoped by the authenticated user_id (PRD section 25).
function ownConversation(user, id) {
  const c = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, user.id);
  if (!c) throw new HttpError(404, 'Conversation not found');
  return c;
}
function ownResponse(user, id) {
  const r = db.prepare(`SELECT r.* FROM responses r JOIN conversations c ON c.id=r.conversation_id
                        WHERE r.id=? AND c.user_id=?`).get(id, user.id);
  if (!r) throw new HttpError(404, 'Response not found');
  return r;
}
const touch = (convId) => db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(), convId);

const RESPONSE_COLS = `id, turn_id, conversation_id, model_id, served_model, provider, display_position, content, reasoning,
  status, error_kind, error, finish_reason, latency_ms, first_token_ms, prompt_tokens, completion_tokens, cost,
  saved, final, attempts, replaced_by, stands_in_for, auto_switched, created_at, finished_at`;
const getResponseRow = (id) => db.prepare(`SELECT ${RESPONSE_COLS} FROM responses WHERE id=?`).get(id);

function conversationPayload(conv) {
  const models = db.prepare('SELECT * FROM conversation_models WHERE conversation_id=? ORDER BY position').all(conv.id);
  const turns = db.prepare('SELECT * FROM turns WHERE conversation_id=? ORDER BY created_at').all(conv.id);
  const responses = db.prepare(`SELECT ${RESPONSE_COLS} FROM responses WHERE conversation_id=? ORDER BY display_position`).all(conv.id);
  const byTurn = new Map(turns.map((t) => [t.id, []]));
  for (const r of responses) byTurn.get(r.turn_id)?.push(r);
  const selections = db.prepare(
    `SELECT s.*, r.model_id FROM context_selections s JOIN responses r ON r.id=s.response_id
     WHERE s.conversation_id=? AND s.active=1 AND (s.selection_type='canonical' OR s.consumed_turn_id IS NULL)
     ORDER BY s.created_at`).all(conv.id);
  const stats = responses.reduce((s, r) => {
    if (r.status !== 'pending') s.calls += r.attempts;
    s.cost += r.cost || 0;
    s.tokens += (r.prompt_tokens || 0) + (r.completion_tokens || 0);
    return s;
  }, { cost: 0, calls: 0, tokens: 0, messages: turns.length });
  return {
    conversation: conv,
    models,
    turns: turns.map((t) => ({ ...t, target_models: JSON.parse(t.target_models), responses: byTurn.get(t.id) })),
    selections,
    stats,
    skill_ids: db.prepare('SELECT skill_id FROM conversation_skills WHERE conversation_id=?').all(conv.id).map((x) => x.skill_id),
    max_models: MAX_MODELS,
  };
}

function skillsFor(convId) {
  return db.prepare(`SELECT k.name, k.instructions FROM conversation_skills cs JOIN skills k ON k.id=cs.skill_id
    WHERE cs.conversation_id=? ORDER BY cs.added_at`).all(convId);
}
const SKILL_COLS = 'id, name, description, instructions, auto, created_at, updated_at';
function ownSkill(user, id) {
  const k = db.prepare(`SELECT ${SKILL_COLS} FROM skills WHERE id=? AND user_id=?`).get(id, user.id);
  if (!k) throw new HttpError(404, 'Skill not found');
  return k;
}
function cleanSkill(body, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) { out.name = String(body.name || '').trim().slice(0, 60); if (!out.name) throw new HttpError(400, 'Skill name is required'); }
  if (!partial || body.instructions !== undefined) {
    out.instructions = String(body.instructions || '').trim();
    if (!out.instructions) throw new HttpError(400, 'Instructions are required');
    if (out.instructions.length > 8000) throw new HttpError(400, 'Instructions are limited to 8,000 characters');
  }
  if (body.description !== undefined) out.description = String(body.description).trim().slice(0, 200);
  if (body.auto !== undefined) out.auto = body.auto ? 1 : 0;
  return out;
}

function pinsFor(convId, turnId) {
  return db.prepare(
    `SELECT s.selected_text, r.model_id FROM context_selections s JOIN responses r ON r.id=s.response_id
     WHERE s.conversation_id=? AND s.selection_type='continue' AND s.active=1 AND ${turnId ? 's.consumed_turn_id=?' : 's.consumed_turn_id IS NULL'}`
  ).all(...(turnId ? [convId, turnId] : [convId]));
}

function maxOutFor(user, model) {
  const want = Number(prefsOf(user).max_output_tokens) || 8192;
  return model?.max_output ? Math.min(want, model.max_output) : want;
}

// target: 'all' | model_id | [model_id, ...]  (any subset of the conversation's models)
function resolveTargets(convId, target) {
  const models = db.prepare('SELECT * FROM conversation_models WHERE conversation_id=? ORDER BY position').all(convId);
  const active = models.filter((m) => m.status === 'active');
  if (!target || target === 'all') {
    if (!active.length) throw new HttpError(400, 'No active models. Add or resume a model first.');
    return { mode: 'all', targets: active };
  }
  const ids = [...new Set(Array.isArray(target) ? target.map(String) : [String(target)])];
  if (!ids.length) throw new HttpError(400, 'Pick at least one model to send to');
  const targets = models.filter((m) => ids.includes(m.model_id) && m.status !== 'removed');
  if (targets.length !== ids.length) throw new HttpError(400, 'One of those models is not part of this conversation');
  if (targets.length > MAX_MODELS) throw new HttpError(400, `At most ${MAX_MODELS} models per message`);
  const isAll = active.length && targets.length === active.length && active.every((a) => ids.includes(a.model_id));
  return { mode: isAll ? 'all' : targets.length === 1 ? 'single' : 'subset', targets };
}

function replyRef(convId, reply_to) {
  if (!reply_to?.response_id) return { id: null, quote: null };
  const r = db.prepare('SELECT id FROM responses WHERE id=? AND conversation_id=?').get(String(reply_to.response_id), convId);
  if (!r) throw new HttpError(400, 'The answer you are replying to is not in this conversation');
  return { id: r.id, quote: reply_to.quote ? String(reply_to.quote).slice(0, 8000) : null };
}

function logPreference(user, resp, eventType) {
  const others = db.prepare('SELECT id, model_id FROM responses WHERE turn_id=? AND id<>?').all(resp.turn_id, resp.id);
  db.prepare(`INSERT INTO preference_events (id, user_id, conversation_id, turn_id, event_type, winning_response, winning_model,
              compared_responses, compared_models, display_position, task_type, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid(), user.id, resp.conversation_id, resp.turn_id, eventType, resp.id, resp.model_id,
      JSON.stringify(others.map((o) => o.id)), JSON.stringify(others.map((o) => o.model_id)), resp.display_position, null, now());
}

// ---------- lane swaps (manual and automatic) ----------
// Healthy models that could stand in for a busy/failed lane, best first.
async function rankAlternatives(r) {
  const inConv = new Set(db.prepare(`SELECT model_id FROM conversation_models WHERE conversation_id=? AND status<>'removed'`)
    .all(r.conversation_id).map((x) => x.model_id));
  const cur = await getModel(r.model_id);
  const wantTags = new Set((cur?.tags || []).filter((t) => t !== 'free'));
  const vendor = (id) => id.split('/')[0];
  const limited = r.error_kind === 'rate_limit' || r.status === 'rate_limited';
  const score = (m) => ({ ok: 4, unknown: 1 }[healthOf(m.id)] || 0)
    + qualityScore(m, { health: healthOf(m.id) }) / 4                       // prefer stronger models
    + m.tags.filter((t) => wantTags.has(t)).length
    + (m.context_length >= (cur?.context_length || 0) ? 1 : 0)
    + (m.id.endsWith(':free') ? 1 : 0)                                    // zero-priced non-:free endpoints can still demand credits
    - (limited && vendor(m.id) === vendor(r.model_id) ? 3 : 0);           // same vendor likely shares the exhausted pool
  return (await getCatalog())
    .filter((m) => !inConv.has(m.id) && !NOT_CHAT.test(m.id))
    .filter((m) => (cur && !cur.free) || m.free)                          // a free lane only gets free stand-ins
    .filter((m) => !['busy', 'blocked'].includes(healthOf(m.id)))
    .sort((a, b) => score(b) - score(a) || b.created - a.created);
}

// Pauses r's model (never removes it), activates model_id, and gives it a pending response in the same turn.
function swapLane(r, model_id, auto) {
  let newId;
  tx(db, () => {
    const rows = db.prepare('SELECT * FROM conversation_models WHERE conversation_id=?').all(r.conversation_id);
    db.prepare(`UPDATE conversation_models SET status='paused' WHERE conversation_id=? AND model_id=? AND status='active'`).run(r.conversation_id, r.model_id);
    const existing = rows.find((x) => x.model_id === model_id);
    const activeAfter = rows.filter((x) => x.status === 'active' && x.model_id !== r.model_id && x.model_id !== model_id).length + 1;
    if (activeAfter > MAX_MODELS) throw new HttpError(400, `At most ${MAX_MODELS} active models`);
    if (existing) db.prepare(`UPDATE conversation_models SET status='active', removed_at=NULL WHERE conversation_id=? AND model_id=?`).run(r.conversation_id, model_id);
    else db.prepare('INSERT INTO conversation_models (conversation_id, model_id, status, position, added_at) VALUES (?,?,?,?,?)')
      .run(r.conversation_id, model_id, 'active', rows.length, now());
    const pos = db.prepare('SELECT position FROM conversation_models WHERE conversation_id=? AND model_id=?').get(r.conversation_id, model_id).position;
    const already = db.prepare('SELECT id, status FROM responses WHERE turn_id=? AND model_id=?').get(r.turn_id, model_id);
    if (already) {
      newId = already.id;
      if (already.status !== 'completed') db.prepare(`UPDATE responses SET status='pending' WHERE id=?`).run(newId);
    } else {
      newId = uid();
      db.prepare(`INSERT INTO responses (id, turn_id, conversation_id, model_id, display_position, status, created_at) VALUES (?,?,?,?,?,'pending',?)`)
        .run(newId, r.turn_id, r.conversation_id, model_id, pos, now());
    }
    db.prepare('UPDATE responses SET stands_in_for=?, auto_switched=? WHERE id=?').run(r.id, auto ? 1 : 0, newId);
    db.prepare('UPDATE responses SET replaced_by=? WHERE id=?').run(newId, r.id);
  });
  touch(r.conversation_id);
  return newId;
}

// How many automatic stand-ins already happened in this chain (stops endless hopping).
function standInDepth(id) {
  let depth = 0, cur = db.prepare('SELECT stands_in_for, auto_switched FROM responses WHERE id=?').get(id);
  while (cur?.stands_in_for && depth < 10) { if (cur.auto_switched) depth++; cur = db.prepare('SELECT stands_in_for, auto_switched FROM responses WHERE id=?').get(cur.stands_in_for); }
  return depth;
}

// Pick the best alternative that is actually answering right now (checked with a tiny request).
async function pickStandIn(r) {
  const candidates = (await rankAlternatives({ ...r, status: 'rate_limited', error_kind: 'rate_limit' })).slice(0, 4);
  if (!candidates.length) return null;
  const results = await Promise.all(candidates.map((m) => probeModel(API_KEY, m.id)));
  results.forEach((x) => (x.health === 'ok' ? recordOk(x.model) : x.health === 'busy' ? recordLimited(x.model) : x.health === 'blocked' ? recordBlocked(x.model) : null));
  return candidates.find((m, i) => results[i].health === 'ok') || null;
}

// ---------- model run (streams NDJSON to the client) ----------
async function runResponse(user, resp, req, res) {
  if (running.has(resp.id)) throw new HttpError(409, 'This response is already generating');
  const turn = db.prepare('SELECT * FROM turns WHERE id=?').get(resp.turn_id);
  const model = await getModel(resp.model_id);
  const maxOut = maxOutFor(user, model);
  const { messages } = buildContext(db, turn, resp.model_id, model, maxOut, pinsFor(turn.conversation_id, turn.id), skillsFor(turn.conversation_id));

  const ctl = new AbortController();
  running.set(resp.id, ctl);
  db.prepare(`UPDATE responses SET status='generating', content='', reasoning='', error=NULL, error_kind=NULL, finish_reason=NULL,
              latency_ms=NULL, first_token_ms=NULL, prompt_tokens=NULL, completion_tokens=NULL, cost=NULL,
              attempts=attempts+1, context_snapshot=?, finished_at=NULL WHERE id=?`).run(JSON.stringify(messages), resp.id);

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const emit = (obj) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(obj) + '\n'); };
  // If the browser tab goes away, stop paying for tokens nobody will see.
  res.on('close', () => { if (!res.writableEnded) ctl.abort('user'); });
  emit({ type: 'start', response: getResponseRow(resp.id) });

  let content = '', reasoning = '', lastFlush = now();
  const started = now();
  const flush = (force) => {
    if (force || now() - lastFlush > 1500) {
      db.prepare('UPDATE responses SET content=?, reasoning=? WHERE id=?').run(content, reasoning, resp.id);
      lastFlush = now();
    }
  };

  try {
    let stats;
    // Free models are often rate-limited upstream for a few seconds. Retry the SAME model
    // with backoff (never a different one: that would invalidate the comparison).
    for (let attempt = 0; ; attempt++) {
      try {
        stats = await streamCompletion({
          apiKey: API_KEY, model: resp.model_id, messages, maxTokens: maxOut, signal: ctl.signal,
          onDelta: (t) => { content += t; emit({ type: 'delta', content: t }); flush(); },
          onReasoning: (t) => { reasoning += t; emit({ type: 'reasoning', content: t }); flush(); },
        });
        break;
      } catch (e) {
        if (e instanceof ModelError && e.kind === 'rate_limit') recordLimited(resp.model_id);
        const maxRetries = prefsOf(user).auto_switch ? AUTO_SWITCH_RETRIES : RATE_LIMIT_RETRIES;
        const retryable = e instanceof ModelError && e.kind === 'rate_limit' && !content && !reasoning && attempt < maxRetries
          && !(e.retryAfterMs > 60_000);
        if (!retryable) { e.attempts = attempt + 1; throw e; }
        const wait = e.retryAfterMs ?? backoffMs(attempt);
        emit({ type: 'retrying', attempt: attempt + 1, of: maxRetries, wait_ms: wait });
        await new Promise((ok) => {
          const t = setTimeout(ok, wait);
          ctl.signal.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true });
        });
        if (ctl.signal.aborted) throw new ModelError('stopped', 'Stopped by user');
      }
    }
    const u = stats.usage || {};
    if (content.trim()) recordOk(resp.model_id);
    let status = 'completed', error = null, kind = null;
    if (!content.trim()) {
      status = 'failed'; kind = 'empty';
      error = stats.finish_reason === 'length'
        ? 'The model used its whole output budget on reasoning. Raise "max output tokens" in settings and retry.'
        : 'The model returned an empty response.';
    } else if (stats.finish_reason === 'content_filter') {
      kind = 'safety'; error = 'The provider filtered part of this response.';
    } else if (stats.finish_reason === 'length') {
      kind = 'truncated'; error = 'Hit the max output length. The answer may be cut off.';
    }
    db.prepare(`UPDATE responses SET content=?, reasoning=?, status=?, error=?, error_kind=?, finish_reason=?, latency_ms=?, first_token_ms=?,
                prompt_tokens=?, completion_tokens=?, cost=?, served_model=?, provider=?, finished_at=? WHERE id=?`)
      .run(content, reasoning, status, error, kind, stats.finish_reason, stats.latency_ms, stats.first_token_ms,
        u.prompt_tokens ?? null, u.completion_tokens ?? null, u.cost ?? null, stats.served_model, stats.provider, now(), resp.id);
  } catch (e) {
    const me = e instanceof ModelError ? e : new ModelError('unknown', e.message);
    const status = me.kind === 'stopped' ? 'stopped' : me.status;
    if (['forbidden', 'invalid_model', 'insufficient_credits'].includes(me.kind)) recordBlocked(resp.model_id);
    if (me.kind === 'rate_limit') {
      me.message = me.retryAfterMs > 60_000
        ? `Rate limited upstream. The provider says capacity returns in about ${Math.ceil(me.retryAfterMs / 60_000)} min. Raw: ${me.message}`
        : `Still rate limited after ${me.attempts || 1} attempts over about ${Math.round((Date.now() - started) / 1000)}s. Raw: ${me.message}`;
    }
    db.prepare(`UPDATE responses SET content=?, reasoning=?, status=?, error=?, error_kind=?, finished_at=? WHERE id=?`)
      .run(content, reasoning, status, me.kind === 'stopped' ? null : me.message, me.kind, now(), resp.id);
    if (me.kind === 'rate_limit' && prefsOf(user).auto_switch && !ctl.signal.aborted && standInDepth(resp.id) < MAX_AUTO_SWITCHES) {
      emit({ type: 'switching' });
      try {
        const alt = await pickStandIn(getResponseRow(resp.id));
        if (alt) {
          const newId = swapLane(getResponseRow(resp.id), alt.id, true);
          emit({ type: 'switched', from: resp.model_id, to: alt.id, new_response_id: newId });
        } else emit({ type: 'switch_failed', message: 'No other free model is answering right now.' });
      } catch (err) { emit({ type: 'switch_failed', message: err.message }); }
    }
  } finally {
    running.delete(resp.id);
    touch(resp.conversation_id);
  }
  emit({ type: 'final', response: getResponseRow(resp.id) });
  res.end();
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, { auth = true } = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth });
};

route('POST', '/api/signup', async (req, res) => {
  const { name, email, password } = await readJson(req);
  const em = String(email || '').trim().toLowerCase();
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(em)) throw new HttpError(400, 'Name and a valid email are required');
  if (String(password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(em)) throw new HttpError(409, 'An account with that email already exists');
  const id = uid();
  db.prepare('INSERT INTO users (id, name, email, password_hash, preferences, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, name.trim(), em, hashPassword(password), JSON.stringify(DEFAULT_PREFS), now());
  const token = createSession(db, id);
  send(res, 201, publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)), { 'Set-Cookie': sessionCookie(token) });
}, { auth: false });

route('POST', '/api/login', async (req, res) => {
  const { email, password } = await readJson(req);
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').trim().toLowerCase());
  if (!u || !verifyPassword(String(password || ''), u.password_hash)) throw new HttpError(401, 'Wrong email or password');
  send(res, 200, publicUser(u), { 'Set-Cookie': sessionCookie(createSession(db, u.id)) });
}, { auth: false });

route('POST', '/api/logout', async (req, res) => {
  destroySession(db, parseCookies(req.headers.cookie).sid);
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}, { auth: false });

route('GET', '/api/me', async (req, res, { user }) => send(res, 200, publicUser(user)));

route('PATCH', '/api/me', async (req, res, { user }) => {
  const body = await readJson(req);
  const prefs = prefsOf(user);
  if (body.max_output_tokens !== undefined) prefs.max_output_tokens = Math.max(256, Math.min(32_000, Number(body.max_output_tokens) || 8192));
  if (body.free_only !== undefined) prefs.free_only = !!body.free_only;
  if (body.auto_switch !== undefined) prefs.auto_switch = !!body.auto_switch;
  db.prepare('UPDATE users SET preferences=? WHERE id=?').run(JSON.stringify(prefs), user.id);
  send(res, 200, publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)));
});

route('DELETE', '/api/me', async (req, res, { user }) => {
  db.prepare('DELETE FROM users WHERE id=?').run(user.id); // cascades to all of the user's data
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
});

route('GET', '/api/models', async (req, res) => {
  try {
    // Aggregate preference wins (counts only, no content) feed the "best" ranking.
    const wins = new Map(db.prepare(`SELECT winning_model, COUNT(*) n FROM preference_events
      WHERE created_at > ? AND event_type IN ('use_as_context','final','continue') GROUP BY winning_model`)
      .all(now() - 30 * 86400_000).map((r) => [r.winning_model, r.n]));
    const models = (await getCatalog()).map((m) => {
      const health = healthOf(m.id);
      return { ...m, health, chat: !NOT_CHAT.test(m.id), quality: qualityScore(m, { health, wins: wins.get(m.id) || 0 }) };
    });
    send(res, 200, { models, max_models: MAX_MODELS });
  }
  catch (e) { throw new HttpError(502, `Could not load the model catalog: ${e.message}`); }
});

// ---------- skills ----------
route('GET', '/api/skills', async (req, res, { user }) => {
  send(res, 200, db.prepare(`SELECT ${SKILL_COLS} FROM skills WHERE user_id=? ORDER BY name COLLATE NOCASE`).all(user.id));
});
route('POST', '/api/skills', async (req, res, { user }) => {
  const k = cleanSkill(await readJson(req));
  if (db.prepare('SELECT COUNT(*) n FROM skills WHERE user_id=?').get(user.id).n >= 50) throw new HttpError(400, 'Limit of 50 skills');
  const id = uid(), t = now();
  db.prepare('INSERT INTO skills (id, user_id, name, description, instructions, auto, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, user.id, k.name, k.description || '', k.instructions, k.auto || 0, t, t);
  send(res, 201, ownSkill(user, id));
});
route('PATCH', '/api/skills/:id', async (req, res, { user, params }) => {
  const k = ownSkill(user, params.id);
  const upd = cleanSkill(await readJson(req), true);
  const cols = Object.keys(upd);
  if (cols.length) db.prepare(`UPDATE skills SET ${cols.map((c) => `${c}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...cols.map((c) => upd[c]), now(), k.id);
  send(res, 200, ownSkill(user, k.id));
});
route('DELETE', '/api/skills/:id', async (req, res, { user, params }) => {
  const k = ownSkill(user, params.id);
  db.prepare('DELETE FROM skills WHERE id=?').run(k.id);
  send(res, 200, { ok: true });
});
route('PUT', '/api/conversations/:id/skills/:skill', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id); const k = ownSkill(user, params.skill);
  db.prepare('INSERT OR IGNORE INTO conversation_skills (conversation_id, skill_id, added_at) VALUES (?,?,?)').run(c.id, k.id, now());
  send(res, 200, conversationPayload(c));
});
route('DELETE', '/api/conversations/:id/skills/:skill', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  db.prepare('DELETE FROM conversation_skills WHERE conversation_id=? AND skill_id=?').run(c.id, params.skill);
  send(res, 200, conversationPayload(c));
});

// Checks up to 8 models in parallel with a tiny request and records their health.
route('POST', '/api/models/probe', async (req, res) => {
  const { ids = [] } = await readJson(req);
  const list = [...new Set(ids.map(String))].slice(0, 8);
  for (const id of list) if (!(await getModel(id))) throw new HttpError(400, `Unknown model: ${id}`);
  const results = await Promise.all(list.map((id) => probeModel(API_KEY, id)));
  for (const r of results) {
    if (r.health === 'ok') recordOk(r.model);
    else if (r.health === 'busy') recordLimited(r.model);
    else if (r.health === 'blocked') recordBlocked(r.model);
  }
  send(res, 200, { results });
});

route('GET', '/api/conversations', async (req, res, { user }) => {
  send(res, 200, db.prepare(`SELECT c.id, c.title, c.created_at, c.updated_at,
    (SELECT COUNT(*) FROM turns t WHERE t.conversation_id=c.id) AS turns
    FROM conversations c WHERE c.user_id=? ORDER BY c.updated_at DESC`).all(user.id));
});

route('POST', '/api/conversations', async (req, res, { user }) => {
  const { models = [], title, skill_ids } = await readJson(req);
  const ids = [...new Set(models.map(String))];
  if (!ids.length) throw new HttpError(400, 'Pick at least one model');
  if (ids.length > MAX_MODELS) throw new HttpError(400, `Pick at most ${MAX_MODELS} models`);
  for (const m of ids) if (!(await getModel(m))) throw new HttpError(400, `Unknown model: ${m}`);
  const id = uid(), t = now();
  tx(db, () => {
    db.prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(id, user.id, String(title || 'New conversation').slice(0, 120), t, t);
    ids.forEach((m, i) => db.prepare('INSERT INTO conversation_models (conversation_id, model_id, status, position, added_at) VALUES (?,?,?,?,?)')
      .run(id, m, 'active', i, t));
    // Skills: explicit list from the new-chat screen, otherwise the user's "on for new chats" skills.
    const skillRows = Array.isArray(skill_ids)
      ? skill_ids.map((sid) => db.prepare('SELECT id FROM skills WHERE id=? AND user_id=?').get(String(sid), user.id)).filter(Boolean)
      : db.prepare('SELECT id FROM skills WHERE user_id=? AND auto=1').all(user.id);
    skillRows.forEach((k, i) => db.prepare('INSERT OR IGNORE INTO conversation_skills (conversation_id, skill_id, added_at) VALUES (?,?,?)').run(id, k.id, t + i));
  });
  send(res, 201, conversationPayload(ownConversation(user, id)));
});

route('GET', '/api/conversations/:id', async (req, res, { user, params }) => send(res, 200, conversationPayload(ownConversation(user, params.id))));

route('PATCH', '/api/conversations/:id', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  const { title } = await readJson(req);
  if (title?.trim()) db.prepare('UPDATE conversations SET title=? WHERE id=?').run(title.trim().slice(0, 120), c.id);
  send(res, 200, conversationPayload(ownConversation(user, c.id)));
});

route('DELETE', '/api/conversations/:id', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  for (const r of db.prepare('SELECT id FROM responses WHERE conversation_id=?').all(c.id)) running.get(r.id)?.abort('user');
  db.prepare('DELETE FROM conversations WHERE id=?').run(c.id);
  send(res, 200, { ok: true });
});

route('POST', '/api/conversations/:id/models', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  const { model_id } = await readJson(req);
  if (!(await getModel(model_id))) throw new HttpError(400, 'Unknown model');
  const rows = db.prepare('SELECT * FROM conversation_models WHERE conversation_id=?').all(c.id);
  if (rows.filter((r) => r.status === 'active' && r.model_id !== model_id).length >= MAX_MODELS)
    throw new HttpError(400, `At most ${MAX_MODELS} active models. Pause or remove one first.`);
  const existing = rows.find((r) => r.model_id === model_id);
  if (existing) db.prepare(`UPDATE conversation_models SET status='active', removed_at=NULL WHERE conversation_id=? AND model_id=?`).run(c.id, model_id);
  else db.prepare('INSERT INTO conversation_models (conversation_id, model_id, status, position, added_at) VALUES (?,?,?,?,?)')
    .run(c.id, model_id, 'active', rows.length, now());
  touch(c.id);
  send(res, 200, conversationPayload(c));
});

route('PATCH', '/api/conversations/:id/models/:model', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  const { status } = await readJson(req);
  if (!['active', 'paused'].includes(status)) throw new HttpError(400, 'status must be active or paused');
  const rows = db.prepare('SELECT * FROM conversation_models WHERE conversation_id=?').all(c.id);
  const row = rows.find((r) => r.model_id === params.model);
  if (!row) throw new HttpError(404, 'Model not in conversation');
  if (status === 'active' && row.status !== 'active' && rows.filter((r) => r.status === 'active').length >= MAX_MODELS)
    throw new HttpError(400, `At most ${MAX_MODELS} active models. Pause or remove one first.`);
  db.prepare('UPDATE conversation_models SET status=?, removed_at=NULL WHERE conversation_id=? AND model_id=?').run(status, c.id, params.model);
  send(res, 200, conversationPayload(c));
});

route('DELETE', '/api/conversations/:id/models/:model', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  db.prepare(`UPDATE conversation_models SET status='removed', removed_at=? WHERE conversation_id=? AND model_id=?`).run(now(), c.id, params.model);
  send(res, 200, conversationPayload(c)); // history stays visible
});

route('POST', '/api/conversations/:id/estimate', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  const { message = '', target, reply_to } = await readJson(req);
  const { targets } = resolveTargets(c.id, target);
  const ref = replyRef(c.id, reply_to);
  const draft = { conversation_id: c.id, created_at: now() + 1, user_message: String(message), reply_to_response: ref.id, reply_quote: ref.quote };
  const pins = pinsFor(c.id, null);
  const skills = skillsFor(c.id);
  const out = [];
  for (const t of targets) {
    const model = await getModel(t.model_id);
    const maxOut = maxOutFor(user, model);
    const { promptTokensEst, droppedTurns } = buildContext(db, draft, t.model_id, model, maxOut, pins, skills);
    const min = model ? promptTokensEst * model.prompt_price : null;
    const max = model ? min + maxOut * model.completion_price : null;
    out.push({ model_id: t.model_id, prompt_tokens: promptTokensEst, max_output: maxOut, free: !!model?.free, cost_min: min, cost_max: max, dropped_turns: droppedTurns });
  }
  send(res, 200, {
    models: out,
    cost_min: out.reduce((s, m) => s + (m.cost_min || 0), 0),
    cost_max: out.reduce((s, m) => s + (m.cost_max || 0), 0),
  });
});

route('POST', '/api/conversations/:id/messages', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  const { message, target, reply_to } = await readJson(req);
  const text = String(message || '').trim();
  if (!text) throw new HttpError(400, 'Message is empty');
  const { mode, targets } = resolveTargets(c.id, target);
  const ref = replyRef(c.id, reply_to);
  const turnId = uid(), t = now();
  tx(db, () => {
    db.prepare('INSERT INTO turns (id, conversation_id, user_message, mode, target_models, reply_to_response, reply_quote, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(turnId, c.id, text, mode, JSON.stringify(targets.map((x) => x.model_id)), ref.id, ref.quote, t);
    // "Continue with this" pins apply to exactly this next turn.
    db.prepare(`UPDATE context_selections SET consumed_turn_id=? WHERE conversation_id=? AND selection_type='continue'
                AND active=1 AND consumed_turn_id IS NULL`).run(turnId, c.id);
    targets.forEach((m) => db.prepare(`INSERT INTO responses (id, turn_id, conversation_id, model_id, display_position, status, created_at)
      VALUES (?,?,?,?,?, 'pending', ?)`).run(uid(), turnId, c.id, m.model_id, m.position, t));
    if (c.title === 'New conversation') db.prepare('UPDATE conversations SET title=? WHERE id=?').run(text.replace(/\s+/g, ' ').slice(0, 60), c.id);
    db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(t, c.id);
  });
  send(res, 201, conversationPayload(ownConversation(user, c.id)));
});

route('POST', '/api/responses/:id/run', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  if (r.status === 'completed') throw new HttpError(400, 'Response already completed');
  await runResponse(user, r, req, res);
});

route('GET', '/api/responses/:id/alternatives', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  const alts = (await rankAlternatives(r)).slice(0, 3).map((m) => ({ id: m.id, name: m.name, free: m.free, health: healthOf(m.id) }));
  send(res, 200, { alternatives: alts });
});

route('POST', '/api/responses/:id/replace', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  if (running.has(r.id)) throw new HttpError(409, 'Stop this response first');
  const { model_id } = await readJson(req);
  if (!(await getModel(model_id))) throw new HttpError(400, 'Unknown model');
  if (model_id === r.model_id) throw new HttpError(400, 'Pick a different model');
  const newId = swapLane(r, model_id, false);
  send(res, 200, { ...conversationPayload(ownConversation(user, r.conversation_id)), new_response_id: newId });
});

route('POST', '/api/responses/:id/stop', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  running.get(r.id)?.abort('user');
  send(res, 200, { ok: true });
});

route('GET', '/api/responses/:id/context', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  const row = db.prepare('SELECT context_snapshot FROM responses WHERE id=?').get(r.id);
  send(res, 200, { messages: row.context_snapshot ? JSON.parse(row.context_snapshot) : null });
});

route('POST', '/api/responses/:id/use', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  if (!r.content.trim()) throw new HttpError(400, 'Nothing to use yet');
  const { selected_text } = await readJson(req);
  const text = String(selected_text || '').trim() || r.content;
  db.prepare(`INSERT INTO context_selections (id, conversation_id, response_id, selected_text, selection_type, created_at)
              VALUES (?,?,?,?,'canonical',?)`).run(uid(), r.conversation_id, r.id, text, now());
  logPreference(user, r, 'use_as_context');
  send(res, 200, conversationPayload(ownConversation(user, r.conversation_id)));
});

route('POST', '/api/responses/:id/continue', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  if (!r.content.trim()) throw new HttpError(400, 'Nothing to continue from yet');
  tx(db, () => {
    db.prepare(`UPDATE context_selections SET active=0 WHERE conversation_id=? AND selection_type='continue' AND consumed_turn_id IS NULL`).run(r.conversation_id);
    db.prepare(`INSERT INTO context_selections (id, conversation_id, response_id, selected_text, selection_type, created_at)
                VALUES (?,?,?,?,'continue',?)`).run(uid(), r.conversation_id, r.id, r.content, now());
  });
  logPreference(user, r, 'continue');
  send(res, 200, conversationPayload(ownConversation(user, r.conversation_id)));
});

for (const flag of ['save', 'final']) {
  route('POST', `/api/responses/:id/${flag}`, async (req, res, { user, params }) => {
    const r = ownResponse(user, params.id);
    const col = flag === 'save' ? 'saved' : 'final';
    const value = r[col] ? 0 : 1;
    db.prepare(`UPDATE responses SET ${col}=? WHERE id=?`).run(value, r.id);
    if (value) logPreference(user, r, flag);
    send(res, 200, getResponseRow(r.id));
  });
}

route('DELETE', '/api/selections/:id', async (req, res, { user, params }) => {
  const s = db.prepare(`SELECT s.* FROM context_selections s JOIN conversations c ON c.id=s.conversation_id WHERE s.id=? AND c.user_id=?`)
    .get(params.id, user.id);
  if (!s) throw new HttpError(404, 'Selection not found');
  db.prepare('UPDATE context_selections SET active=0 WHERE id=?').run(s.id);
  send(res, 200, conversationPayload(ownConversation(user, s.conversation_id)));
});

// ---------- static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
async function serveStatic(req, res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (file.includes('..')) return send(res, 400, { error: 'Bad path' });
  try {
    const buf = await readFile(path.join(ROOT, 'public', file));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch {
    // SPA fallback
    const buf = await readFile(path.join(ROOT, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(buf);
  }
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res, url.pathname);
    // Basic CSRF guard for a cookie-authenticated JSON API.
    if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
      throw new HttpError(403, 'Cross-origin request blocked');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const user = userFromRequest(db, req);
      if (r.auth && !user) throw new HttpError(401, 'Please sign in');
      return await r.handler(req, res, { user, params });
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
    else res.end();
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => console.log(`Multi-model workspace running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}
export { db };
