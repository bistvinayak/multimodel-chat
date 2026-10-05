import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream, readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './lib/db.js';
import { hashPassword, verifyPassword, createSession, destroySession, userFromRequest, parseCookies, sessionCookie } from './lib/auth.js';
import { getCatalog, getModel, qualityScore, NOT_CHAT } from './lib/models.js';
import { healthOf, recordOk, recordLimited, recordBlocked } from './lib/health.js';
import * as lf from './lib/langfuse.js';
import { buildContext } from './lib/context.js';
import { streamCompletion, ModelError, probeModel, complete, keyInfo } from './lib/openrouter.js';
import { initSecrets, encrypt, decrypt } from './lib/secrets.js';
import { evaluateWithJev, evaluateWithJudge, buildBrief, overall, CRITERIA, DEFAULT_CRITERIA } from './lib/evaluator.js';
import { safeFetch, checkRobots, extractStructured, extractWithAI, conditionMet, buyLinks } from './lib/watch.js';
import { SOURCES, COMPANY_PRESETS, collect, prefilter, dedupeKey, scoreRelevance, pageDigest, judgePage, planRequest, terms as monTerms } from './lib/monitor.js';
import { detect, safeName, LIMITS, MAX_PER_MESSAGE, extractPdfText, describeImage, materialize } from './lib/attachments.js';
import { titlePrompt, cleanTitle, summaryPlan, summaryPrompt } from './lib/memory.js';

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
if (!API_KEY) console.warn('Note: OPENROUTER_API_KEY is not set. Only users who add their own key in Settings can chat.');

const DB_FILE = process.env.DB_PATH || path.join(ROOT, 'data', 'app.db');
const db = openDb(DB_FILE);
initSecrets(path.dirname(DB_FILE));
const UPLOAD_DIR = path.join(path.dirname(DB_FILE), 'uploads');

// ---------- per-user OpenRouter keys ----------
const keyCache = new Map(); // user id -> { blob, key }
function personalKey(user) {
  if (!user?.openrouter_key_enc) return null;
  const hit = keyCache.get(user.id);
  if (hit?.blob === user.openrouter_key_enc) return hit.key;
  try { const key = decrypt(user.openrouter_key_enc); keyCache.set(user.id, { blob: user.openrouter_key_enc, key }); return key; }
  catch { console.warn(`[keys] could not decrypt the key for user ${user.id}. Was data/secret.key or APP_SECRET changed?`); return null; }
}
/** The key a user's requests run on: their own if they added one, else the shared server key. */
function keyFor(user) {
  const fresh = user?.id ? db.prepare('SELECT id, openrouter_key_enc FROM users WHERE id=?').get(user.id) : null;
  const own = personalKey(fresh || user);
  if (own) return { key: own, source: 'personal' };
  if (API_KEY) return { key: API_KEY, source: 'shared' };
  throw new ModelError('no_key', 'No OpenRouter key is available. Add your own key in Settings.');
}
const userById = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);

// Jev (TypeSafe) key: the user's own, else the server's TYPESAFE_API_KEY, else none (fallback judge).
const JEV_BASE = (process.env.TYPESAFE_API_BASE || 'https://api.typesafe.ai').replace(/\/+$/, '');
function jevKeyFor(user) {
  const u = userById(user.id);
  if (u?.jev_key_enc) { try { return { key: decrypt(u.jev_key_enc), source: 'personal' }; } catch { /* fall through */ } }
  return process.env.TYPESAFE_API_KEY ? { key: process.env.TYPESAFE_API_KEY, source: 'shared' } : null;
}
let lfProject = null; // Langfuse project URL, for deep links
if (lf.enabled()) lf.projectUrl().then((u) => { lfProject = u; console.log(u ? `Langfuse tracing on: ${u}` : 'Langfuse keys set, but the project lookup failed. Check LANGFUSE_HOST and keys.'); });
const running = new Map(); // response_id -> { ctl, convId, content, reasoning, retrying, switching }

// ---------- live event hub: one NDJSON stream per open chat, any number of tabs ----------
const hubs = new Map(); // conversation_id -> Set<ServerResponse>
function publish(convId, ev) {
  const subs = hubs.get(convId); if (!subs) return;
  const line = JSON.stringify(ev) + '\n';
  for (const r of subs) if (!r.writableEnded && !r.destroyed) r.write(line);
}
const uid = () => crypto.randomUUID();
const now = () => Date.now();
const DEFAULT_PREFS = { max_output_tokens: 8192, free_only: true, auto_switch: true };

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

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
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, created_at: u.created_at, preferences: prefsOf(u),
  openrouter_key: u.openrouter_key_enc ? { set: true, last4: u.openrouter_key_last4, added_at: u.openrouter_key_added_at } : { set: false },
  shared_key_available: !!API_KEY,
  jev_key: u.jev_key_enc ? { set: true, last4: u.jev_key_last4 } : { set: false }, jev_shared_available: !!process.env.TYPESAFE_API_KEY });

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
  saved, final, attempts, replaced_by, stands_in_for, auto_switched, trace_span_id, key_source, rating, created_at, finished_at,
  json_array_length(versions) AS version_count`;
const getResponseRow = (id) => db.prepare(`SELECT ${RESPONSE_COLS} FROM responses WHERE id=?`).get(id);

function conversationPayload(conv) {
  const models = db.prepare('SELECT * FROM conversation_models WHERE conversation_id=? ORDER BY position').all(conv.id);
  const turns = db.prepare('SELECT * FROM turns WHERE conversation_id=? ORDER BY created_at').all(conv.id);
  const responses = db.prepare(`SELECT ${RESPONSE_COLS} FROM responses WHERE conversation_id=? ORDER BY display_position`).all(conv.id);
  const byTurn = new Map(turns.map((t) => [t.id, []]));
  const attByTurn = new Map();
  for (const a of db.prepare(`SELECT turn_id, ${ATT_PUBLIC} FROM attachments WHERE conversation_id=? AND turn_id IS NOT NULL ORDER BY created_at`).all(conv.id)) {
    if (!attByTurn.has(a.turn_id)) attByTurn.set(a.turn_id, []);
    attByTurn.get(a.turn_id).push(a);
  }
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
    turns: turns.map((t) => ({ ...t, target_models: JSON.parse(t.target_models), trace_id: lf.traceIdFor(t.id), responses: byTurn.get(t.id),
      attachments: attByTurn.get(t.id) || [] })),
    langfuse: lf.enabled() && lfProject ? { session_url: `${lfProject}/sessions/${encodeURIComponent(conv.id)}`, trace_base: `${lfProject}/traces/` } : null,
    selections,
    stats,
    evaluations: db.prepare('SELECT id FROM evaluations WHERE conversation_id=? ORDER BY created_at').all(conv.id).map((e) => evaluationPayload(e.id)),
    memory: conv.conversation_summary ? { summary: conv.conversation_summary, upto: conv.summary_upto } : null,
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

function ownUnsentAttachments(user, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (list.length > MAX_PER_MESSAGE) throw new HttpError(400, `At most ${MAX_PER_MESSAGE} files per message`);
  return list.map((id) => {
    const a = db.prepare('SELECT * FROM attachments WHERE id=? AND user_id=?').get(id, user.id);
    if (!a) throw new HttpError(400, 'One of the attached files was not found. Remove it and attach it again.');
    if (a.turn_id) throw new HttpError(400, `${a.name} was already sent with another message`);
    return a;
  });
}

function replyRef(convId, reply_to) {
  if (!reply_to?.response_id) return { id: null, quote: null };
  const r = db.prepare('SELECT id FROM responses WHERE id=? AND conversation_id=?').get(String(reply_to.response_id), convId);
  if (!r) throw new HttpError(400, 'The answer you are replying to is not in this conversation');
  return { id: r.id, quote: reply_to.quote ? String(reply_to.quote).slice(0, 8000) : null };
}

function logPreference(user, resp, eventType) {
  if (lf.enabled()) {
    const cur = db.prepare('SELECT trace_span_id FROM responses WHERE id=?').get(resp.id);
    lf.score({ name: `user_${eventType}`, traceId: lf.traceIdFor(resp.turn_id), observationId: cur?.trace_span_id || undefined,
      comment: `User chose ${resp.model_id}`, metadata: { model: resp.model_id, response_id: resp.id, display_position: resp.display_position } });
  }
  const others = db.prepare('SELECT id, model_id FROM responses WHERE turn_id=? AND id<>?').all(resp.turn_id, resp.id);
  db.prepare(`INSERT INTO preference_events (id, user_id, conversation_id, turn_id, event_type, winning_response, winning_model,
              compared_responses, compared_models, display_position, task_type, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid(), user.id, resp.conversation_id, resp.turn_id, eventType, resp.id, resp.model_id,
      JSON.stringify(others.map((o) => o.id)), JSON.stringify(others.map((o) => o.model_id)), resp.display_position, null, now());
}

// ---------- attachments ----------
const ATT_PUBLIC = 'id, name, kind, mime, size, status, error, created_at, (description IS NOT NULL) AS has_description, (text_content IS NOT NULL) AS has_text';
const attJobs = new Map(); // attachment id -> Promise (PDF extraction / image description)
const attRow = (id) => db.prepare('SELECT * FROM attachments WHERE id=?').get(id);

async function visionModels(prefer = []) {
  const catalog = await getCatalog();
  const ranked = catalog.filter((m) => m.free && m.vision && !NOT_CHAT.test(m.id) && !['busy', 'blocked'].includes(healthOf(m.id)) && m.id.endsWith(':free'))
    .sort((a, b) => qualityScore(b, { health: healthOf(b.id) }) - qualityScore(a, { health: healthOf(a.id) }));
  return [...prefer.map((id) => ranked.find((m) => m.id === id)).filter(Boolean), ...ranked].filter((m, i, arr) => arr.indexOf(m) === i).slice(0, 4);
}

// Runs once per file, right after upload, so it is usually done before the message is sent.
function processAttachment(user, a) {
  const job = (async () => {
    let apiKey;
    try { apiKey = keyFor(user).key; } catch { return; }
    if (a.kind === 'pdf') {
      let lastErr;
      for (const m of await backgroundModels()) {
        try {
          const text = await extractPdfText({ apiKey, model: m.id, filePath: a.path, filename: a.name });
          db.prepare(`UPDATE attachments SET text_content=?, status='ready', error=NULL WHERE id=?`).run(text, a.id);
          return;
        } catch (e) { lastErr = e; if (/scanned|No text/.test(e.message)) break; }
      }
      // Fall back to letting OpenRouter parse it on every request.
      db.prepare(`UPDATE attachments SET status='ready', error=? WHERE id=?`).run(`Text extraction failed (${lastErr?.message || 'unknown'}). Models will receive the PDF file directly.`, a.id);
    } else if (a.kind === 'image') {
      for (const m of await visionModels(['qwen/qwen3.8-27b:free', 'google/gemma-4-31b-it:free'])) {
        try {
          const text = await describeImage({ apiKey, model: m.id, filePath: a.path, mime: a.mime });
          db.prepare('UPDATE attachments SET description=?, description_model=? WHERE id=?').run(text, m.id, a.id);
          return;
        } catch { /* next model */ }
      }
    }
  })().catch((e) => console.warn('[attachments]', e.message)).finally(() => attJobs.delete(a.id));
  attJobs.set(a.id, job);
  return job;
}

/** Wait (bounded) for any processing of this turn's files, so every model gets the extracted text. */
async function awaitAttachments(turnId, ms = 60_000) {
  const jobs = db.prepare('SELECT id FROM attachments WHERE turn_id=?').all(turnId).map((a) => attJobs.get(a.id)).filter(Boolean);
  if (jobs.length) await Promise.race([Promise.allSettled(jobs), new Promise((ok) => setTimeout(ok, ms))]);
}

async function removeFiles(rows) {
  for (const r of rows) await rm(r.path, { force: true }).catch(() => {});
}

// Files uploaded but never sent are deleted after a day.
setInterval(async () => {
  const stale = db.prepare('SELECT id, path FROM attachments WHERE turn_id IS NULL AND created_at < ?').all(now() - 24 * 3600_000);
  await removeFiles(stale);
  for (const r of stale) db.prepare('DELETE FROM attachments WHERE id=?').run(r.id);
}, 3600_000).unref();

