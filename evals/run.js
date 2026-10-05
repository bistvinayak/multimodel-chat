// AI evaluation suite: measures every AI step in the agents with labeled datasets.
//   npm run eval                                  all suites, default free models
//   npm run eval -- --suite relevance             one suite (planner | relevance | page | price)
//   npm run eval -- --models a/x:free,b/y:free    compare models side by side
//   npm run eval -- --gate                        exit 1 if a quality gate fails (CI)
// User feedback (👍/👎 on agent results) in the app database is added to the relevance suite.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { getCatalog, qualityScore, NOT_CHAT } from '../lib/models.js';
import { planRequest, scoreRelevance, judgePage } from '../lib/monitor.js';
import { extractStructured, extractWithAI } from '../lib/watch.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? (process.argv[i + 1]?.startsWith('--') ? true : process.argv[i + 1] ?? true) : d; };
const SUITE = arg('suite', 'all');
const OUT = path.resolve(arg('out', path.join(ROOT, 'data', 'evals')));
const DB = arg('db', path.join(ROOT, 'data', 'app.db'));
const GATE = !!arg('gate', false);
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) { console.error('Set OPENROUTER_API_KEY in .env'); process.exit(2); }
const load = (f) => JSON.parse(readFileSync(path.join(ROOT, 'evals', 'datasets', f), 'utf8'));
const GATES = { planner: { metric: 'case_pass_rate', min: 0.8 }, relevance: { metric: 'f1', min: 0.75 }, page: { metric: 'accuracy', min: 0.85 }, price: { metric: 'accuracy', min: 0.9 } };
const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return null; const i = (s.length - 1) * p; return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i)); };
const INTERVALS = [60, 120, 180, 240, 288, 360, 480, 720, 1440];
const nearest = (v) => INTERVALS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
const timed = async (fn) => { const t = Date.now(); try { return { value: await fn(), ms: Date.now() - t }; } catch (e) { return { error: e.message, ms: Date.now() - t }; } };
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }

async function defaultModels() {
  const cat = await getCatalog();
  return cat.filter((m) => m.free && m.id.endsWith(':free') && !NOT_CHAT.test(m.id)).sort((a, b) => qualityScore(b) - qualityScore(a)).slice(0, 4).map((m) => m.id);
}

// ---------- suites ----------
async function evalPlanner(models) {
  const { cases } = load('planner.json');
  const rows = await pool(cases, 3, async (c) => {
    const r = await timed(() => planRequest({ request: c.request, apiKey, models }));
    if (r.error) return { id: c.id, ok: false, error: r.error, ms: r.ms, checks: [] };
    const p = r.value; const e = c.expect; const checks = [];
    const has = (field, list) => list.some((w) => String(p[field] || '').toLowerCase().includes(w));
    if (e.type) checks.push(['type', p.type === e.type, p.type]);
    if (e.url) checks.push(['url', p.url === e.url, p.url]);
    if (e.condition) checks.push(['condition', (p.condition || (p.target_price ? 'below' : null)) === e.condition, p.condition]);
    if (e.target_price != null) checks.push(['target_price', Number(p.target_price) === e.target_price, p.target_price]);
    if (e.drop_pct != null) checks.push(['drop_pct', Number(p.drop_pct) === e.drop_pct, p.drop_pct]);
    if (e.interval_minutes) checks.push(['interval', nearest(Number(p.interval_minutes || 0)) === e.interval_minutes, p.interval_minutes]);
    for (const f of ['query', 'location', 'exclude', 'criteria']) if (e[`${f}_any`]) checks.push([f, has(f, e[`${f}_any`]), p[f]]);
    return { id: c.id, ok: checks.every((x) => x[1]), checks, ms: r.ms, model: p.planner_model };
  });
  const checks = rows.flatMap((r) => r.checks);
  return { metrics: { cases: rows.length, case_pass_rate: rows.filter((r) => r.ok).length / rows.length,
      type_accuracy: rows.filter((r) => r.checks.find((c) => c[0] === 'type')?.[1]).length / rows.length,
      field_accuracy: checks.length ? checks.filter((c) => c[1]).length / checks.length : null, errors: rows.filter((r) => r.error).length, latency_p50_ms: pctl(rows.map((r) => r.ms), 0.5) },
    failures: rows.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error, wrong: r.checks?.filter((c) => !c[1]).map(([f, , got]) => `${f}: got ${JSON.stringify(got)}`) })) };
}

