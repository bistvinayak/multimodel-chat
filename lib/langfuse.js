// Langfuse tracing over OpenTelemetry (OTLP/HTTP JSON), with no SDK dependency.
//
// Mapping:
//   chat (conversation)     -> Langfuse session   (session.id = conversation id)
//   one user message (turn) -> trace              (trace id derived from the turn id)
//   one model run           -> generation         (exact context sent, output, tokens, cost, timing)
//   retries / auto-switch   -> events on that generation
//   use / continue / save / final -> scores (POST /api/public/scores)
//
// Langfuse Cloud shuts down the legacy /api/public/ingestion endpoint for traces on
// 2026-11-16, so this uses the OTel endpoint it recommends.
import crypto from 'node:crypto';

const cfg = () => ({
  pk: process.env.LANGFUSE_PUBLIC_KEY,
  sk: process.env.LANGFUSE_SECRET_KEY,
  host: (process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').replace(/\/+$/, ''),
  logContent: process.env.LANGFUSE_LOG_CONTENT !== 'false',
  environment: process.env.LANGFUSE_ENVIRONMENT || 'development',
});
export const enabled = () => { const c = cfg(); return !!(c.pk && c.sk); };
const authHeader = () => { const c = cfg(); return 'Basic ' + Buffer.from(`${c.pk}:${c.sk}`).toString('base64'); };

export const stats = { spans_sent: 0, spans_dropped: 0, scores_sent: 0, scores_dropped: 0, last_error: null, last_success_at: null };

// ---------- ids & encoding ----------
export const traceIdFor = (turnId) => turnId.replace(/-/g, '').toLowerCase().padEnd(32, '0').slice(0, 32);
export const rootSpanIdFor = (turnId) => crypto.createHash('sha256').update(`root:${turnId}`).digest('hex').slice(0, 16);
export const newSpanId = () => crypto.randomBytes(8).toString('hex');
const nanos = (ms) => String(BigInt(Math.round(ms)) * 1_000_000n);
const iso = (ms) => new Date(ms).toISOString();
const json = (v) => JSON.stringify(v);

export function attrs(obj) {
  const out = [];
  for (const [key, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    let value;
    if (Array.isArray(v)) value = { arrayValue: { values: v.map((x) => ({ stringValue: String(x) })) } };
    else if (typeof v === 'boolean') value = { boolValue: v };
    else if (typeof v === 'number') value = Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
    else value = { stringValue: String(v) };
    out.push({ key, value });
  }
  return out;
}

// Trace-level attributes go on every span: Langfuse v4 is observation-centric.
function traceAttrs({ conv, user, turn }) {
  return {
    'session.id': conv.id,
    'user.id': user.id,                                   // opaque UUID, never the email
    'langfuse.session.id': conv.id,
    'langfuse.user.id': user.id,
    'langfuse.trace.name': 'chat-turn',
    'langfuse.environment': cfg().environment,
    'langfuse.trace.metadata.conversation_title': conv.title,
    'langfuse.trace.metadata.turn_id': turn.id,
  };
}
const content = (v) => (cfg().logContent ? json(v) : undefined);

// ---------- span builders ----------
/** Root span for one user message. Emitted once every model in the turn has finished. */
export function turnSpan({ conv, user, turn, responses, skills, decisions, turnIndex }) {
  const end = Math.max(turn.created_at + 1, ...responses.map((r) => r.finished_at || 0));
  const targets = JSON.parse(turn.target_models || '[]');
  const output = Object.fromEntries(responses.map((r) => [r.model_id, r.status === 'completed' ? r.content : `[${r.status}${r.error_kind ? `: ${r.error_kind}` : ''}]`]));
  return {
    traceId: traceIdFor(turn.id),
    spanId: rootSpanIdFor(turn.id),
    name: `turn ${turnIndex}`,
    kind: 1,
    startTimeUnixNano: nanos(turn.created_at),
    endTimeUnixNano: nanos(end),
    attributes: attrs({
      ...traceAttrs({ conv, user, turn }),
      'langfuse.observation.type': 'chain',
      'langfuse.trace.input': content({ message: turn.user_message, reply_to: turn.reply_to_response || undefined, reply_quote: turn.reply_quote || undefined }),
      'langfuse.trace.output': content(output),
      'langfuse.observation.input': content({ message: turn.user_message }),
      'langfuse.observation.output': content(output),
      'langfuse.trace.tags': [turn.mode, ...targets],
      'langfuse.trace.metadata.mode': turn.mode,
      'langfuse.trace.metadata.turn_index': turnIndex,
      'langfuse.trace.metadata.models': targets.join(', '),
      'langfuse.trace.metadata.skills': skills.map((k) => k.name).join(', '),
      'langfuse.trace.metadata.shared_decisions': decisions,
      'langfuse.trace.metadata.reply_to_response': turn.reply_to_response || undefined,
      'langfuse.observation.metadata.total_cost_usd': responses.reduce((s, r) => s + (r.cost || 0), 0),
    }),
    status: { code: responses.some((r) => r.status === 'completed') ? 1 : 2 },
  };
}

const LEVEL = { completed: 'DEFAULT', stopped: 'WARNING', rate_limited: 'WARNING', failed: 'ERROR' };

/** One model run (generation). `events` = [{ name, time, attributes }] collected during the run. */
export function generationSpan({ conv, user, turn, resp, spanId, startedAt, messages, maxOut, events = [] }) {
  const end = resp.finished_at || Date.now();
  const level = resp.error_kind === 'truncated' ? 'WARNING' : LEVEL[resp.status] || 'DEFAULT';
  return {
    traceId: traceIdFor(turn.id),
    spanId,
    parentSpanId: rootSpanIdFor(turn.id),
    name: resp.model_id,
    kind: 3, // CLIENT
    startTimeUnixNano: nanos(startedAt),
    endTimeUnixNano: nanos(Math.max(end, startedAt + 1)),
    attributes: attrs({
      ...traceAttrs({ conv, user, turn }),
      'langfuse.observation.type': 'generation',
      'langfuse.observation.model.name': resp.model_id,
      'gen_ai.system': 'openrouter',
      'gen_ai.request.model': resp.model_id,
      'gen_ai.response.model': resp.served_model || undefined,
      'langfuse.observation.model.parameters': json({ max_tokens: maxOut, stream: true }),
      'langfuse.observation.input': content(messages),
      'langfuse.observation.output': content(resp.reasoning ? { role: 'assistant', content: resp.content, reasoning: resp.reasoning } : { role: 'assistant', content: resp.content }),
      'langfuse.observation.usage_details': resp.prompt_tokens != null ? json({ input: resp.prompt_tokens, output: resp.completion_tokens || 0 }) : undefined,
      'langfuse.observation.cost_details': resp.cost != null ? json({ total: resp.cost }) : undefined,
      'langfuse.observation.completion_start_time': resp.first_token_ms != null ? iso(startedAt + resp.first_token_ms) : undefined,
      'langfuse.observation.level': level,
      'langfuse.observation.status_message': resp.error || undefined,
      'langfuse.observation.metadata.response_id': resp.id,
      'langfuse.observation.metadata.status': resp.status,
      'langfuse.observation.metadata.error_kind': resp.error_kind || undefined,
      'langfuse.observation.metadata.finish_reason': resp.finish_reason || undefined,
      'langfuse.observation.metadata.provider': resp.provider || undefined,
      'langfuse.observation.metadata.attempt': resp.attempts,
      'langfuse.observation.metadata.lane_position': resp.display_position,
      'langfuse.observation.metadata.stands_in_for': resp.stands_in_for || undefined,
      'langfuse.observation.metadata.auto_switched': resp.auto_switched ? true : undefined,
      'langfuse.observation.metadata.latency_ms': resp.latency_ms ?? undefined,
    }),
    events: events.map((e) => ({ timeUnixNano: nanos(e.time), name: e.name, attributes: attrs(e.attributes || {}) })),
    status: resp.status === 'completed' ? { code: 1 } : { code: 2, message: resp.error || resp.status },
  };
}

// ---------- exporter ----------
let queue = [];
let timer = null;
let flushing = null;

export function enqueue(span) {
  if (!enabled()) return;
  queue.push(span);
  if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 1500);
}

async function postSpans(spans, attempt = 0) {
  const body = {
    resourceSpans: [{
      resource: { attributes: attrs({ 'service.name': 'multimodel-chat', 'deployment.environment': cfg().environment }) },
      scopeSpans: [{ scope: { name: 'multimodel-chat', version: '0.3.0' }, spans }],
    }],
  };
  try {
    const r = await fetch(`${cfg().host}/api/public/otel/v1/traces`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 300);
      const err = new Error(`Langfuse HTTP ${r.status}: ${text}`);
      err.retryable = r.status >= 500 || r.status === 429;
      throw err;
    }
    stats.spans_sent += spans.length; stats.last_success_at = Date.now(); stats.last_error = null;
  } catch (e) {
    const retryable = e.retryable !== false;
    if (retryable && attempt < 3) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt)); return postSpans(spans, attempt + 1); }
    stats.spans_dropped += spans.length; stats.last_error = e.message;
    console.warn(`[langfuse] dropped ${spans.length} span(s): ${e.message}`);
  }
}