// ---------- lane swaps (manual and automatic) ----------
// Healthy models that could stand in for a busy/failed lane, best first.
async function rankAlternatives(r) {
  const inConv = new Set(db.prepare(`SELECT model_id FROM conversation_models WHERE conversation_id=? AND status<>'removed'`)
    .all(r.conversation_id).map((x) => x.model_id));
  const cur = await getModel(r.model_id);
  const wantTags = new Set((cur?.tags || []).filter((t) => t !== 'free'));
  const vendor = (id) => id.split('/')[0];
  const limited = r.error_kind === 'rate_limit' || r.status === 'rate_limited';
  const hasImages = !!db.prepare(`SELECT 1 FROM attachments WHERE turn_id=? AND kind='image' LIMIT 1`).get(r.turn_id);
  const score = (m) => ({ ok: 4, unknown: 1 }[healthOf(m.id)] || 0)
    + qualityScore(m, { health: healthOf(m.id) }) / 4                       // prefer stronger models
    + m.tags.filter((t) => wantTags.has(t)).length
    + (m.context_length >= (cur?.context_length || 0) ? 1 : 0)
    + (m.id.endsWith(':free') ? 1 : 0)                                    // zero-priced non-:free endpoints can still demand credits
    - (limited && vendor(m.id) === vendor(r.model_id) ? 3 : 0)            // same vendor likely shares the exhausted pool
    + (hasImages && m.vision ? 4 : 0) - (hasImages && cur?.vision && !m.vision ? 2 : 0); // keep image understanding when the message has images
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
async function pickStandIn(r, apiKey) {
  const candidates = (await rankAlternatives({ ...r, status: 'rate_limited', error_kind: 'rate_limit' })).slice(0, 4);
  if (!candidates.length) return null;
  const results = await Promise.all(candidates.map((m) => probeModel(apiKey, m.id)));
  results.forEach((x) => (x.health === 'ok' ? recordOk(x.model) : x.health === 'busy' ? recordLimited(x.model) : x.health === 'blocked' ? recordBlocked(x.model) : null));
  return candidates.find((m, i) => results[i].health === 'ok') || null;
}

// ---------- Langfuse tracing (never allowed to break a chat) ----------
function traceRun(user, turn, respId, spanId, startedAt, messages, maxOut, events) {
  if (!lf.enabled()) return;
  try {
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(turn.conversation_id);
    const resp = db.prepare('SELECT * FROM responses WHERE id=?').get(respId);
    db.prepare('UPDATE responses SET trace_span_id=? WHERE id=?').run(spanId, respId);
    lf.enqueue(lf.generationSpan({ conv, user, turn, resp, spanId, startedAt, messages, maxOut, events }));
  } catch (e) { console.warn('[langfuse] trace failed:', e.message); }
}

// The turn's root span goes out once every model in it has finished (stand-ins included).
function maybeTraceTurn(user, turnId) {
  if (!lf.enabled()) return;
  const turn = db.prepare('SELECT * FROM turns WHERE id=?').get(turnId);
  if (!turn || turn.traced) return;
  const responses = db.prepare('SELECT * FROM responses WHERE turn_id=? ORDER BY display_position').all(turnId);
  if (responses.some((r) => ['pending', 'generating'].includes(r.status) || running.has(r.id))) return;
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(turn.conversation_id);
  const turnIndex = db.prepare('SELECT COUNT(*) n FROM turns WHERE conversation_id=? AND created_at <= ?').get(conv.id, turn.created_at).n;
  const decisions = db.prepare(`SELECT COUNT(*) n FROM context_selections WHERE conversation_id=? AND selection_type='canonical' AND active=1 AND created_at < ?`).get(conv.id, turn.created_at).n;
  db.prepare('UPDATE turns SET traced=1 WHERE id=?').run(turnId);
  lf.enqueue(lf.turnSpan({ conv, user, turn, responses, skills: skillsFor(conv.id), decisions, turnIndex }));
}

// ---------- model run (streams NDJSON to the client) ----------
const summaryOf = (convId) => {
  const c = db.prepare('SELECT conversation_summary, summary_upto FROM conversations WHERE id=?').get(convId);
  return c?.conversation_summary ? { text: c.conversation_summary, upto: c.summary_upto || 0 } : null;
};

/** Starts a model run in the background. It keeps going if the browser reloads or disconnects. */
function startRun(user, respId, { regenerate = false } = {}) {
  if (running.has(respId)) throw new HttpError(409, 'This response is already generating');
  const resp = db.prepare('SELECT * FROM responses WHERE id=?').get(respId);
  if (!resp) throw new HttpError(404, 'Response not found');
  if (regenerate) archiveVersion(resp);
  // Reserve the slot synchronously so double clicks can't start two runs.
  running.set(respId, { ctl: new AbortController(), convId: resp.conversation_id, content: '', reasoning: '', retrying: null, switching: false });
  runResponse(user, resp).catch((e) => console.error('[run]', e));
}

function archiveVersion(resp) {
  if (!resp.content?.trim()) return;
  const versions = JSON.parse(resp.versions || '[]');
  versions.push({ content: resp.content, reasoning: resp.reasoning, status: resp.status, prompt_tokens: resp.prompt_tokens,
    completion_tokens: resp.completion_tokens, cost: resp.cost, latency_ms: resp.latency_ms, finished_at: resp.finished_at });
  db.prepare('UPDATE responses SET versions=? WHERE id=?').run(JSON.stringify(versions.slice(-10)), resp.id);
}

async function runResponse(user, resp) {
  const state = running.get(resp.id);
  const ctl = state.ctl;
  const emit = (obj) => publish(resp.conversation_id, { ...obj, rid: resp.id });
  const turn = db.prepare('SELECT * FROM turns WHERE id=?').get(resp.turn_id);
  let messages = [], maxOut = 0, started = now();
  const spanId = lf.newSpanId();
  const events = []; // retries and switches, attached to the Langfuse generation
  let content = '', reasoning = '', lastFlush = now();
  const flush = (force) => {
    if (force || now() - lastFlush > 1500) {
      db.prepare('UPDATE responses SET content=?, reasoning=? WHERE id=?').run(content, reasoning, resp.id);
      lastFlush = now();
    }
  };

  try {
    const auth = keyFor(user); // throws a clear error if neither a personal nor a shared key exists
    const model = await getModel(resp.model_id);
    maxOut = maxOutFor(user, model);
    await awaitAttachments(turn.id);
    let needsFileParser;
    ({ messages, needsFileParser } = buildContext(db, turn, resp.model_id, model, maxOut, pinsFor(turn.conversation_id, turn.id),
      skillsFor(turn.conversation_id), { summary: summaryOf(turn.conversation_id) }));
    // The snapshot keeps attachment:// references; real bytes are added only for the request.
    const wire = await materialize(messages, attRow);
    const plugins = needsFileParser ? [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }] : undefined;
    db.prepare(`UPDATE responses SET status='generating', content='', reasoning='', error=NULL, error_kind=NULL, finish_reason=NULL,
                latency_ms=NULL, first_token_ms=NULL, prompt_tokens=NULL, completion_tokens=NULL, cost=NULL, replaced_by=NULL,
                attempts=attempts+1, context_snapshot=?, key_source=?, finished_at=NULL WHERE id=?`).run(JSON.stringify(messages), auth.source, resp.id);
    started = now();
    emit({ type: 'start', response: getResponseRow(resp.id) });

    let stats;
    // Free models are often rate-limited upstream for a few seconds: retry the SAME model with backoff.
    for (let attempt = 0; ; attempt++) {
      try {
        stats = await streamCompletion({
          apiKey: auth.key, model: resp.model_id, messages: wire, plugins, maxTokens: maxOut, signal: ctl.signal,
          onDelta: (t) => { content += t; state.content = content; state.retrying = null; emit({ type: 'delta', content: t }); flush(); },
          onReasoning: (t) => { reasoning += t; state.reasoning = reasoning; state.retrying = null; emit({ type: 'reasoning', content: t }); flush(); },
        });
        break;
      } catch (e) {
        if (e instanceof ModelError && e.kind === 'rate_limit') recordLimited(resp.model_id);
        const maxRetries = prefsOf(user).auto_switch ? AUTO_SWITCH_RETRIES : RATE_LIMIT_RETRIES;
        const retryable = e instanceof ModelError && e.kind === 'rate_limit' && !content && !reasoning && attempt < maxRetries
          && !(e.retryAfterMs > 60_000);
        if (!retryable) { e.attempts = attempt + 1; throw e; }
        const wait = e.retryAfterMs ?? backoffMs(attempt);
        state.retrying = { attempt: attempt + 1, of: maxRetries, wait_ms: wait, at: now() };
        emit({ type: 'retrying', attempt: attempt + 1, of: maxRetries, wait_ms: wait });
        events.push({ name: 'rate_limited_retry', time: now(), attributes: { attempt: attempt + 1, wait_ms: wait, error: e.message.slice(0, 300) } });
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
        : `Still rate limited after ${me.attempts || 1} attempts over about ${Math.round((now() - started) / 1000)}s. Raw: ${me.message}`;
    }
    db.prepare(`UPDATE responses SET content=?, reasoning=?, status=?, error=?, error_kind=?, finished_at=? WHERE id=?`)
      .run(content, reasoning, status, me.kind === 'stopped' ? null : me.message, me.kind, now(), resp.id);
    if (me.kind === 'rate_limit' && prefsOf(user).auto_switch && !ctl.signal.aborted && standInDepth(resp.id) < MAX_AUTO_SWITCHES) {
      state.switching = true;
      emit({ type: 'switching' });
      events.push({ name: 'auto_switch_started', time: now() });
      try {
        const alt = await pickStandIn(getResponseRow(resp.id), keyFor(user).key);
        if (alt) {
          const newId = swapLane(getResponseRow(resp.id), alt.id, true);
          events.push({ name: 'auto_switched', time: now(), attributes: { from: resp.model_id, to: alt.id, new_response_id: newId } });
          startRun(user, newId); // the stand-in starts right away, server side
          emit({ type: 'switched', from: resp.model_id, to: alt.id, new_response_id: newId });
        } else {
          emit({ type: 'switch_failed', message: 'No other free model is answering right now.' });
          events.push({ name: 'auto_switch_failed', time: now(), attributes: { reason: 'no responding alternative' } });
        }
      } catch (err) { emit({ type: 'switch_failed', message: err.message }); events.push({ name: 'auto_switch_failed', time: now(), attributes: { reason: err.message } }); }
    }
  } finally {
    running.delete(resp.id);
    touch(resp.conversation_id);
    traceRun(user, turn, resp.id, spanId, started, messages, maxOut, events);
    emit({ type: 'final', response: getResponseRow(resp.id) });
    onTurnSettled(user, turn.id);
  }
}

// ---------- when every model in a turn has finished ----------
function onTurnSettled(user, turnId) {
  const responses = db.prepare('SELECT status, id FROM responses WHERE turn_id=?').all(turnId);
  if (responses.some((r) => ['pending', 'generating'].includes(r.status) || running.has(r.id))) return;
  try { maybeTraceTurn(user, turnId); } catch (e) { console.warn('[langfuse]', e.message); }
  const turn = db.prepare('SELECT conversation_id FROM turns WHERE id=?').get(turnId);
  maybeTitle(turn.conversation_id).catch((e) => console.warn('[title]', e.message));
  maybeSummarize(turn.conversation_id).catch((e) => console.warn('[summary]', e.message));
}

// Strong, currently-healthy free models first, for background jobs.
async function backgroundModels(prefer = []) {
  const catalog = await getCatalog();
  const ranked = catalog.filter((m) => m.free && !NOT_CHAT.test(m.id) && !['busy', 'blocked'].includes(healthOf(m.id)) && m.id.endsWith(':free'))
    .sort((a, b) => qualityScore(b, { health: healthOf(b.id) }) - qualityScore(a, { health: healthOf(a.id) }));
  const preferred = prefer.map((id) => ranked.find((m) => m.id === id)).filter(Boolean);
  return [...new Set([...preferred, ...ranked])].slice(0, 4);
}

const titling = new Set();
async function maybeTitle(convId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(convId);
  if (!conv || conv.title_source !== 'auto' || titling.has(convId)) return;
  const first = db.prepare('SELECT * FROM turns WHERE conversation_id=? ORDER BY created_at LIMIT 1').get(convId);
  const answer = first && db.prepare(`SELECT model_id, content FROM responses WHERE turn_id=? AND status='completed' ORDER BY latency_ms LIMIT 1`).get(first.id);
  if (!answer) return;
  titling.add(convId);
  try {
    for (const m of await backgroundModels([answer.model_id])) {
      try {
        const title = cleanTitle(await complete({ apiKey: keyFor(userById(conv.user_id)).key, model: m.id, messages: titlePrompt(first.user_message, answer.content), maxTokens: 400, timeoutMs: 30_000 }));
        if (!title) continue;
        const cur = db.prepare('SELECT title_source FROM conversations WHERE id=?').get(convId);
        if (cur?.title_source !== 'auto') return; // the user renamed it meanwhile
        db.prepare(`UPDATE conversations SET title=?, title_source='ai' WHERE id=?`).run(title, convId);
        publish(convId, { type: 'title', title });
        return;
      } catch { /* try the next model */ }
    }
  } finally { titling.delete(convId); }
}

const summarizing = new Set();
async function maybeSummarize(convId) {
  if (summarizing.has(convId)) return;
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(convId);
  const turns = db.prepare('SELECT id, user_message, created_at FROM turns WHERE conversation_id=? ORDER BY created_at').all(convId);
  const decisions = db.prepare(`SELECT s.selected_text, r.model_id FROM context_selections s JOIN responses r ON r.id=s.response_id
    WHERE s.conversation_id=? AND s.selection_type='canonical' AND s.active=1 ORDER BY s.created_at`).all(convId)
    .map((d) => `- (from ${d.model_id}) ${d.selected_text.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n');
  const plan = summaryPlan(turns, conv.summary_upto, decisions);
  if (!plan) return;
  summarizing.add(convId);
  try {
    for (const m of await backgroundModels()) {
      try {
        const text = await complete({ apiKey: keyFor(userById(conv.user_id)).key, model: m.id, messages: summaryPrompt(conv.conversation_summary, plan.fold, decisions), maxTokens: 2500, timeoutMs: 90_000 });
        if (text.length < 40) continue;
        db.prepare('UPDATE conversations SET conversation_summary=?, summary_upto=? WHERE id=?').run(text, plan.upto, convId);
        publish(convId, { type: 'summary', upto: plan.upto });
        return;
      } catch { /* next model */ }
    }
  } finally { summarizing.delete(convId); }
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

// ---------- personal OpenRouter key (encrypted at rest, never returned to the browser) ----------
route('PUT', '/api/me/openrouter-key', async (req, res, { user }) => {
  const key = String((await readJson(req)).key || '').trim();
  if (!/^sk-or-[A-Za-z0-9_-]{20,}$/.test(key)) throw new HttpError(400, 'That does not look like an OpenRouter key. It should start with sk-or-.');
  let info;
  try { info = await keyInfo(key); }
  catch (e) { throw new HttpError(400, e.kind === 'invalid_key' ? 'OpenRouter rejected this key. Check it and try again.' : e.message); }
  db.prepare('UPDATE users SET openrouter_key_enc=?, openrouter_key_last4=?, openrouter_key_added_at=? WHERE id=?')
    .run(encrypt(key), key.slice(-4), now(), user.id);
  keyCache.delete(user.id);
  send(res, 200, { ...publicUser(userById(user.id)), key_info: info });
});

route('GET', '/api/me/openrouter-key', async (req, res, { user }) => {
  const own = personalKey(user);
  const target = own || API_KEY;
  if (!target) return send(res, 200, { source: 'none' });
  try { send(res, 200, { source: own ? 'personal' : 'shared', last4: own ? user.openrouter_key_last4 : null, ...(await keyInfo(target)) }); }
  catch (e) { send(res, 200, { source: own ? 'personal' : 'shared', error: e.message }); }
});

route('DELETE', '/api/me/openrouter-key', async (req, res, { user }) => {
  db.prepare('UPDATE users SET openrouter_key_enc=NULL, openrouter_key_last4=NULL, openrouter_key_added_at=NULL WHERE id=?').run(user.id);
  keyCache.delete(user.id);
  send(res, 200, publicUser(userById(user.id)));
});

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
  await rm(path.join(UPLOAD_DIR, user.id), { recursive: true, force: true });
  db.prepare('DELETE FROM users WHERE id=?').run(user.id); // cascades to all of the user's data
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
});

route('GET', '/api/langfuse/status', async (req, res) => {
  if (lf.enabled() && !lfProject) lfProject = await lf.projectUrl();
  send(res, 200, { ...lf.config(), project_url: lfProject, ...lf.stats, queued_flush: undefined });
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
route('POST', '/api/models/probe', async (req, res, { user }) => {
  const { ids = [] } = await readJson(req);
  const list = [...new Set(ids.map(String))].slice(0, 8);
  for (const id of list) if (!(await getModel(id))) throw new HttpError(400, `Unknown model: ${id}`);
  const apiKey = keyFor(user).key;
  const results = await Promise.all(list.map((id) => probeModel(apiKey, id)));
  for (const r of results) {
    if (r.health === 'ok') recordOk(r.model);
    else if (r.health === 'busy') recordLimited(r.model);
    else if (r.health === 'blocked') recordBlocked(r.model);
  }
  send(res, 200, { results });
});

// ---------- model comparison: catalog facts + the user's own usage data ----------
const PICK_EVENTS = `('use_as_context','continue','final','save')`;
function usageStats(userId, modelIds = null) {
  const filter = modelIds ? `AND r.model_id IN (${modelIds.map(() => '?').join(',')})` : '';
  const args = modelIds ? [userId, ...modelIds] : [userId];
  const base = db.prepare(`SELECT r.model_id,
      COUNT(*) AS answers,
      SUM(r.status='completed') AS completed,
      SUM(r.status='failed') AS failed,
      SUM(r.status='rate_limited') AS rate_limited,
      AVG(CASE WHEN r.status='completed' THEN r.latency_ms END) AS avg_latency_ms,
      AVG(CASE WHEN r.status='completed' THEN r.first_token_ms END) AS avg_first_token_ms,
      AVG(CASE WHEN r.status='completed' THEN r.completion_tokens END) AS avg_output_tokens,
      AVG(CASE WHEN r.status='completed' THEN r.cost END) AS avg_cost,
      SUM(COALESCE(r.cost, 0)) AS total_cost,
      MAX(r.created_at) AS last_used
    FROM responses r JOIN conversations c ON c.id=r.conversation_id
    WHERE c.user_id=? AND r.status NOT IN ('pending','generating') ${filter}
    GROUP BY r.model_id`).all(...args);
  // "Comparable situations": the answer was shown next to at least one other completed answer.
  const picks = db.prepare(`WITH multi AS (
        SELECT r.turn_id FROM responses r JOIN conversations c ON c.id=r.conversation_id
        WHERE c.user_id=? AND r.status='completed' GROUP BY r.turn_id HAVING COUNT(*) >= 2),
      picked AS (SELECT DISTINCT winning_response AS id FROM preference_events WHERE user_id=? AND event_type IN ${PICK_EVENTS})
    SELECT r.model_id, COUNT(*) AS shown, SUM(r.id IN (SELECT id FROM picked)) AS chosen
    FROM responses r WHERE r.status='completed' AND r.turn_id IN (SELECT turn_id FROM multi) ${filter.replace('AND r.', 'AND r.')}
    GROUP BY r.model_id`).all(userId, userId, ...(modelIds || []));
  const pickBy = new Map(picks.map((p) => [p.model_id, p]));
  return base.map((b) => {
    const p = pickBy.get(b.model_id) || { shown: 0, chosen: 0 };
    return { ...b, shown_in_comparisons: p.shown, chosen: p.chosen, pick_rate: p.shown ? p.chosen / p.shown : null,
      failure_rate: b.answers ? (b.failed + b.rate_limited) / b.answers : null };
  });
}

function headToHead(userId, ids) {
  const rows = db.prepare(`SELECT r.turn_id, r.model_id, r.id IN (SELECT winning_response FROM preference_events WHERE user_id=? AND event_type IN ${PICK_EVENTS}) AS picked
    FROM responses r JOIN conversations c ON c.id=r.conversation_id
    WHERE c.user_id=? AND r.status='completed' AND r.model_id IN (${ids.map(() => '?').join(',')})`).all(userId, userId, ...ids);
  const byTurn = new Map();
  for (const r of rows) { if (!byTurn.has(r.turn_id)) byTurn.set(r.turn_id, new Map()); byTurn.get(r.turn_id).set(r.model_id, !!r.picked); }
  const pairs = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i], b = ids[j]; let aw = 0, bw = 0, both = 0, neither = 0;
    for (const t of byTurn.values()) {
      if (!t.has(a) || !t.has(b)) continue;
      const pa = t.get(a), pb = t.get(b);
      if (pa && !pb) aw++; else if (pb && !pa) bw++; else if (pa && pb) both++; else neither++;
    }
    pairs.push({ a, b, a_wins: aw, b_wins: bw, both_picked: both, neither_picked: neither, together: aw + bw + both + neither });
  }
  return pairs;
}

route('GET', '/api/compare', async (req, res, { user }) => {
  const ids = [...new Set((new URL(req.url, 'http://x').searchParams.get('models') || '').split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 4);
  const catalog = await getCatalog();
  const freeRank = new Map(catalog.filter((m) => m.free && !NOT_CHAT.test(m.id) && healthOf(m.id) !== 'blocked')
    .map((m) => [m.id, qualityScore(m, { health: healthOf(m.id) })]).sort((a, b) => b[1] - a[1]).map(([id], i) => [id, i + 1]));
  const usage = new Map(usageStats(user.id, ids.length ? ids : null).map((u) => [u.model_id, u]));
  const models = ids.map((id) => {
    const m = catalog.find((x) => x.id === id);
    return { id, catalog: m ? { ...m, health: healthOf(id), quality: qualityScore(m, { health: healthOf(id) }), free_rank: freeRank.get(id) || null } : null, usage: usage.get(id) || null };
  });
  // Leaderboard: every model this user has used, best pick rate first (needs a few comparisons to rank).
  const leaderboard = usageStats(user.id).map((u) => ({ ...u, name: catalog.find((m) => m.id === u.model_id)?.name || u.model_id }))
    .sort((a, b) => ((b.shown_in_comparisons >= 3) - (a.shown_in_comparisons >= 3)) || ((b.pick_rate ?? -1) - (a.pick_rate ?? -1)) || b.answers - a.answers);
  send(res, 200, { models, head_to_head: ids.length >= 2 ? headToHead(user.id, ids) : [], leaderboard });
});

// ---------- uploads ----------
// Raw body upload (no multipart parsing needed): POST /api/uploads with X-Filename header.
route('POST', '/api/uploads', async (req, res, { user }) => {
  const name = safeName(decodeURIComponent(String(req.headers['x-filename'] || 'file')));
  const max = Math.max(...Object.values(LIMITS));
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > max) throw new HttpError(413, `Files can be at most ${Math.round(max / 1024 / 1024)} MB`);
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw new HttpError(413, `Files can be at most ${Math.round(max / 1024 / 1024)} MB`); chunks.push(c); }
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new HttpError(400, 'The file is empty');
  const kind = detect(buf, name);
  if (!kind) throw new HttpError(415, 'Unsupported file. Attach images (PNG, JPEG, WebP, GIF), PDFs, or text and code files.');
  if (buf.length > LIMITS[kind.kind]) throw new HttpError(413, `${kind.kind === 'image' ? 'Images' : kind.kind === 'pdf' ? 'PDFs' : 'Text files'} can be at most ${Math.round(LIMITS[kind.kind] / 1024 / 1024)} MB`);
  const id = uid();
  const dir = path.join(UPLOAD_DIR, user.id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, id);
  await writeFile(file, buf, { mode: 0o600 });
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  db.prepare(`INSERT INTO attachments (id, user_id, name, kind, mime, size, sha256, path, status, text_content, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, user.id, name, kind.kind, kind.mime, buf.length, sha, file, kind.kind === 'pdf' ? 'processing' : 'ready', kind.text ?? null, now());
  if (kind.kind !== 'text') processAttachment(user, attRow(id));
  send(res, 201, db.prepare(`SELECT ${ATT_PUBLIC} FROM attachments WHERE id=?`).get(id));
});

const ownAttachment = (user, id) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id=? AND user_id=?').get(id, user.id);
  if (!a) throw new HttpError(404, 'File not found');
  return a;
};

