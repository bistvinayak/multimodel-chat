// Live model catalog from OpenRouter, so free/paid status and prices are never hard-coded.
const POPULAR_PREFIXES = ['openai/', 'anthropic/', 'google/', 'deepseek/', 'meta-llama/', 'x-ai/', 'mistralai/', 'qwen/'];
const FAST_RE = /\b(flash|mini|nano|lite|small|haiku|turbo|instant|lightning|fast|xs)\b/i;
const CODE_RE = /\b(code|coder|coding|devstral|codestral|programming|software engineering)\b/i;

let cache = null;

function price(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function normalize(m) {
  const arch = m.architecture || {};
  const outs = arch.output_modalities || ['text'];
  const prompt = price(m.pricing?.prompt);
  const completion = price(m.pricing?.completion);
  const request = price(m.pricing?.request) ?? 0;
  const free = prompt === 0 && completion === 0 && request === 0;
  const params = m.supported_parameters || [];
  const text = `${m.id} ${m.name} ${m.description || ''}`;
  const tags = [];
  if (free) tags.push('free');
  if (FAST_RE.test(`${m.id} ${m.name}`)) tags.push('fast');
  if (params.includes('reasoning') || params.includes('include_reasoning')) tags.push('reasoning');
  if (CODE_RE.test(text)) tags.push('coding');
  if (POPULAR_PREFIXES.some((p) => m.id.startsWith(p))) tags.push('popular');
  return {
    id: m.id,
    name: m.name || m.id,
    description: (m.description || '').slice(0, 280),
    context_length: m.top_provider?.context_length || m.context_length || null,
    max_output: m.top_provider?.max_completion_tokens || null,
    prompt_price: prompt,          // USD per token
    completion_price: completion,  // USD per token
    free,
    tags,
    created: m.created || 0,
    textOut: outs.includes('text') && !/->.*(image|audio)/.test(arch.modality || ''),
  };
}

export async function getCatalog({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < 10 * 60_000) return cache.models;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`catalog HTTP ${r.status}`);
    const { data } = await r.json();
    const models = data
      .filter((m) => !m.id.endsWith(':batch'))
      // Routers (openrouter/auto, openrouter/free) pick a different model per request,
      // which would silently invalidate a side-by-side comparison.
      .filter((m) => !m.id.startsWith('openrouter/'))
      .map(normalize)
      .filter((m) => m.textOut && m.prompt_price !== null && m.completion_price !== null)
      .map(({ textOut, ...m }) => m)
      .sort((a, b) => (b.tags.includes('popular') - a.tags.includes('popular')) || b.created - a.created);
    cache = { at: Date.now(), models, byId: new Map(models.map((m) => [m.id, m])) };
    return models;
  } catch (e) {
    if (cache) return cache.models;
    throw e;
  }
}

export async function getModel(id) {
  await getCatalog().catch(() => null);
  return cache?.byId.get(id) || null;
}

export function shortName(model) {
  return (model?.name || '').replace(/^[^:]+:\s*/, '') || model?.id;
}