function feedbackCases() {
  if (!existsSync(DB)) return { monitors: {}, cases: [] };
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT i.title, i.company, i.location, i.snippet, i.feedback, m.id mid, m.kind, m.query, m.location mloc, m.exclude, m.criteria
      FROM monitor_items i JOIN monitors m ON m.id=i.monitor_id WHERE i.feedback IS NOT NULL`).all();
    const monitors = {}; const cases = [];
    for (const r of rows) {
      monitors[`fb_${r.mid}`] = { kind: r.kind, query: r.query, location: r.mloc, exclude: r.exclude, criteria: r.criteria };
      cases.push({ monitor: `fb_${r.mid}`, item: { title: r.title, company: r.company, location: r.location, snippet: r.snippet }, relevant: r.feedback > 0, from_feedback: true });
    }
    return { monitors, cases };
  } catch { return { monitors: {}, cases: [] }; } finally { db.close(); }
}

async function evalRelevance(models) {
  const ds = load('relevance.json'); const fb = feedbackCases();
  const monitors = { ...ds.monitors, ...fb.monitors }; const cases = [...ds.cases, ...fb.cases];
  const byMon = {}; cases.forEach((c, i) => (byMon[c.monitor] ||= []).push({ ...c, i }));
  const preds = new Array(cases.length); const t0 = Date.now();
  for (const [mid, list] of Object.entries(byMon)) {
    // No feedback examples here: each case is judged on the monitor's description alone (no label leakage).
    const scores = await scoreRelevance({ m: monitors[mid], items: list.map((c) => c.item), apiKey, models, feedback: [] });
    list.forEach((c, k) => { preds[c.i] = scores[k]; });
  }
  let tp = 0, fp = 0, fn = 0, tn = 0, brier = 0; const wrong = [];
  cases.forEach((c, i) => {
    const s = preds[i]?.score; const yes = s != null && s >= 0.5; // unscreened counts as "not relevant", like the app
    if (yes && c.relevant) tp++; else if (yes) fp++; else if (c.relevant) fn++; else tn++;
    brier += ((s ?? 0) - (c.relevant ? 1 : 0)) ** 2;
    if (yes !== c.relevant) wrong.push({ title: c.item.title, expected: c.relevant, score: s, reason: preds[i]?.reason, from_feedback: !!c.from_feedback });
  });
  const precision = tp + fp ? tp / (tp + fp) : null, recall = tp + fn ? tp / (tp + fn) : null;
  return { metrics: { cases: cases.length, from_feedback: fb.cases.length, accuracy: (tp + tn) / cases.length, precision, recall,
      f1: precision && recall ? (2 * precision * recall) / (precision + recall) : 0, brier: brier / cases.length, unscreened: preds.filter((p) => p?.score == null).length, total_ms: Date.now() - t0 },
    confusion: { tp, fp, fn, tn }, failures: wrong };
}

async function evalPage(models) {
  const { cases } = load('page_judge.json');
  const rows = await pool(cases, 3, async (c) => { const r = await timed(() => judgePage({ text: c.text, criteria: c.criteria, url: 'https://eval.local/page', apiKey, models })); return { ...c, ...r }; });
  const ok = rows.filter((r) => !r.error && r.value.met === r.met);
  return { metrics: { cases: rows.length, accuracy: ok.length / rows.length, errors: rows.filter((r) => r.error).length, latency_p50_ms: pctl(rows.map((r) => r.ms), 0.5) },
    failures: rows.filter((r) => r.error || r.value.met !== r.met).map((r) => ({ id: r.id, expected: r.met, got: r.value?.met, evidence: r.value?.evidence, error: r.error })) };
}

async function evalPrice(models) {
  const { cases } = load('price_extract.json');
  const rows = await pool(cases, 3, async (c) => {
    const r = await timed(async () => { const x = extractStructured(c.html); return x.price != null ? x : { ...x, ...(await extractWithAI({ apiKey, models, html: c.html, url: 'https://eval.local/product' })) }; });
    const got = r.value || {};
    return { id: c.id, needs_ai: !!c.needs_ai, ok: !r.error && Math.abs((got.price ?? -1) - c.price) < 0.011 && (got.currency || '').toUpperCase() === c.currency, price_ok: Math.abs((got.price ?? -1) - c.price) < 0.011,
      expected: `${c.currency} ${c.price}`, got: r.error ? r.error : `${got.currency} ${got.price}`, method: got.method, ms: r.ms };
  });
  const ai = rows.filter((r) => r.needs_ai), st = rows.filter((r) => !r.needs_ai);
  return { metrics: { cases: rows.length, accuracy: rows.filter((r) => r.ok).length / rows.length, price_accuracy: rows.filter((r) => r.price_ok).length / rows.length,
      structured_accuracy: st.filter((r) => r.ok).length / (st.length || 1), ai_fallback_accuracy: ai.filter((r) => r.ok).length / (ai.length || 1), latency_p50_ms: pctl(rows.map((r) => r.ms), 0.5) },
    failures: rows.filter((r) => !r.ok).map(({ id, expected, got, method }) => ({ id, expected, got, method })) };
}

const SUITES = { planner: evalPlanner, relevance: evalRelevance, page: evalPage, price: evalPrice };

// ---------- run ----------
const modelSets = arg('models', null) ? String(arg('models')).split(',').map((m) => [m.trim()]) : [await defaultModels()];
const report = { run_at: Date.now(), runs: [] };
for (const models of modelSets) {
  const label = modelSets.length > 1 ? models[0] : `free model pool (${models.map((m) => m.split('/').pop()).join(', ')})`;
  console.log(`\n=== ${label}`);
  const suites = {};
  for (const [name, fn] of Object.entries(SUITES)) {
    if (SUITE !== 'all' && SUITE !== name) continue;
    const t = Date.now();
    try { suites[name] = await fn(models); } catch (e) { suites[name] = { error: e.message, metrics: {} }; }
    suites[name].seconds = Math.round((Date.now() - t) / 1000);
    const g = GATES[name]; const v = suites[name].metrics[g.metric];
    suites[name].gate = { metric: g.metric, min: g.min, value: v ?? null, passed: v != null && v >= g.min };
    const m = suites[name].metrics;
    console.log(`${suites[name].gate.passed ? 'PASS' : 'FAIL'}  ${name.padEnd(9)} ${g.metric}=${v != null ? v.toFixed(2) : 'n/a'} (gate ${g.min})  ` +
      Object.entries(m).filter(([k]) => k !== g.metric).map(([k, x]) => `${k}=${typeof x === 'number' && !Number.isInteger(x) ? x.toFixed(2) : x}`).join(' ') + `  [${suites[name].seconds}s]`);
    for (const f of (suites[name].failures || []).slice(0, 6)) console.log('      ✗', JSON.stringify(f).slice(0, 220));
  }
  report.runs.push({ label, models, suites, passed: Object.values(suites).every((s) => s.gate?.passed) });
}
report.passed = report.runs.every((r) => r.passed);
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, `run-${report.run_at}.json`), JSON.stringify(report, null, 2));
writeFileSync(path.join(OUT, 'latest.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.passed ? 'All quality gates passed.' : 'Some quality gates failed.'} Report: ${path.join(OUT, 'latest.json')}`);
if (GATE && !report.passed) process.exit(1);