route('GET', '/api/uploads/:id', async (req, res, { user, params }) => {
  ownAttachment(user, params.id);
  send(res, 200, db.prepare(`SELECT ${ATT_PUBLIC}, description, description_model FROM attachments WHERE id=?`).get(params.id));
});

route('GET', '/api/uploads/:id/raw', async (req, res, { user, params }) => {
  const a = ownAttachment(user, params.id);
  await stat(a.path).catch(() => { throw new HttpError(404, 'File missing on disk'); });
  res.writeHead(200, {
    // Text is always served as plain text so an uploaded .html can never run as a page.
    'Content-Type': a.kind === 'text' ? 'text/plain; charset=utf-8' : a.mime,
    'Content-Length': a.size,
    'Content-Disposition': `${a.kind === 'text' ? 'attachment' : 'inline'}; filename="${a.name}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=86400',
  });
  createReadStream(a.path).pipe(res);
});

route('DELETE', '/api/uploads/:id', async (req, res, { user, params }) => {
  const a = ownAttachment(user, params.id);
  if (a.turn_id) throw new HttpError(400, 'This file is part of a sent message. Delete the chat to remove it.');
  await removeFiles([a]);
  db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
  send(res, 200, { ok: true });
});

// ---------- evaluation (Jev, or a fallback LLM judge) ----------
function evalBrief(turn) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(turn.conversation_id);
  const parts = [];
  const skills = skillsFor(conv.id);
  if (skills.length) parts.push(`User instructions (skills):\n${skills.map((k) => `- ${k.name}: ${k.instructions}`).join('\n')}`);
  const decisions = db.prepare(`SELECT selected_text FROM context_selections WHERE conversation_id=? AND selection_type='canonical' AND active=1 AND created_at < ?`).all(conv.id, turn.created_at);
  if (decisions.length) parts.push(`Decisions already agreed:\n${decisions.map((d) => `- ${d.selected_text.replace(/\s+/g, ' ').slice(0, 500)}`).join('\n')}`);
  if (conv.conversation_summary) parts.push(`Conversation so far:\n${conv.conversation_summary}`);
  const atts = db.prepare('SELECT name, kind, text_content, description FROM attachments WHERE turn_id=?').all(turn.id);
  if (atts.length) parts.push(`Attached files:\n${atts.map((a) => `- ${a.name}: ${(a.text_content || a.description || '').slice(0, 1500)}`).join('\n')}`);
  const reply = turn.reply_to_response ? db.prepare('SELECT content FROM responses WHERE id=?').get(turn.reply_to_response) : null;
  const question = `${turn.user_message}${reply ? `\n\n(The user is replying to this earlier answer: ${(turn.reply_quote || reply.content).slice(0, 1500)})` : ''}`;
  return buildBrief({ question, context: parts.join('\n\n') });
}

route('POST', '/api/evaluations', async (req, res, { user }) => {
  const { response_ids = [], criteria: wanted } = await readJson(req);
  const ids = [...new Set(response_ids.map(String))];
  if (!ids.length || ids.length > 6) throw new HttpError(400, 'Pick 1 to 6 answers to evaluate');
  const criteria = (Array.isArray(wanted) && wanted.length ? wanted : DEFAULT_CRITERIA).filter((k) => CRITERIA[k]);
  if (!criteria.length) throw new HttpError(400, 'Pick at least one criterion');
  const rows = ids.map((id) => ownResponse(user, id));
  if (new Set(rows.map((r) => r.conversation_id)).size > 1) throw new HttpError(400, 'Answers must come from the same chat');
  const empty = rows.find((r) => !r.content?.trim());
  if (empty) throw new HttpError(400, `${empty.model_id} has no answer to evaluate`);
  const turns = new Map(rows.map((r) => [r.turn_id, db.prepare('SELECT * FROM turns WHERE id=?').get(r.turn_id)]));
  const sameTurn = turns.size === 1;
  const candidates = rows.map((r) => ({ id: r.id, model_id: r.model_id, content: r.content, brief: evalBrief(turns.get(r.turn_id)), request: sameTurn ? null : turns.get(r.turn_id).user_message }));
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(rows[0].conversation_id);
  const commonBrief = sameTurn ? candidates[0].brief : buildBrief({ question: `Choose the best final output for this conversation: "${conv.title}". Each answer is shown with the request it answered.`, context: conv.conversation_summary || '' });

  const jevAuth = jevKeyFor(user);
  let out;
  try {
    out = jevAuth
      ? await evaluateWithJev({ apiKey: jevAuth.key, base: JEV_BASE, brief: commonBrief, candidates, criteria })
      : await evaluateWithJudge({ apiKey: keyFor(user).key, models: (await backgroundModels()).map((m) => m.id), brief: commonBrief, candidates, criteria });
  } catch (e) { throw new HttpError(502, e.message); }

  const evalId = uid();
  // When the evaluator gives no head-to-head pick, recommend the highest overall score.
  const overalls = out.results.map((r) => ({ id: r.response_id, overall: overall(r.scores) }));
  const pick = out.pick || (() => { const best = [...overalls].sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1))[0]; return best ? { response_id: best.id, confidence: null, probabilities: null } : null; })();
  tx(db, () => {
    db.prepare(`INSERT INTO evaluations (id, user_id, conversation_id, turn_id, evaluator, evaluator_model, criteria, candidates, recommended_response, recommended_confidence, probabilities, input_tokens, output_tokens, latency_ms, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(evalId, user.id, conv.id, sameTurn ? rows[0].turn_id : null, out.evaluator, out.evaluator_model, JSON.stringify(criteria), JSON.stringify(ids),
      pick?.response_id || null, pick?.confidence ?? null, pick?.probabilities ? JSON.stringify(pick.probabilities) : null, out.usage?.input_tokens ?? null, out.usage?.output_tokens ?? null, out.latency_ms, now());
    const ins = db.prepare('INSERT INTO evaluation_scores (evaluation_id, response_id, model_id, criterion, score, confidence) VALUES (?,?,?,?,?,?)');
    for (const r of out.results) {
      const model = rows.find((x) => x.id === r.response_id).model_id;
      for (const [k, v] of Object.entries(r.scores)) ins.run(evalId, r.response_id, model, k, v.value, v.confidence);
      ins.run(evalId, r.response_id, model, 'overall', overall(r.scores), null);
    }
  });
  // Mirror the evaluation into Langfuse as scores on each answer's generation.
  if (lf.enabled()) {
    for (const r of out.results) {
      const row = db.prepare('SELECT turn_id, trace_span_id FROM responses WHERE id=?').get(r.response_id);
      const base = { traceId: lf.traceIdFor(row.turn_id), observationId: row.trace_span_id || undefined, comment: `${out.evaluator} (${out.evaluator_model})` };
      for (const [k, v] of Object.entries(r.scores)) if (v.value != null) lf.score({ ...base, name: `eval_${k}`, value: v.value / 4 });
      lf.score({ ...base, name: 'eval_overall', value: overall(r.scores) ?? 0 });
      lf.score({ ...base, name: 'eval_recommended', value: pick?.response_id === r.response_id ? 1 : 0 });
    }
  }
  send(res, 201, evaluationPayload(evalId));
});

function evaluationPayload(id) {
  const e = db.prepare('SELECT * FROM evaluations WHERE id=?').get(id);
  const scores = db.prepare('SELECT * FROM evaluation_scores WHERE evaluation_id=?').all(id);
  const by = new Map();
  for (const sc of scores) { if (!by.has(sc.response_id)) by.set(sc.response_id, { response_id: sc.response_id, model_id: sc.model_id, scores: {} }); by.get(sc.response_id).scores[sc.criterion] = { value: sc.score, confidence: sc.confidence }; }
  // Did the user's own picks agree with the evaluator?
  const human = db.prepare(`SELECT DISTINCT winning_response FROM preference_events WHERE user_id=? AND event_type IN ('use_as_context','continue','final','save')
    AND winning_response IN (${JSON.parse(e.candidates).map(() => '?').join(',')})`).all(e.user_id, ...JSON.parse(e.candidates)).map((x) => x.winning_response);
  return { ...e, criteria: JSON.parse(e.criteria), candidates: JSON.parse(e.candidates), probabilities: e.probabilities ? JSON.parse(e.probabilities) : null,
    results: JSON.parse(e.candidates).map((rid) => by.get(rid)).filter(Boolean), human_picks: human,
    criteria_labels: Object.fromEntries(Object.entries(CRITERIA).map(([k, v]) => [k, v.label])) };
}

route('GET', '/api/conversations/:id/evaluations', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  send(res, 200, db.prepare('SELECT id FROM evaluations WHERE conversation_id=? ORDER BY created_at DESC').all(c.id).map((e) => evaluationPayload(e.id)));
});

