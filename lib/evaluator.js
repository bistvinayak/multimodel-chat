// Evaluation layer (PRD §17). Primary: Jev by TypeSafe, a decision model with typed outputs
//   POST https://api.typesafe.ai/v1/systemone  { model, state, questions }
//   score -> { score, legend, probabilities, confidence }   choice -> { choice, probabilities, confidence }   noul -> { noul }
// Fallback when no Jev key is configured: an LLM judge on OpenRouter with the same rubric and output shape.
import { complete } from './openrouter.js';

export const LEVELS = ['Poor', 'Weak', 'Adequate', 'Good', 'Excellent']; // score 0..4
export const CRITERIA = {
  relevance: { label: 'Relevance', q: 'How well does the answer address what the user actually asked?' },
  completeness: { label: 'Completeness', q: 'How completely does the answer cover everything the user needs, without leaving important gaps?' },
  instruction_following: { label: 'Instruction following', q: 'How well does the answer follow the user\'s explicit instructions and constraints (format, length, scope, stated requirements)?' },
  clarity: { label: 'Clarity', q: 'How clear, well organized and easy to read is the answer?' },
  actionability: { label: 'Actionability', q: 'How easy is it for the user to act on this answer right away (concrete steps, specifics, examples)?' },
  groundedness: { label: 'Groundedness', q: 'Does the answer contain claims that look fabricated, unsupported, or inconsistent with the conversation and attached material?', noul: true },
  conciseness: { label: 'Conciseness', q: 'How free is the answer of padding, repetition and unnecessary text?' },
};
export const DEFAULT_CRITERIA = ['relevance', 'completeness', 'instruction_following', 'clarity', 'actionability'];
const LETTERS = 'ABCDEFGH';
const cap = (s, n) => (s.length > n ? s.slice(0, n) + '\n[...truncated]' : s);

/** The situation every candidate is judged against (no model names: blind). */
export function buildBrief({ question, context }) {
  return `USER REQUEST:\n${cap(question, 6000)}${context ? `\n\nCONTEXT THE ANSWER SHOULD RESPECT:\n${cap(context, 6000)}` : ''}`;
}

// ---------- Jev ----------
async function jev({ apiKey, base, state, questions }) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    let r;
    try { r = await fetch(`${base}/v1/systemone`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state, questions }),
    }); } catch (e) {
      if (attempt < 2) { await new Promise((ok) => setTimeout(ok, 800 * 2 ** attempt)); continue; }
      throw new Error(`Could not reach Jev at ${base} (${e.cause?.code || e.message}). Try again in a moment.`);
    }
    if ((r.status === 429 || r.status === 529) && attempt < 3) { await new Promise((ok) => setTimeout(ok, 800 * 2 ** attempt)); continue; }
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error('Jev rejected the API key (401). Check your TypeSafe key.');
    if (!r.ok) throw new Error(`Jev error ${r.status}: ${JSON.stringify(body.detail || body.error || body).slice(0, 300)}`);
    return { ...body, latency_ms: Date.now() - t0 };
  }
}

