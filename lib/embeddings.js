// Text embeddings through OpenRouter. Vectors are normalized, so cosine similarity is a plain dot product.
// Stored as Float32 bytes in SQLite. Everything degrades gracefully: callers treat a failure as "keyword search only".
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = () => process.env.OPENROUTER_EMBED_URL
  || (process.env.OPENROUTER_URL ? process.env.OPENROUTER_URL.replace(/\/chat(\/completions)?$/, '/embeddings') : 'https://openrouter.ai/api/v1/embeddings');

export const DEFAULT_EMBEDDING_MODEL = 'nvidia/nemotron-3-embed-1b:free';
const BATCH = 16;

const normalize = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; const out = new Float32Array(v.length); for (let i = 0; i < v.length; i++) out[i] = v[i] / n; return out; };

/** Embed texts. Returns one normalized Float32Array per input, in order. Throws if a batch fails after retries. */
export async function embedTexts({ apiKey, model, inputs, timeoutMs = 60_000, retryMs = Number(process.env.RAG_EMBED_RETRY_MS ?? 2500), fetchImpl = fetch }) {
  const out = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH).map((t) => String(t).slice(0, 8000) || ' ');
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetchImpl(url(), { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost', 'X-Title': 'Multi-Model Workspace' },
          body: JSON.stringify({ model, input: batch }) });
        const body = await r.json().catch(() => ({}));
        if (r.ok && Array.isArray(body.data) && body.data.length === batch.length) {
          for (const d of [...body.data].sort((a, b) => a.index - b.index)) out.push(normalize(d.embedding));
          lastErr = null; break;
        }
        lastErr = new Error(body?.error?.message || `HTTP ${r.status}`);
        lastErr.status = r.status;
        if (r.status === 400 || r.status === 401 || r.status === 402 || r.status === 404) break; // not worth retrying
      } catch (e) { lastErr = e; }
      await sleep(retryMs * (attempt + 1));
    }
    if (lastErr) throw lastErr;
  }
  return out;
}

export const pack = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
export const unpack = (buf) => { const copy = Buffer.from(buf); return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4); };
export function cosine(a, b) { if (!a || !b || a.length !== b.length) return 0; let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
