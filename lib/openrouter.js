// One streaming request per model. Never uses OpenRouter's `models` fallback array:
// that is sequential fallback and would silently swap the model under comparison.
const URL = process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions'; // overridable for tests
const IDLE_TIMEOUT_MS = 120_000;

export class ModelError extends Error {
  constructor(kind, message, status = 'failed', retryAfterMs = null) {
    super(message);
    this.kind = kind;
    this.status = status; // failed | rate_limited
    this.retryAfterMs = retryAfterMs;
  }
}

// OpenRouter's upstream 429s usually carry no Retry-After, but honor it when present.
export function retryAfterMs(headers, body, now = Date.now()) {
  const ra = headers?.get?.('retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return n * 1000;
    const d = Date.parse(ra);
    if (d) return Math.max(0, d - now);
  }
  const reset = headers?.get?.('x-ratelimit-reset') ?? body?.error?.metadata?.headers?.['X-RateLimit-Reset'];
  const r = Number(reset);
  if (r > 1e12) return Math.max(0, r - now);      // epoch ms
  if (r > 1e9) return Math.max(0, r * 1000 - now); // epoch s
  return null;
}

export function classifyError(httpStatus, body, headers) {
  let msg = body?.error?.message || (typeof body === 'string' ? body : '') || `HTTP ${httpStatus}`;
  const raw = body?.error?.metadata?.raw;
  if (raw && typeof raw === 'string') msg = `${msg}: ${raw}`;
  const code = Number(body?.error?.code) || httpStatus;
  const low = msg.toLowerCase();
  if (code === 429) return new ModelError('rate_limit', msg, 'rate_limited', retryAfterMs(headers, body));
  if (code === 402) return new ModelError('insufficient_credits', msg);
  if (code === 404 || low.includes('not a valid model') || low.includes('no endpoints found')) return new ModelError('invalid_model', msg);
  if (low.includes('context length') || low.includes('context window') || low.includes('maximum context')) return new ModelError('context_limit', msg);
  if (code === 403 && (low.includes('moderation') || low.includes('flagged'))) return new ModelError('safety', msg);
  if (code === 403) return new ModelError('forbidden', msg);
  if (code === 408 || code === 504) return new ModelError('timeout', msg);
  if (code >= 500) return new ModelError('provider_unavailable', msg);
  return new ModelError('unknown', msg);
}

/**
 * Streams one completion. Calls onDelta(text), onReasoning(text). Resolves with stats.
 * Aborting `signal` with reason 'user' stops the request.
 */
export async function streamCompletion({ apiKey, model, messages, maxTokens, signal, onDelta, onReasoning, plugins, fetchImpl = fetch }) {
  const idle = new AbortController();
  let idleTimer;
  const bump = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort('timeout'), IDLE_TIMEOUT_MS); };
  const combined = AbortSignal.any([signal, idle.signal].filter(Boolean));
  const started = Date.now();
  let firstTokenAt = null;
  const stats = { usage: null, finish_reason: null, served_model: null, provider: null };

  bump();
  try {
    let r;
    try {
      r = await fetchImpl(URL, {
        method: 'POST',
        signal: combined,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost',
          'X-Title': 'Multi-Model Workspace',
        },
        body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, usage: { include: true }, ...(plugins ? { plugins } : {}) }),
      });
    } catch (e) {
      if (combined.aborted) throw e;
      throw new ModelError('network', `Network error: ${e.message}`);
    }
    if (!r.ok) {
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      throw classifyError(r.status, body, r.headers);
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bump();
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // skips ": OPENROUTER PROCESSING" keep-alives
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk; try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) throw classifyError(Number(chunk.error.code) || 500, chunk);
        stats.served_model ||= chunk.model;
        stats.provider ||= chunk.provider;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta || {};
        if (delta.reasoning) { firstTokenAt ??= Date.now(); onReasoning?.(delta.reasoning); }
        if (delta.content) { firstTokenAt ??= Date.now(); onDelta?.(delta.content); }
        if (choice?.finish_reason) stats.finish_reason = choice.finish_reason;
        if (chunk.usage) stats.usage = chunk.usage;
      }
    }
  } catch (e) {
    if (e instanceof ModelError) throw e;
    if (combined.aborted) {
      const reason = signal?.aborted ? signal.reason : idle.signal.reason;
      if (reason === 'timeout') throw new ModelError('timeout', `No data from the model for ${IDLE_TIMEOUT_MS / 1000}s`);
      throw new ModelError('stopped', 'Stopped by user');
    }
    throw new ModelError('network', `Stream error: ${e.message}`);
  } finally {
    clearTimeout(idleTimer);
  }
  stats.latency_ms = Date.now() - started;
  stats.first_token_ms = firstTokenAt ? firstTokenAt - started : null;
  return stats;
}

/** Tiny non-streaming request to see if a model is answering for this key right now. */
export async function probeModel(apiKey, model, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(URL, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost', 'X-Title': 'Multi-Model Workspace' },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
    });
    if (r.ok) return { model, health: 'ok' };
    const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    const e = classifyError(r.status, body, r.headers);
    return { model, health: e.kind === 'rate_limit' ? 'busy' : ['forbidden', 'invalid_model', 'insufficient_credits'].includes(e.kind) ? 'blocked' : 'error', kind: e.kind };
  } catch (e) {
    return { model, health: 'error', kind: 'network' };
  }
}

/** Non-streaming completion for small background jobs (titles, summaries). Returns text. */
export async function complete({ apiKey, model, messages, maxTokens = 600, timeoutMs = 60_000, fetchImpl = fetch }) {
  const r = await fetchImpl(URL, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost', 'X-Title': 'Multi-Model Workspace' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok || body?.error) throw classifyError(body?.error?.code || r.status, body, r.headers);
  return (body.choices?.[0]?.message?.content || '').trim();
}

/** Checks an OpenRouter key and returns its limits/usage (GET /api/v1/key). */
export async function keyInfo(apiKey, fetchImpl = fetch) {
  const r = await fetchImpl('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (r.status === 401 || r.status === 403) throw new ModelError('invalid_key', 'OpenRouter rejected this key.');
  if (!r.ok) throw new ModelError('network', `OpenRouter returned HTTP ${r.status} while checking the key.`);
  const d = (await r.json()).data || {};
  return {
    label: d.label || null, limit: d.limit ?? null, limit_remaining: d.limit_remaining ?? null,
    usage: d.usage ?? null, usage_daily: d.usage_daily ?? null, usage_monthly: d.usage_monthly ?? null, is_free_tier: !!d.is_free_tier,
    free_daily: d.free_model_daily_requests || null,
  };
}