export async function evaluateWithJev({ apiKey, base = 'https://api.typesafe.ai', brief, candidates, criteria }) {
  const t0 = Date.now();
  const scoreQs = Object.fromEntries(criteria.map((k) => [k, CRITERIA[k].noul
    ? { type: 'noul', instructions: CRITERIA[k].q, criteria: { true: 'The answer contains fabricated or unsupported claims.', false: 'Every claim is supported or clearly framed as an assumption.' } }
    : { type: 'score', instructions: CRITERIA[k].q, criteria: LEVELS }]));
  // One scoring request per candidate (state = brief + that answer), plus one blind head-to-head choice.
  const perCandidate = candidates.map((c) => jev({ apiKey, base, state: `${c.brief || brief}\n\nANSWER TO EVALUATE:\n${cap(c.content, 12000)}`, questions: scoreQs }));
  const choice = candidates.length > 1 ? jev({
    apiKey, base,
    state: `${brief}\n\n${candidates.map((c, i) => `ANSWER ${LETTERS[i]}${c.request ? ` (answering: ${cap(c.request, 400)})` : ''}:\n${cap(c.content, Math.floor(24000 / candidates.length))}`).join('\n\n')}`,
    questions: { best: { type: 'choice', instructions: 'Which answer best serves the user, considering relevance, completeness, instruction following, clarity and actionability?',
      criteria: Object.fromEntries(candidates.map((_, i) => [LETTERS[i], `Answer ${LETTERS[i]}`])) } },
  }) : null;
  const [scored, picked] = await Promise.all([Promise.all(perCandidate), choice]);
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (const r of [...scored, picked].filter(Boolean)) { usage.input_tokens += r.usage?.input_tokens || 0; usage.output_tokens += r.usage?.output_tokens || 0; }
  const results = candidates.map((c, i) => {
    const ans = scored[i].answers || {};
    const scores = Object.fromEntries(criteria.map((k) => {
      const a = ans[k] || {};
      if (CRITERIA[k].noul) { const p = Number(a.noul); return [k, { value: Number.isFinite(p) ? (1 - p) * 4 : null, raw: a, confidence: Number.isFinite(p) ? Math.abs(p - 0.5) * 2 : null }]; }
      return [k, { value: Number.isFinite(Number(a.score)) ? Number(a.score) : null, raw: a, confidence: a.confidence ?? null }];
    }));
    return { response_id: c.id, scores };
  });
  let pick = null;
  if (picked) {
    const a = picked.answers?.best || {};
    const idx = LETTERS.indexOf(a.choice);
    pick = idx >= 0 ? { response_id: candidates[idx].id, confidence: a.confidence ?? null,
      probabilities: Object.fromEntries(Object.entries(a.probabilities || {}).map(([L, p]) => [candidates[LETTERS.indexOf(L)]?.id, p]).filter(([id]) => id)) } : null;
  }
  return { evaluator: 'jev', evaluator_model: scored[0]?.model || 'jev-latest', results, pick, usage, latency_ms: Date.now() - t0 };
}

// ---------- fallback: LLM judge on OpenRouter ----------
export async function evaluateWithJudge({ apiKey, models, brief, candidates, criteria }) {
  const t0 = Date.now();
  const rubric = criteria.map((k) => `- ${k}: ${CRITERIA[k].noul ? 'How well supported are its claims? 4 = fully grounded, 0 = clearly fabricated.' : CRITERIA[k].q} (0 = Poor, 1 = Weak, 2 = Adequate, 3 = Good, 4 = Excellent)`).join('\n');
  const messages = [
    { role: 'system', content: 'You are a strict, fair evaluator of AI answers. Judge only quality for the user, never style preferences or length for its own sake. Reply with JSON only.' },
    { role: 'user', content: `${brief}\n\n${candidates.map((c, i) => `ANSWER ${LETTERS[i]}${c.request ? ` (answering: ${cap(c.request, 400)})` : ''}:\n${cap(c.content, Math.floor(30000 / candidates.length))}`).join('\n\n')}\n\nScore every answer on each criterion from 0 to 4:\n${rubric}\n\nThen pick the single best answer and give your confidence from 0 to 1.\nReply with exactly this JSON shape:\n{"scores": {"A": {${criteria.map((k) => `"${k}": 0`).join(', ')}}, ...}, "best": "A", "confidence": 0.0}` },
  ];
  let lastErr;
  for (const m of models) {
    try {
      const text = await complete({ apiKey, model: m, messages, maxTokens: 3000, timeoutMs: 90_000 });
      const json = JSON.parse((text.match(/\{[\s\S]*\}/) || [])[0] || 'null');
      if (!json?.scores) throw new Error('Judge returned no scores');
      const results = candidates.map((c, i) => ({ response_id: c.id,
        scores: Object.fromEntries(criteria.map((k) => { const v = Number(json.scores?.[LETTERS[i]]?.[k]); return [k, { value: Number.isFinite(v) ? Math.max(0, Math.min(4, v)) : null, confidence: null }]; })) }));
      const idx = LETTERS.indexOf(String(json.best || '').trim().toUpperCase());
      return { evaluator: 'llm-judge', evaluator_model: m, results, usage: null, latency_ms: Date.now() - t0,
        pick: idx >= 0 && candidates[idx] ? { response_id: candidates[idx].id, confidence: Number.isFinite(Number(json.confidence)) ? Number(json.confidence) : null, probabilities: null } : null };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`The fallback judge failed: ${lastErr?.message || 'no model available'}`);
}

/** 0..100 overall from criterion scores (0..4). */
export const overall = (scores) => {
  const vals = Object.values(scores).map((s) => s.value).filter((v) => v != null);
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length / 4) * 100) : null;
};