route('GET', '/api/evaluator', async (req, res, { user }) => {
  const k = jevKeyFor(user);
  send(res, 200, { evaluator: k ? 'jev' : 'llm-judge', key_source: k?.source || null, criteria: Object.entries(CRITERIA).map(([key, v]) => ({ key, label: v.label, question: v.q, default: DEFAULT_CRITERIA.includes(key) })) });
});

route('PUT', '/api/me/jev-key', async (req, res, { user }) => {
  const key = String((await readJson(req)).key || '').trim();
  if (key.length < 16 || /\s/.test(key)) throw new HttpError(400, 'That does not look like a TypeSafe API key.');
  try { await evaluateWithJev({ apiKey: key, base: JEV_BASE, brief: 'Key check.', candidates: [{ id: 'x', content: 'OK' }], criteria: ['clarity'] }); }
  catch (e) { throw new HttpError(400, `Jev rejected the key: ${e.message}`); }
  db.prepare('UPDATE users SET jev_key_enc=?, jev_key_last4=? WHERE id=?').run(encrypt(key), key.slice(-4), user.id);
  send(res, 200, publicUser(userById(user.id)));
});
route('DELETE', '/api/me/jev-key', async (req, res, { user }) => {
  db.prepare('UPDATE users SET jev_key_enc=NULL, jev_key_last4=NULL WHERE id=?').run(user.id);
  send(res, 200, publicUser(userById(user.id)));
});