/** Sends everything queued. Batches stay under ~3 MB. */
export function flush() {
  if (flushing) return flushing.then(() => (queue.length ? flush() : undefined));
  flushing = (async () => {
    while (queue.length) {
      const batch = []; let size = 0;
      while (queue.length && (batch.length === 0 || size < 3_000_000)) { const s = queue.shift(); size += JSON.stringify(s).length; batch.push(s); }
      await postSpans(batch);
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

// ---------- scores (user preference signal) ----------
export async function score({ name, traceId, observationId, sessionId, value = 1, comment, metadata }) {
  if (!enabled()) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${cfg().host}/api/public/scores`, {
        method: 'POST',
        headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, traceId, observationId, sessionId, value, dataType: 'NUMERIC', comment, metadata, environment: cfg().environment }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) { stats.scores_sent++; return; }
      if (r.status < 500 && r.status !== 429) throw Object.assign(new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`), { final: true });
    } catch (e) {
      if (e.final || attempt === 2) { stats.scores_dropped++; stats.last_error = `score: ${e.message}`; console.warn('[langfuse] score dropped:', e.message); return; }
    }
    await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt));
  }
}

// ---------- links ----------
let projectBase = null;
export async function projectUrl() {
  if (!enabled()) return null;
  if (projectBase) return projectBase;
  try {
    const r = await fetch(`${cfg().host}/api/public/projects`, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const id = (await r.json()).data?.[0]?.id;
    if (id) projectBase = `${cfg().host}/project/${id}`;
  } catch (e) { stats.last_error = `project lookup: ${e.message}`; }
  return projectBase;
}

export const config = () => ({ enabled: enabled(), host: cfg().host, log_content: cfg().logContent, environment: cfg().environment });