// ---------- metrics for AI PMs ----------
const pctl = (arr, p) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); if (!a.length) return null; const i = (a.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
const mean = (arr) => { const a = arr.filter((x) => x != null); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };

route('GET', '/api/metrics', async (req, res, { user }) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const days = Number(q.get('days') || 30);
  const since = days > 0 ? now() - days * 86400_000 : 0;
  const tz = Number(q.get('tz') || 0); // client offset in minutes (Date#getTimezoneOffset)
  const convFilter = q.get('conversation') ? ' AND c.id=?' : '';
  const args = [user.id, since, ...(q.get('conversation') ? [q.get('conversation')] : [])];
  const R = db.prepare(`SELECT r.id, r.model_id, r.status, r.error_kind, r.latency_ms, r.first_token_ms, r.prompt_tokens, r.completion_tokens, r.cost, r.attempts,
      r.auto_switched, r.stands_in_for, r.key_source, r.turn_id, r.created_at, r.conversation_id, r.rating
    FROM responses r JOIN conversations c ON c.id=r.conversation_id
    WHERE c.user_id=? AND r.created_at>=? AND r.status NOT IN ('pending','generating')${convFilter}`).all(...args);
  const T = db.prepare(`SELECT t.id, t.mode, t.target_models, t.conversation_id, t.created_at,
      (SELECT COUNT(*) FROM attachments a WHERE a.turn_id=t.id) AS files
    FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE c.user_id=? AND t.created_at>=?${convFilter}`).all(...args);
  const picks = new Set(db.prepare(`SELECT p.winning_response FROM preference_events p JOIN conversations c ON c.id=p.conversation_id
    WHERE p.user_id=? AND p.created_at>=? AND p.event_type IN ('use_as_context','continue','final','save')${convFilter.replace('c.id', 'p.conversation_id')}`).all(...args).map((x) => x.winning_response));
  const E = db.prepare(`SELECT e.* FROM evaluations e JOIN conversations c ON c.id=e.conversation_id WHERE e.user_id=? AND e.created_at>=?${convFilter}`).all(...args);
  const ES = E.length ? db.prepare(`SELECT * FROM evaluation_scores WHERE evaluation_id IN (${E.map(() => '?').join(',')})`).all(...E.map((e) => e.id)) : [];

  const completed = R.filter((r) => r.status === 'completed');
  const throughput = (rows) => mean(rows.filter((r) => r.completion_tokens && r.latency_ms && r.first_token_ms != null && r.latency_ms > r.first_token_ms)
    .map((r) => r.completion_tokens / ((r.latency_ms - r.first_token_ms) / 1000)));
  // "Comparable": answer shown next to >= 1 other completed answer in the same message.
  const completedPerTurn = new Map(); for (const r of completed) completedPerTurn.set(r.turn_id, (completedPerTurn.get(r.turn_id) || 0) + 1);
  // Evaluator vs human agreement, on evaluations where the user also picked something.
  let agree = 0, judged = 0;
  for (const e of E) {
    const cands = JSON.parse(e.candidates);
    const human = cands.filter((id) => picks.has(id));
    if (!human.length || !e.recommended_response) continue;
    judged++; if (human.includes(e.recommended_response)) agree++;
  }
  const summary = {
    conversations: new Set(T.map((t) => t.conversation_id)).size,
    messages: T.length,
    model_calls: R.reduce((n, r) => n + (r.attempts || 0), 0),
    answers: R.length, completed: completed.length,
    failed: R.filter((r) => r.status === 'failed').length,
    rate_limited: R.filter((r) => r.status === 'rate_limited').length,
    stopped: R.filter((r) => r.status === 'stopped').length,
    tokens_in: R.reduce((n, r) => n + (r.prompt_tokens || 0), 0),
    tokens_out: R.reduce((n, r) => n + (r.completion_tokens || 0), 0),
    cost: R.reduce((n, r) => n + (r.cost || 0), 0),
    latency_p50: pctl(completed.map((r) => r.latency_ms), 0.5), latency_p95: pctl(completed.map((r) => r.latency_ms), 0.95),
    ttft_p50: pctl(completed.map((r) => r.first_token_ms), 0.5), ttft_p95: pctl(completed.map((r) => r.first_token_ms), 0.95),
    throughput: throughput(completed),
    auto_switches: R.filter((r) => r.auto_switched).length,
    multi_model_share: T.length ? T.filter((t) => JSON.parse(t.target_models).length > 1).length / T.length : null,
    avg_models_per_message: mean(T.map((t) => JSON.parse(t.target_models).length)),
    messages_with_files: T.filter((t) => t.files > 0).length,
    picks: [...picks].length,
    thumbs_up: R.filter((r) => r.rating === 1).length, thumbs_down: R.filter((r) => r.rating === -1).length,
    evaluations: E.length, evaluator_agreement: judged ? agree / judged : null, evaluator_agreement_n: judged,
    personal_key_share: R.length ? R.filter((r) => r.key_source === 'personal').length / R.length : null,
  };
  // Daily buckets in the viewer's timezone.
  const dayKey = (ms) => new Date(ms - tz * 60_000).toISOString().slice(0, 10);
  const daily = new Map();
  if (since) for (let d = 0; d < days; d++) daily.set(dayKey(now() - (days - 1 - d) * 86400_000), { day: dayKey(now() - (days - 1 - d) * 86400_000), answers: 0, tokens_in: 0, tokens_out: 0, cost: 0, failures: 0 });
  for (const r of R) {
    const k = dayKey(r.created_at);
    if (!daily.has(k)) daily.set(k, { day: k, answers: 0, tokens_in: 0, tokens_out: 0, cost: 0, failures: 0 });
    const d = daily.get(k); d.answers++; d.tokens_in += r.prompt_tokens || 0; d.tokens_out += r.completion_tokens || 0; d.cost += r.cost || 0;
    if (r.status === 'failed' || r.status === 'rate_limited') d.failures++;
  }
  const catalog = await getCatalog().catch(() => []);
  const byModel = new Map(); for (const r of R) { if (!byModel.has(r.model_id)) byModel.set(r.model_id, []); byModel.get(r.model_id).push(r); }
  const per_model = [...byModel].map(([id, rows]) => {
    const ok = rows.filter((r) => r.status === 'completed');
    const shown = ok.filter((r) => completedPerTurn.get(r.turn_id) >= 2);
    const evs = ES.filter((x) => x.model_id === id && x.criterion === 'overall');
    const evIds = new Set(evs.map((x) => x.evaluation_id));
    return {
      model_id: id, name: catalog.find((m) => m.id === id)?.name || id,
      answers: rows.length, completed: ok.length,
      failure_rate: rows.length ? rows.filter((r) => r.status === 'failed').length / rows.length : null,
      rate_limit_rate: rows.length ? rows.filter((r) => r.status === 'rate_limited').length / rows.length : null,
      tokens_in: rows.reduce((n, r) => n + (r.prompt_tokens || 0), 0), tokens_out: rows.reduce((n, r) => n + (r.completion_tokens || 0), 0),
      avg_out_tokens: mean(ok.map((r) => r.completion_tokens)),
      latency_p50: pctl(ok.map((r) => r.latency_ms), 0.5), latency_p95: pctl(ok.map((r) => r.latency_ms), 0.95),
      ttft_p50: pctl(ok.map((r) => r.first_token_ms), 0.5), throughput: throughput(ok),
      cost: rows.reduce((n, r) => n + (r.cost || 0), 0),
      shown_in_comparisons: shown.length, chosen: shown.filter((r) => picks.has(r.id)).length,
      pick_rate: shown.length ? shown.filter((r) => picks.has(r.id)).length / shown.length : null,
      eval_overall: mean(evs.map((x) => x.score)), evaluated: evs.length,
      eval_wins: E.filter((e) => evIds.has(e.id) && db.prepare('SELECT model_id FROM responses WHERE id=?').get(e.recommended_response)?.model_id === id).length,
      stand_in_for_others: rows.filter((r) => r.stands_in_for && r.auto_switched).length,
      thumbs_up: rows.filter((r) => r.rating === 1).length, thumbs_down: rows.filter((r) => r.rating === -1).length,
    };
  }).sort((a, b) => b.answers - a.answers);
  const crit = [...new Set(ES.map((x) => x.criterion).filter((c) => c !== 'overall'))];
  const eval_matrix = { criteria: crit.map((k) => ({ key: k, label: CRITERIA[k]?.label || k })),
    rows: [...new Set(ES.map((x) => x.model_id))].map((m) => ({ model_id: m, name: catalog.find((x) => x.id === m)?.name || m,
      values: Object.fromEntries(crit.map((k) => [k, mean(ES.filter((x) => x.model_id === m && x.criterion === k).map((x) => x.score))])), n: new Set(ES.filter((x) => x.model_id === m).map((x) => x.evaluation_id)).size })) };
  const errors = Object.entries(R.filter((r) => r.error_kind && r.status !== 'completed').reduce((m, r) => ((m[r.error_kind] = (m[r.error_kind] || 0) + 1), m), {})).map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n);
  send(res, 200, { days, summary, daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)), per_model, eval_matrix, errors,
    evaluator: jevKeyFor(user) ? 'jev' : 'llm-judge' });
});

// ---------- price-watch agent ----------
// Checks per day: 24, 12, 8, 6, 5, 4, 3, 2, 1 (5 a day = every 288 minutes).
// Manual 'check now' cooldown; the health check's throwaway instance sets it to 0.
const COOLDOWN_MS = Number(process.env.CHECK_NOW_COOLDOWN_MS ?? 120_000);
const WATCH_INTERVALS = [60, 120, 180, 240, 288, 360, 480, 720, 1440];
const MAX_WATCHES = 25;
const watchFetchOpts = () => ({ allowPrivate: process.env.WATCH_ALLOW_PRIVATE === '1' }); // tests only
const lastHit = new Map(); // hostname -> last fetch time (politeness)
const checking = new Set();

// Fetch-layer failures (timeouts, blocked addresses, DNS) are user-facing messages, not server errors.
async function inspectUrl(user, url) {
  try { return await inspectUrlInner(user, url); }
  catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e.message); }
}
async function inspectUrlInner(user, url) {
  const opts = watchFetchOpts();
  if (!(await checkRobots(url, opts))) throw new HttpError(400, "This site's robots.txt does not allow automated checks of that page, so it can't be watched.");
  lastHit.set(new URL(url).hostname, now());
  const page = await safeFetch(url, opts);
  if ([401, 403, 429, 503].includes(page.status)) throw new HttpError(400, `The site blocked the automated check (HTTP ${page.status}). Some stores don't allow price tracking.`);
  if (page.status >= 400) throw new HttpError(400, `The page returned HTTP ${page.status}. Check the link.`);
  if (!/html|xml/i.test(page.contentType)) throw new HttpError(400, 'That link is not a web page.');
  let x = extractStructured(page.body);
  if (x.price == null) {
    const ai = await extractWithAI({ apiKey: keyFor(user).key, models: (await backgroundModels()).map((m) => m.id), html: page.body, url: page.url });
    x = { ...x, ...ai, title: ai.title || x.title };
    if (x.price == null) {
      const suggestions = buyLinks(page.body, page.url);
      throw new HttpError(400, suggestions.length
        ? 'This looks like an overview page without a single product price. Try the store page instead.'
        : (ai.error || 'Could not find a product price on that page.'), { suggestions });
    }
  }
  return { ...x, final_url: page.url };
}

function notify(userId, n) {
  const id = uid();
  db.prepare('INSERT INTO notifications (id, user_id, kind, title, body, url, watch_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, userId, n.kind, n.title, n.body || null, n.url || null, n.watch_id || null, now());
  return id;
}

const fmtMoney = (p, c) => (p == null ? '?' : `${c ? `${c} ` : ''}${Number(p).toFixed(2)}`);

async function checkWatch(w) {
  if (checking.has(w.id)) return;
  const user = userById(w.user_id);
  if (!user) { db.prepare(`UPDATE watches SET status='paused' WHERE id=?`).run(w.id); return { ok: false, error: 'Owner no longer exists' }; }
  checking.add(w.id);
  const t = now();
  try {
    const x = await inspectUrl(user, w.url);
    db.prepare('INSERT INTO watch_checks (id, watch_id, checked_at, price, currency, in_stock, ok, method, model) VALUES (?,?,?,?,?,?,1,?,?)')
      .run(uid(), w.id, t, x.price, x.currency || w.currency, x.in_stock == null ? null : x.in_stock ? 1 : 0, x.method, x.model || null);
    const cur = x.currency || w.currency;
    const msg = conditionMet(w, x.price, (p) => fmtMoney(p, cur));
    const jitter = Math.floor(Math.random() * 5 * 60_000);
    db.prepare(`UPDATE watches SET last_price=?, lowest_price=MIN(COALESCE(lowest_price, ?), ?), currency=COALESCE(?, currency), in_stock=?, method=?, title=COALESCE(title, ?),
      failures=0, last_error=NULL, status=CASE WHEN status='error' THEN 'active' ELSE status END, last_checked_at=?, next_check_at=?${msg ? ', last_notified_price=?' : ''} WHERE id=?`)
      .run(x.price, x.price, x.price, x.currency || null, x.in_stock == null ? null : x.in_stock ? 1 : 0, x.method, x.title || null, t, t + w.interval_minutes * 60_000 + jitter, ...(msg ? [x.price] : []), w.id);
    if (msg) notify(w.user_id, { kind: 'price_drop', title: `Price drop: ${w.title || new URL(w.url).hostname}`, body: `${w.title || 'The item'} ${msg}.`, url: w.url, watch_id: w.id });
    return { ok: true, price: x.price, alerted: !!msg };
  } catch (e) {
    const failures = w.failures + 1;
    // Back off: 2x the interval per consecutive failure, at most a day. Stop after 8 failures in a row.
    const next = t + Math.min(24 * 60, w.interval_minutes * 2 ** failures) * 60_000;
    db.prepare('INSERT INTO watch_checks (id, watch_id, checked_at, ok, error) VALUES (?,?,?,0,?)').run(uid(), w.id, t, e.message);
    db.prepare(`UPDATE watches SET failures=?, last_error=?, last_checked_at=?, next_check_at=?, status=? WHERE id=?`)
      .run(failures, e.message, t, next, failures >= 8 ? 'error' : w.status, w.id);
    if (failures === 3) notify(w.user_id, { kind: 'watch_error', title: `Can't check ${w.title || new URL(w.url).hostname}`, body: `The last 3 checks failed: ${e.message}`, url: w.url, watch_id: w.id });
    return { ok: false, error: e.message };
  } finally { checking.delete(w.id); }
}

// Scheduler: due watches, one at a time, at least 10s apart per site.
setInterval(async () => {
  const due = db.prepare(`SELECT * FROM watches WHERE status='active' AND next_check_at <= ? ORDER BY next_check_at LIMIT 10`).all(now());
  for (const w of due) {
    const host = new URL(w.url).hostname;
    if (now() - (lastHit.get(host) || 0) < 10_000) continue; // picked up on a later tick
    await checkWatch(w).catch((e) => console.warn('[watch]', e.message));
  }
}, 60_000).unref();

const watchPayload = (w) => ({ ...w,
  read_by: db.prepare('SELECT method, model FROM watch_checks WHERE watch_id=? AND ok=1 ORDER BY checked_at DESC LIMIT 1').get(w.id) || null,
  history: db.prepare('SELECT checked_at, price, ok, error FROM watch_checks WHERE watch_id=? ORDER BY checked_at DESC LIMIT 60').all(w.id).reverse() });
const ownWatch = (user, id) => { const w = db.prepare('SELECT * FROM watches WHERE id=? AND user_id=?').get(id, user.id); if (!w) throw new HttpError(404, 'Watch not found'); return w; };
function watchSettings(body, base = {}) {
  const out = {};
  const condition = body.condition ?? base.condition;
  if (!['below', 'drop_pct', 'any_drop'].includes(condition)) throw new HttpError(400, 'Choose when to alert you: below a price, a percentage drop, or any drop.');
  out.condition = condition;
  out.target_price = condition === 'below' ? Number(body.target_price ?? base.target_price) : null;
  if (condition === 'below' && !(out.target_price > 0)) throw new HttpError(400, 'Enter the target price.');
  out.drop_pct = condition === 'drop_pct' ? Number(body.drop_pct ?? base.drop_pct) : null;
  if (condition === 'drop_pct' && !(out.drop_pct > 0 && out.drop_pct < 100)) throw new HttpError(400, 'Enter a drop between 1 and 99 percent.');
  out.interval_minutes = Number(body.interval_minutes ?? base.interval_minutes ?? 288);
  if (!WATCH_INTERVALS.includes(out.interval_minutes)) throw new HttpError(400, 'Choose how often to check.');
  return out;
}

route('POST', '/api/watches/preview', async (req, res, { user }) => {
  const { url } = await readJson(req);
  send(res, 200, await inspectUrl(user, String(url || '').trim()));
});

route('GET', '/api/watches', async (req, res, { user }) => {
  send(res, 200, db.prepare('SELECT * FROM watches WHERE user_id=? ORDER BY created_at DESC').all(user.id).map(watchPayload));
});

route('POST', '/api/watches', async (req, res, { user }) => {
  const body = await readJson(req);
  const url = String(body.url || '').trim();
  if (db.prepare(`SELECT COUNT(*) n FROM watches WHERE user_id=? AND status<>'paused'`).get(user.id).n >= MAX_WATCHES) throw new HttpError(400, `You can watch up to ${MAX_WATCHES} links at once. Pause or delete one first.`);
  const cfg = watchSettings(body);
  const x = await inspectUrl(user, url);
  const id = uid(), t = now();
  const met = conditionMet({ ...cfg, baseline_price: x.price, last_price: null, last_notified_price: null }, x.price);
  db.prepare(`INSERT INTO watches (id, user_id, url, title, condition, target_price, drop_pct, currency, baseline_price, last_price, lowest_price, last_notified_price, in_stock, method,
      interval_minutes, last_checked_at, next_check_at, conversation_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, user.id, x.final_url || url, x.title || null, cfg.condition, cfg.target_price, cfg.drop_pct, x.currency || null, x.price, x.price, x.price,
      met ? x.price : null, x.in_stock == null ? null : x.in_stock ? 1 : 0, x.method, cfg.interval_minutes, t, t + cfg.interval_minutes * 60_000, body.conversation_id || null, t);
  db.prepare('INSERT INTO watch_checks (id, watch_id, checked_at, price, currency, in_stock, ok, method, model) VALUES (?,?,?,?,?,?,1,?,?)')
    .run(uid(), id, t, x.price, x.currency || null, x.in_stock == null ? null : x.in_stock ? 1 : 0, x.method, x.model || null);
  send(res, 201, { ...watchPayload(db.prepare('SELECT * FROM watches WHERE id=?').get(id)), already_met: !!met });
});

route('PATCH', '/api/watches/:id', async (req, res, { user, params }) => {
  const w = ownWatch(user, params.id);
  const body = await readJson(req);
  if (body.status) {
    if (!['active', 'paused'].includes(body.status)) throw new HttpError(400, 'status must be active or paused');
    db.prepare('UPDATE watches SET status=?, failures=0, next_check_at=? WHERE id=?').run(body.status, body.status === 'active' ? now() + 60_000 : w.next_check_at, w.id);
  }
  if (body.condition || body.target_price != null || body.drop_pct != null || body.interval_minutes) {
    const cfg = watchSettings(body, w);
    // New target: allow a fresh alert.
    db.prepare('UPDATE watches SET condition=?, target_price=?, drop_pct=?, interval_minutes=?, last_notified_price=NULL WHERE id=?').run(cfg.condition, cfg.target_price, cfg.drop_pct, cfg.interval_minutes, w.id);
  }
  send(res, 200, watchPayload(db.prepare('SELECT * FROM watches WHERE id=?').get(w.id)));
});

route('DELETE', '/api/watches/:id', async (req, res, { user, params }) => {
  const w = ownWatch(user, params.id);
  db.prepare('DELETE FROM watches WHERE id=?').run(w.id);
  send(res, 200, { ok: true });
});

route('POST', '/api/watches/:id/check', async (req, res, { user, params }) => {
  const w = ownWatch(user, params.id);
  if (w.last_checked_at && now() - w.last_checked_at < COOLDOWN_MS) throw new HttpError(429, 'Checked less than 2 minutes ago. Try again shortly.');
  const r = await checkWatch(w);
  send(res, 200, { ...r, watch: watchPayload(db.prepare('SELECT * FROM watches WHERE id=?').get(w.id)) });
});

route('GET', '/api/notifications', async (req, res, { user }) => {
  send(res, 200, { unread: db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0').get(user.id).n,
    items: db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(user.id) });
});

route('POST', '/api/notifications/read', async (req, res, { user }) => {
  const { ids } = await readJson(req);
  if (Array.isArray(ids) && ids.length) for (const id of ids) db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(String(id), user.id);
  else db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(user.id);
  send(res, 200, { ok: true });
});

// ---------- tracker agents: jobs, news, page (price watches live above) ----------
const MON_INTERVALS = [60, 120, 180, 240, 288, 360, 480, 720, 1440];
const nearestInterval = (v, list = MON_INTERVALS) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
const MAX_MONITORS = 20;
const monitorsRunning = new Set();
const jevCfg = (user) => { const k = jevKeyFor(user); return k ? { key: k.key, base: JEV_BASE } : null; };

function normalizeMonitor(body, base = {}) {
  const kind = body.kind ?? base.kind;
  if (!['jobs', 'news', 'page'].includes(kind)) throw new HttpError(400, 'Tracker type must be jobs, news or page');
  const out = { kind, name: String(body.name ?? base.name ?? '').trim().slice(0, 80) };
  for (const k of ['query', 'location', 'exclude', 'criteria']) out[k] = String(body[k] ?? base[k] ?? '').trim().slice(0, 500) || null;
  if (kind !== 'page' && !monTerms(out.query).length) throw new HttpError(400, 'Say what to look for, for example "AI Product Manager, AI PM".');
  out.url = kind === 'page' ? String(body.url ?? base.url ?? '').trim() : null;
  if (kind === 'page' && !/^https?:\/\//i.test(out.url || '')) throw new HttpError(400, 'Add the link of the page to watch.');
  const defaults = kind === 'jobs' ? ['companies', 'hn_hiring', 'remotive', 'remoteok', 'arbeitnow'] : kind === 'news' ? ['google_news', 'hn'] : [];
  const src = Array.isArray(body.sources) ? body.sources : base.sources ? JSON.parse(base.sources) : defaults;
  out.sources = JSON.stringify(src.filter((x) => SOURCES[x]?.kind === kind));
  const comp = Array.isArray(body.companies) ? body.companies : base.companies ? JSON.parse(base.companies) : (kind === 'jobs' ? COMPANY_PRESETS : []);
  out.companies = JSON.stringify(comp.map(String).filter((c) => /^(greenhouse|ashby|lever):[a-z0-9-]+$/i.test(c)).slice(0, 30));
  out.interval_minutes = nearestInterval(Number(body.interval_minutes ?? base.interval_minutes ?? (kind === 'news' ? 360 : 720)));
  if (!out.name) out.name = kind === 'page' ? `Watch ${(() => { try { return new URL(out.url).hostname; } catch { return 'page'; } })()}` : monTerms(out.query)[0];
  return out;
}

/** One run: collect -> keyword filter -> drop already seen -> AI screening (+feedback) -> store -> alert. */
async function runMonitor(m, { preview = false } = {}) {
  const user = userById(m.user_id) || m._user;
  if (!user) return { ok: false, error: 'Owner missing' };
  const apiKey = keyFor(user).key;
  const models = (await backgroundModels()).map((x) => x.id);
  if (m.kind === 'page') {
    if (!(await checkRobots(m.url, watchFetchOpts()))) throw new HttpError(400, "This site's robots.txt does not allow automated checks of that page.");
    const page = await safeFetch(m.url, watchFetchOpts());
    if (page.status >= 400) throw new HttpError(400, `The page returned HTTP ${page.status}.`);
    const { text, hash } = pageDigest(page.body);
    const state = JSON.parse(m.state || '{}');
    let event = null, verdict = null;
    if (m.criteria) {
      verdict = await judgePage({ text, criteria: m.criteria, url: m.url, jev: jevCfg(user), apiKey, models });
      if (verdict.met && !state.met) event = { title: `Condition met: ${m.criteria}`, snippet: verdict.evidence || 'The condition is now true on the page.' };
      state.met = verdict.met;
    } else if (state.hash && state.hash !== hash) event = { title: 'The page changed', snippet: text.slice(0, 300) };
    state.hash = hash;
    if (preview) return { ok: true, preview: true, verdict, text_sample: text.slice(0, 400), event };
    db.prepare('UPDATE monitors SET state=? WHERE id=?').run(JSON.stringify(state), m.id);
    if (event) {
      db.prepare(`INSERT OR IGNORE INTO monitor_items (id, monitor_id, dedupe_key, source, url, title, snippet, found_at, score, relevant) VALUES (?,?,?,?,?,?,?,?,?,1)`)
        .run(uid(), m.id, `${hash}:${now()}`, 'page', m.url, event.title, event.snippet, now(), verdict?.confidence ?? 1);
      notify(m.user_id, { kind: 'monitor', title: `${m.name}: ${event.title}`, body: event.snippet, url: `#/agents?m=${m.id}`, watch_id: m.id });
    }
    return { ok: true, met: verdict?.met ?? null, changed: !!event };
  }
  const { items, errors, scanned } = await collect(m);
  let candidates = prefilter(m, items);
  if (!preview) {
    const seen = new Set(db.prepare('SELECT dedupe_key FROM monitor_items WHERE monitor_id=?').all(m.id).map((r) => r.dedupe_key));
    candidates = candidates.filter((it) => !seen.has(dedupeKey(it)));
  }
  candidates.sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
  candidates = candidates.slice(0, preview ? 25 : 40);
  const feedback = preview ? [] : db.prepare('SELECT title, feedback FROM monitor_items WHERE monitor_id=? AND feedback IS NOT NULL ORDER BY feedback_at DESC LIMIT 16').all(m.id);
  const scores = await scoreRelevance({ m, items: candidates, jev: jevCfg(user), apiKey, models, feedback });
  const scored = candidates.map((it, i) => ({ ...it, score: scores[i].score, reason: scores[i].reason, by: scores[i].by, relevant: scores[i].score != null && scores[i].score >= 0.5 }));
  const unscreened = scored.filter((x) => x.score == null).length;
  if (preview) return { ok: true, scanned, matched: candidates.length, errors, unscreened, items: scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) };
  if (unscreened) errors.push(`${unscreened} result${unscreened > 1 ? 's' : ''} could not be screened and will be retried next run`);
  const ins = db.prepare(`INSERT OR IGNORE INTO monitor_items (id, monitor_id, dedupe_key, source, url, title, snippet, company, location, published_at, found_at, score, reason, relevant)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const it of scored.filter((x) => x.score != null)) ins.run(uid(), m.id, dedupeKey(it), it.source, it.url, it.title, it.snippet, it.company, it.location, it.published_at, now(), it.score, it.reason, it.relevant ? 1 : 0);
  const fresh = scored.filter((x) => x.relevant).sort((a, b) => b.score - a.score);
  if (fresh.length) notify(m.user_id, { kind: 'monitor', title: `${fresh.length} new ${fresh.length === 1 ? 'match' : 'matches'}: ${m.name}`,
    body: fresh.slice(0, 3).map((x) => `${x.title}${x.company ? ` · ${x.company}` : ''}`).join('\n'), url: `#/agents?m=${m.id}`, watch_id: m.id });
  return { ok: true, scanned, matched: candidates.length, new_relevant: fresh.length, errors };
}

async function runMonitorScheduled(m) {
  if (monitorsRunning.has(m.id)) return;
  monitorsRunning.add(m.id);
  const t = now();
  try {
    const r = await runMonitor(m);
    db.prepare(`UPDATE monitors SET last_run_at=?, next_run_at=?, failures=0, last_error=? WHERE id=?`)
      .run(t, t + m.interval_minutes * 60_000 + Math.floor(Math.random() * 5 * 60_000), r.errors?.length ? `Some sources failed: ${r.errors.join('; ').slice(0, 300)}` : null, m.id);
    return r;
  } catch (e) {
    const failures = m.failures + 1;
    db.prepare('UPDATE monitors SET last_run_at=?, next_run_at=?, failures=?, last_error=?, status=? WHERE id=?')
      .run(t, t + Math.min(1440, m.interval_minutes * 2 ** failures) * 60_000, failures, e.message, failures >= 8 ? 'error' : m.status, m.id);
    return { ok: false, error: e.message };
  } finally { monitorsRunning.delete(m.id); }
}

setInterval(async () => {
  for (const m of db.prepare(`SELECT * FROM monitors WHERE status='active' AND next_run_at <= ? ORDER BY next_run_at LIMIT 3`).all(now())) {
    if (!userById(m.user_id)) { db.prepare(`UPDATE monitors SET status='paused' WHERE id=?`).run(m.id); continue; }
    await runMonitorScheduled(m).catch((e) => console.warn('[monitor]', e.message));
  }
}, 60_000).unref();

const ownMonitor = (user, id) => { const m = db.prepare('SELECT * FROM monitors WHERE id=? AND user_id=?').get(id, user.id); if (!m) throw new HttpError(404, 'Tracker not found'); return m; };
const monitorPayload = (m) => ({ ...m, sources: JSON.parse(m.sources), companies: JSON.parse(m.companies), state: undefined,
  counts: db.prepare('SELECT COUNT(*) total, SUM(relevant) relevant, SUM(feedback=1) liked, SUM(feedback=-1) disliked FROM monitor_items WHERE monitor_id=?').get(m.id),
  items: db.prepare('SELECT * FROM monitor_items WHERE monitor_id=? AND relevant=1 AND dismissed=0 ORDER BY found_at DESC, score DESC LIMIT 25').all(m.id) });

route('GET', '/api/agents/catalog', async (req, res) => {
  send(res, 200, { sources: Object.entries(SOURCES).map(([key, v]) => ({ key, ...v })), company_presets: COMPANY_PRESETS, intervals: MON_INTERVALS });
});

// Plain-English request -> a tracker config the user confirms before anything is created.
route('POST', '/api/agents/plan', async (req, res, { user }) => {
  const request = String((await readJson(req)).request || '').trim().slice(0, 1500);
  if (request.length < 8) throw new HttpError(400, 'Describe what you want to track.');
  let plan;
  try { plan = await planRequest({ request, apiKey: keyFor(user).key, models: (await backgroundModels()).map((m) => m.id) }); }
  catch (e) { throw new HttpError(502, e.message); }
  if (plan.type === 'price') {
    plan.interval_minutes = nearestInterval(Number(plan.interval_minutes || 288), WATCH_INTERVALS);
    plan.condition = ['below', 'drop_pct', 'any_drop'].includes(plan.condition) ? plan.condition : plan.target_price ? 'below' : 'any_drop';
  } else plan.interval_minutes = nearestInterval(Number(plan.interval_minutes || (plan.type === 'news' ? 360 : 720)));
  if (plan.type === 'jobs') plan.companies = plan.use_company_boards === false ? [] : COMPANY_PRESETS;
  plan.request = request;
  send(res, 200, plan);
});

route('GET', '/api/monitors', async (req, res, { user }) => {
  send(res, 200, db.prepare('SELECT * FROM monitors WHERE user_id=? ORDER BY created_at DESC').all(user.id).map(monitorPayload));
});

route('POST', '/api/monitors/preview', async (req, res, { user }) => {
  const cfg = normalizeMonitor(await readJson(req));
  send(res, 200, await runMonitor({ ...cfg, id: 'preview', user_id: user.id, _user: user, state: '{}', failures: 0 }, { preview: true }));
});

route('POST', '/api/monitors', async (req, res, { user }) => {
  const body = await readJson(req);
  if (db.prepare(`SELECT COUNT(*) n FROM monitors WHERE user_id=? AND status<>'paused'`).get(user.id).n >= MAX_MONITORS) throw new HttpError(400, `Up to ${MAX_MONITORS} active trackers. Pause or delete one first.`);
  const cfg = normalizeMonitor(body);
  const id = uid(), t = now();
  db.prepare(`INSERT INTO monitors (id, user_id, kind, name, request, query, location, exclude, criteria, url, sources, companies, interval_minutes, next_run_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, user.id, cfg.kind, cfg.name, body.request ? String(body.request).slice(0, 1500) : null, cfg.query, cfg.location, cfg.exclude, cfg.criteria, cfg.url,
    cfg.sources, cfg.companies, cfg.interval_minutes, t + cfg.interval_minutes * 60_000, t);
  const first = await runMonitorScheduled(db.prepare('SELECT * FROM monitors WHERE id=?').get(id)); // first run right away
  send(res, 201, { ...monitorPayload(db.prepare('SELECT * FROM monitors WHERE id=?').get(id)), first_run: first });
});

route('PATCH', '/api/monitors/:id', async (req, res, { user, params }) => {
  const m = ownMonitor(user, params.id);
  const body = await readJson(req);
  if (body.status) {
    if (!['active', 'paused'].includes(body.status)) throw new HttpError(400, 'status must be active or paused');
    db.prepare('UPDATE monitors SET status=?, failures=0, next_run_at=? WHERE id=?').run(body.status, body.status === 'active' ? now() + 60_000 : m.next_run_at, m.id);
  }
  const fields = ['name', 'query', 'location', 'exclude', 'criteria', 'url', 'sources', 'companies', 'interval_minutes'];
  if (fields.some((f) => body[f] !== undefined)) {
    const cfg = normalizeMonitor({ ...body, kind: m.kind }, m);
    db.prepare('UPDATE monitors SET name=?, query=?, location=?, exclude=?, criteria=?, url=?, sources=?, companies=?, interval_minutes=? WHERE id=?')
      .run(cfg.name, cfg.query, cfg.location, cfg.exclude, cfg.criteria, cfg.url, cfg.sources, cfg.companies, cfg.interval_minutes, m.id);
  }
  send(res, 200, monitorPayload(db.prepare('SELECT * FROM monitors WHERE id=?').get(m.id)));
});

route('DELETE', '/api/monitors/:id', async (req, res, { user, params }) => {
  db.prepare('DELETE FROM monitors WHERE id=?').run(ownMonitor(user, params.id).id);
  send(res, 200, { ok: true });
});

route('POST', '/api/monitors/:id/run', async (req, res, { user, params }) => {
  const m = ownMonitor(user, params.id);
  if (m.last_run_at && now() - m.last_run_at < COOLDOWN_MS) throw new HttpError(429, 'Ran less than 2 minutes ago. Try again shortly.');
  const r = await runMonitorScheduled(m);
  send(res, 200, { ...r, monitor: monitorPayload(db.prepare('SELECT * FROM monitors WHERE id=?').get(m.id)) });
});

// User feedback on a result: 1 useful, -1 not relevant, 0 clears. It steers future screening and feeds the eval set.
route('POST', '/api/monitor-items/:id/feedback', async (req, res, { user, params }) => {
  const it = db.prepare(`SELECT i.* FROM monitor_items i JOIN monitors m ON m.id=i.monitor_id WHERE i.id=? AND m.user_id=?`).get(params.id, user.id);
  if (!it) throw new HttpError(404, 'Result not found');
  const v = Number((await readJson(req)).value);
  if (![1, -1, 0].includes(v)) throw new HttpError(400, 'value must be 1, -1 or 0');
  db.prepare('UPDATE monitor_items SET feedback=?, feedback_at=?, dismissed=? WHERE id=?').run(v || null, v ? now() : null, v === -1 ? 1 : 0, it.id);
  send(res, 200, { ok: true });
});

// ---------- AI evaluation suite (evals/run.js) ----------
const EVAL_DIR = path.join(path.dirname(DB_FILE), 'evals');
let evalRun = null; // { started_at, log: [] }
let lastEvalStart = 0;
function evalSummary(file) {
  try {
    const r = JSON.parse(readFileSync(path.join(EVAL_DIR, file), 'utf8'));
    return { file, run_at: r.run_at, passed: r.passed, runs: r.runs.map((x) => ({ label: x.label, passed: x.passed,
      gates: Object.fromEntries(Object.entries(x.suites).map(([k, v]) => [k, v.gate])) })) };
  } catch { return null; }
}
route('GET', '/api/evals', async (req, res) => {
  const latest = existsSync(path.join(EVAL_DIR, 'latest.json')) ? JSON.parse(readFileSync(path.join(EVAL_DIR, 'latest.json'), 'utf8')) : null;
  const history = existsSync(EVAL_DIR) ? readdirSync(EVAL_DIR).filter((f) => /^run-\d+\.json$/.test(f)).sort().reverse().slice(0, 10).map(evalSummary).filter(Boolean) : [];
  send(res, 200, { latest, history, running: evalRun ? { started_at: evalRun.started_at, log: evalRun.log.slice(-12) } : null,
    feedback_cases: db.prepare('SELECT COUNT(*) n FROM monitor_items WHERE feedback IS NOT NULL').get().n });
});
route('POST', '/api/evals/run', async (req, res) => {
  if (evalRun) throw new HttpError(409, 'An evaluation run is already in progress.');
  if (now() - lastEvalStart < 10 * 60_000) throw new HttpError(429, 'The suite ran less than 10 minutes ago. Try again later.');
  lastEvalStart = now();
  evalRun = { started_at: now(), log: [] };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'evals', 'run.js'), '--db', DB_FILE, '--out', EVAL_DIR], { cwd: ROOT, env: process.env });
  const onData = (d) => evalRun?.log.push(...String(d).split('\n').filter(Boolean));
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.on('close', () => { evalRun = null; });
  send(res, 202, { ok: true });
});

// ---------- user feedback ----------
const APP_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
route('POST', '/api/feedback', async (req, res, { user }) => {
  const b = await readJson(req);
  const kind = ['bug', 'idea', 'question', 'praise'].includes(b.kind) ? b.kind : 'idea';
  const message = String(b.message || '').trim().slice(0, 5000);
  if (message.length < 3) throw new HttpError(400, 'Tell us a little more.');
  const shot = typeof b.screenshot === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(b.screenshot) ? b.screenshot : null;
  if (shot && shot.length > 3_500_000) throw new HttpError(413, 'The screenshot is too large (max about 2.5 MB).');
  const ctx = { ...(b.context && typeof b.context === 'object' ? b.context : {}), app_version: APP_VERSION };
  const id = uid();
  db.prepare('INSERT INTO feedback (id, user_id, kind, message, route, context, screenshot, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, user.id, kind, message, String(b.route || '').slice(0, 200), JSON.stringify(ctx).slice(0, 20000), shot, now());
  send(res, 201, { id });
});
// Note: this workspace is single-tenant, so a user sees the feedback they sent. A team version would add an admin role.
route('GET', '/api/feedback', async (req, res, { user }) => {
  send(res, 200, db.prepare('SELECT id, kind, message, route, context, status, created_at, (screenshot IS NOT NULL) AS has_screenshot FROM feedback WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(user.id)
    .map((f) => ({ ...f, context: JSON.parse(f.context || '{}') })));
});
route('GET', '/api/feedback/:id/screenshot', async (req, res, { user, params }) => {
  const f = db.prepare('SELECT screenshot FROM feedback WHERE id=? AND user_id=?').get(params.id, user.id);
  if (!f?.screenshot) throw new HttpError(404, 'No screenshot');
  const [, mime, b64] = f.screenshot.match(/^data:([^;]+);base64,(.*)$/);
  res.writeHead(200, { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' }); res.end(Buffer.from(b64, 'base64'));
});
route('PATCH', '/api/feedback/:id', async (req, res, { user, params }) => {
  const st = (await readJson(req)).status;
  if (!['new', 'triaged', 'done'].includes(st)) throw new HttpError(400, 'status must be new, triaged or done');
  db.prepare('UPDATE feedback SET status=? WHERE id=? AND user_id=?').run(st, params.id, user.id);
  send(res, 200, { ok: true });
});

// 👍/👎 on an answer: a quality signal separate from "picking" an answer.
route('POST', '/api/responses/:id/rate', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  const v = Number((await readJson(req)).value);
  if (![1, -1, 0].includes(v)) throw new HttpError(400, 'value must be 1, -1 or 0');
  db.prepare('UPDATE responses SET rating=? WHERE id=?').run(v || null, r.id);
  if (v) {
    db.prepare(`INSERT INTO preference_events (id, user_id, conversation_id, turn_id, event_type, winning_response, winning_model, compared_responses, compared_models, display_position, created_at)
      VALUES (?,?,?,?,?,?,?,'[]','[]',?,?)`).run(uid(), user.id, r.conversation_id, r.turn_id, v > 0 ? 'thumbs_up' : 'thumbs_down', r.id, r.model_id, r.display_position, now());
    if (lf.enabled()) { const cur = db.prepare('SELECT trace_span_id FROM responses WHERE id=?').get(r.id); lf.score({ name: 'user_rating', value: v, traceId: lf.traceIdFor(r.turn_id), observationId: cur?.trace_span_id || undefined }); }
  }
  send(res, 200, getResponseRow(r.id));
});

// ---------- app health check (scripts/check.js) ----------
const CHECK_DIR = path.join(path.dirname(DB_FILE), 'checks');
let checkRun = null; let lastCheckStart = 0;
route('GET', '/api/checks', async (req, res) => {
  const latest = existsSync(path.join(CHECK_DIR, 'latest.json')) ? JSON.parse(readFileSync(path.join(CHECK_DIR, 'latest.json'), 'utf8')) : null;
  send(res, 200, { latest, running: checkRun ? { started_at: checkRun.started_at, log: checkRun.log.slice(-25) } : null });
});
route('POST', '/api/checks/run', async (req, res) => {
  if (checkRun) throw new HttpError(409, 'A health check is already running.');
  if (now() - lastCheckStart < 5 * 60_000) throw new HttpError(429, 'The check ran less than 5 minutes ago. Try again shortly.');
  lastCheckStart = now(); checkRun = { started_at: now(), log: [] };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts', 'check.js'), '--out', CHECK_DIR], { cwd: ROOT, env: process.env });
  const onData = (d) => checkRun?.log.push(...String(d).split('\n').filter(Boolean));
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.on('close', () => { checkRun = null; });
  send(res, 202, { ok: true });
});

route('GET', '/api/conversations', async (req, res, { user }) => {
  const q = new URL(req.url, 'http://x').searchParams.get('q')?.trim();
  if (!q) {
    return send(res, 200, db.prepare(`SELECT c.id, c.title, c.created_at, c.updated_at,
      (SELECT COUNT(*) FROM turns t WHERE t.conversation_id=c.id) AS turns
      FROM conversations c WHERE c.user_id=? ORDER BY c.updated_at DESC`).all(user.id));
  }
  // Search titles, your messages and answers. LIKE wildcards in the query are escaped.
  const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  send(res, 200, db.prepare(`SELECT c.id, c.title, c.created_at, c.updated_at,
      (SELECT COUNT(*) FROM turns t WHERE t.conversation_id=c.id) AS turns,
      (SELECT t.user_message FROM turns t WHERE t.conversation_id=c.id AND t.user_message LIKE ? ESCAPE '\\' LIMIT 1) AS hit_message,
      (SELECT substr(r.content, 1, 400) FROM responses r WHERE r.conversation_id=c.id AND r.content LIKE ? ESCAPE '\\' LIMIT 1) AS hit_answer
    FROM conversations c WHERE c.user_id=? AND (c.title LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id=c.id AND t.user_message LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM responses r WHERE r.conversation_id=c.id AND r.content LIKE ? ESCAPE '\\'))
    ORDER BY c.updated_at DESC LIMIT 50`).all(like, like, user.id, like, like, like));
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
  const prefs = prefsOf(user); prefs.last_models = ids;
  db.prepare('UPDATE users SET preferences=? WHERE id=?').run(JSON.stringify(prefs), user.id);
  send(res, 201, conversationPayload(ownConversation(user, id)));
});

route('GET', '/api/conversations/:id', async (req, res, { user, params }) => send(res, 200, conversationPayload(ownConversation(user, params.id))));

route('PATCH', '/api/conversations/:id', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  const { title } = await readJson(req);
  if (title?.trim()) db.prepare(`UPDATE conversations SET title=?, title_source='user' WHERE id=?`).run(title.trim().slice(0, 120), c.id);
  send(res, 200, conversationPayload(ownConversation(user, c.id)));
});

route('DELETE', '/api/conversations/:id', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  for (const r of db.prepare('SELECT id FROM responses WHERE conversation_id=?').all(c.id)) running.get(r.id)?.ctl.abort('user');
  await removeFiles(db.prepare('SELECT path FROM attachments WHERE conversation_id=?').all(c.id));
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
  const { message = '', target, reply_to, attachment_ids = [] } = await readJson(req);
  const { targets } = resolveTargets(c.id, target);
  const draftAttachments = ownUnsentAttachments(user, attachment_ids);
  const ref = replyRef(c.id, reply_to);
  const draft = { conversation_id: c.id, created_at: now() + 1, user_message: String(message), reply_to_response: ref.id, reply_quote: ref.quote };
  const pins = pinsFor(c.id, null);
  const skills = skillsFor(c.id);
  const out = [];
  for (const t of targets) {
    const model = await getModel(t.model_id);
    const maxOut = maxOutFor(user, model);
    const { promptTokensEst, droppedTurns } = buildContext(db, draft, t.model_id, model, maxOut, pins, skills, { summary: summaryOf(c.id), draftAttachments });
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
  const { message, target, reply_to, attachment_ids = [] } = await readJson(req);
  const atts = ownUnsentAttachments(user, attachment_ids);
  const text = String(message || '').trim() || (atts.length ? `Please look at the attached file${atts.length > 1 ? 's' : ''}.` : '');
  if (!text) throw new HttpError(400, 'Message is empty');
  const { mode, targets } = resolveTargets(c.id, target);
  const ref = replyRef(c.id, reply_to);
  const turnId = uid(), t = now();
  tx(db, () => {
    db.prepare('INSERT INTO turns (id, conversation_id, user_message, mode, target_models, reply_to_response, reply_quote, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(turnId, c.id, text, mode, JSON.stringify(targets.map((x) => x.model_id)), ref.id, ref.quote, t);
    for (const a of atts) db.prepare('UPDATE attachments SET conversation_id=?, turn_id=? WHERE id=?').run(c.id, turnId, a.id);
    // "Continue with this" pins apply to exactly this next turn.
    db.prepare(`UPDATE context_selections SET consumed_turn_id=? WHERE conversation_id=? AND selection_type='continue'
                AND active=1 AND consumed_turn_id IS NULL`).run(turnId, c.id);
    targets.forEach((m) => db.prepare(`INSERT INTO responses (id, turn_id, conversation_id, model_id, display_position, status, created_at)
      VALUES (?,?,?,?,?, 'pending', ?)`).run(uid(), turnId, c.id, m.model_id, m.position, t));
    if (c.title === 'New conversation') db.prepare('UPDATE conversations SET title=? WHERE id=?').run(text.replace(/\s+/g, ' ').slice(0, 60), c.id);
    db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(t, c.id);
  });
  // All models start at once, server side; output flows over the conversation stream.
  for (const r of db.prepare('SELECT id FROM responses WHERE turn_id=?').all(turnId)) startRun(user, r.id);
  send(res, 201, conversationPayload(ownConversation(user, c.id)));
});

// Starts (or regenerates) a run in the background; output arrives on the conversation stream.
route('POST', '/api/responses/:id/run', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  const { regenerate } = await readJson(req);
  if (r.status === 'completed' && !regenerate) throw new HttpError(400, 'Response already completed');
  startRun(user, r.id, { regenerate: !!r.content?.trim() });
  send(res, 202, { ok: true });
});

route('POST', '/api/responses/:id/restore', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  if (running.has(r.id)) throw new HttpError(409, 'Stop this response first');
  const full = db.prepare('SELECT * FROM responses WHERE id=?').get(r.id);
  const versions = JSON.parse(full.versions || '[]');
  const i = Number((await readJson(req)).index);
  const v = versions[i];
  if (!v) throw new HttpError(404, 'Version not found');
  // Swap: the current answer becomes a version, the chosen version becomes current.
  versions.splice(i, 1);
  if (full.content?.trim()) versions.push({ content: full.content, reasoning: full.reasoning, status: full.status, prompt_tokens: full.prompt_tokens,
    completion_tokens: full.completion_tokens, cost: full.cost, latency_ms: full.latency_ms, finished_at: full.finished_at });
  db.prepare(`UPDATE responses SET content=?, reasoning=?, status='completed', error=NULL, error_kind=NULL, prompt_tokens=?, completion_tokens=?,
              cost=?, latency_ms=?, versions=? WHERE id=?`)
    .run(v.content, v.reasoning || '', v.prompt_tokens ?? null, v.completion_tokens ?? null, v.cost ?? null, v.latency_ms ?? null, JSON.stringify(versions), r.id);
  send(res, 200, getResponseRow(r.id));
});

route('GET', '/api/responses/:id/versions', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  send(res, 200, { versions: JSON.parse(db.prepare('SELECT versions FROM responses WHERE id=?').get(r.id).versions || '[]') });
});

// Live NDJSON stream for one chat. Sends a snapshot of anything mid-generation, then every event.
route('GET', '/api/conversations/:id/stream', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  if (!hubs.has(c.id)) hubs.set(c.id, new Set());
  hubs.get(c.id).add(res);
  for (const [rid, st] of running) {
    if (st.convId === c.id) res.write(JSON.stringify({ type: 'snapshot', rid, content: st.content, reasoning: st.reasoning, retrying: st.retrying, switching: st.switching }) + '\n');
  }
  res.write(JSON.stringify({ type: 'ready' }) + '\n');
  const ping = setInterval(() => res.write('{"type":"ping"}\n'), 15_000);
  res.on('close', () => { clearInterval(ping); hubs.get(c.id)?.delete(res); if (!hubs.get(c.id)?.size) hubs.delete(c.id); });
});

route('POST', '/api/conversations/:id/stop', async (req, res, { user, params }) => {
  const c = ownConversation(user, params.id);
  let n = 0;
  for (const st of running.values()) if (st.convId === c.id) { st.ctl.abort('user'); n++; }
  send(res, 200, { stopped: n });
});

// Edit the latest message and rerun every model on it. Earlier answers are kept as versions.
route('POST', '/api/turns/:id/edit', async (req, res, { user, params }) => {
  const turn = db.prepare(`SELECT t.* FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.user_id=?`).get(params.id, user.id);
  if (!turn) throw new HttpError(404, 'Message not found');
  const last = db.prepare('SELECT id FROM turns WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1').get(turn.conversation_id);
  if (last.id !== turn.id) throw new HttpError(400, 'Only your latest message can be edited');
  const text = String((await readJson(req)).message || '').trim();
  if (!text) throw new HttpError(400, 'Message is empty');
  const resps = db.prepare('SELECT * FROM responses WHERE turn_id=?').all(turn.id);
  if (resps.some((r) => running.has(r.id))) throw new HttpError(409, 'Stop the running answers first');
  // Stand-ins stay; replaced (busy) lanes are not rerun.
  const rerun = resps.filter((r) => !r.replaced_by);
  tx(db, () => {
    db.prepare('UPDATE turns SET user_message=?, traced=0 WHERE id=?').run(text, turn.id);
    for (const r of rerun) { archiveVersion(r); db.prepare(`UPDATE responses SET status='pending', content='', reasoning='', error=NULL, error_kind=NULL WHERE id=?`).run(r.id); }
  });
  for (const r of rerun) startRun(user, r.id);
  touch(turn.conversation_id);
  send(res, 200, conversationPayload(ownConversation(user, turn.conversation_id)));
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
  startRun(user, newId);
  send(res, 200, { ...conversationPayload(ownConversation(user, r.conversation_id)), new_response_id: newId });
});

route('POST', '/api/responses/:id/stop', async (req, res, { user, params }) => {
  const r = ownResponse(user, params.id);
  running.get(r.id)?.ctl.abort('user');
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
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Internal error', ...(e.status ? e.extra || {} : {}) });
    else res.end();
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    if (lf.enabled()) { console.log('Flushing Langfuse traces…'); await Promise.race([lf.flush(), new Promise((ok) => setTimeout(ok, 5000))]); }
    process.exit(0);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => console.log(`Multi-model workspace running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}
export { db };
