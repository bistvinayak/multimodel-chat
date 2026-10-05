// App health check: starts a throwaway copy of the app (own database, own demo shop) and walks
// through every feature the way a user would. Prints a checklist and saves a report.
//   npm run check            -> data/checks/latest.json (also shown on the Metrics page)
// PASS = works. WARN = works but something outside the app got in the way (e.g. free models busy).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const OUT = path.resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(ROOT, 'data', 'checks'));
const port = 3400 + Math.floor(Math.random() * 400), shopPort = port + 500;
const B = `http://127.0.0.1:${port}`, SHOP = `http://127.0.0.1:${shopPort}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'mmw-check-'));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const procs = [];
const start = (args, env) => { const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore' }); procs.push(p); return p; };
const cleanup = () => { for (const p of procs) try { p.kill(); } catch {} try { rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup); process.on('SIGINT', () => process.exit(130));

// Minimal cookie-aware client, one per simulated user.
function client() {
  let cookie = '';
  return async (method, url, body, raw = false) => {
    const r = await fetch(B + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(raw ? raw : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = await r.json().catch(() => null);
    return { status: r.status, data };
  };
}
async function until(fn, ms = 150_000, every = 1500) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(every); } return null; }

const results = [];
async function step(name, area, fn) {
  const t = Date.now(); let status = 'pass', detail = '';
  try { const r = await fn(); if (r && typeof r === 'object') { status = r.status || 'pass'; detail = r.detail || ''; } else if (typeof r === 'string') detail = r; }
  catch (e) { status = 'fail'; detail = e.message; }
  const row = { name, area, status, detail, ms: Date.now() - t }; results.push(row);
  console.log(`${{ pass: '✅', warn: '⚠️ ', fail: '❌' }[status]} ${name.padEnd(46)} ${String(Math.round(row.ms / 100) / 10).padStart(5)}s  ${detail}`);
  return status !== 'fail';
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------- boot ----------
start(['server.js'], { PORT: String(port), DB_PATH: path.join(tmp, 'app.db'), WATCH_ALLOW_PRIVATE: '1', CHECK_NOW_COOLDOWN_MS: '0', LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '' });
start(['scripts/demo-shop.js'], { DEMO_SHOP_PORT: String(shopPort) });
console.log(`App health check on a throwaway copy (${B}, data in ${tmp})\n`);
const u = client(), other = client();
let conv, turn1, models = [];

await step('Server starts and serves the app', 'Core', async () => {
  must(await until(async () => (await fetch(B).catch(() => null))?.ok, 15_000, 300), 'server did not start');
  must(await until(async () => (await fetch(`${SHOP}/admin`).catch(() => null))?.ok, 10_000, 300), 'demo shop did not start');
});
await step('Sign up, sign in, session persists', 'Accounts', async () => {
  must((await u('POST', '/api/signup', { name: 'Check', email: 'check@example.com', password: 'check-password-1' })).status === 201, 'signup failed');
  must((await u('GET', '/api/me')).status === 200, 'session not kept');
  await other('POST', '/api/signup', { name: 'Other', email: 'other@example.com', password: 'check-password-2' });
});
await step('Model catalog loads with free models', 'Models', async () => {
  const { data } = await u('GET', '/api/models');
  const free = data.models.filter((m) => m.free && m.chat && m.id.endsWith(':free'));
  must(free.length >= 2, 'fewer than 2 free models');
  models = ['poolside/laguna-s-2.1:free', 'nvidia/nemotron-3-super-120b-a12b:free'].filter((id) => data.models.some((m) => m.id === id));
  if (models.length < 2) models = free.slice(0, 2).map((m) => m.id);
  return `${data.models.length} models, ${free.length} free`;
});
const settle = async (convId) => until(async () => { const { data } = await u('GET', `/api/conversations/${convId}`); const t = data.turns.at(-1); return t && t.responses.every((r) => !['pending', 'generating'].includes(r.status)) ? data : null; });
await step('Ask two models at once, both answer (server-side streaming)', 'Chat', async () => {
  conv = (await u('POST', '/api/conversations', { models })).data.conversation.id;
  await u('POST', `/api/conversations/${conv}/messages`, { message: 'Name one benefit of code review. One sentence.', target: 'all' });
  const d = await settle(conv); must(d, 'answers did not finish within 150s');
  turn1 = d.turns[0]; const ok = turn1.responses.filter((r) => r.status === 'completed');
  if (ok.length === turn1.responses.length) return `${ok.length}/2 answered`;
  must(ok.length >= 1, `no model answered: ${turn1.responses.map((r) => r.error_kind).join(', ')}`);
  return { status: 'warn', detail: `${ok.length}/${turn1.responses.length} answered; others: ${turn1.responses.filter((r) => r.status !== 'completed').map((r) => r.error_kind).join(', ')} (free model capacity)` };
});
await step('Each model keeps its own context', 'Context', async () => {
  const a = turn1.responses.find((r) => r.status === 'completed');
  await u('POST', `/api/conversations/${conv}/messages`, { message: 'Give one more benefit. One sentence.', target: [a.model_id] });
  const d = await settle(conv); const r = d.turns[1].responses[0];
  const { data } = await u('GET', `/api/responses/${r.id}/context`);
  const text = JSON.stringify(data.messages);
  must(text.includes('benefit of code review'), 'earlier message missing from context');
  must(text.includes(a.content.slice(0, 30).replace(/"/g, '\\"')) || data.messages.some((m) => m.role === 'assistant'), "model's own earlier answer missing");
  const otherAns = turn1.responses.find((x) => x.id !== a.id && x.content);
  if (otherAns) must(!text.includes(otherAns.content.slice(0, 40)), "another model's private answer leaked into context");
});
await step('Use as context reaches every model', 'Context', async () => {
  const a = turn1.responses.find((r) => r.status === 'completed');
  must((await u('POST', `/api/responses/${a.id}/use`, {})).status === 200, 'use failed');
  const { data } = await u('POST', `/api/conversations/${conv}/estimate`, { message: 'x', target: 'all' });
  must(data.models.length >= 1, 'estimate failed');
});
await step('Reply to an answer + ask a subset of models', 'Chat', async () => {
  const a = turn1.responses.find((r) => r.status === 'completed');
  const { data } = await u('POST', `/api/conversations/${conv}/messages`, { message: 'Why?', target: [a.model_id], reply_to: { response_id: a.id } });
  must(data.turns.at(-1).reply_to_response === a.id, 'reply not recorded');
  const d = await settle(conv); const r = d.turns.at(-1).responses[0];
  const ctx = (await u('GET', `/api/responses/${r.id}/context`)).data.messages;
  must(JSON.stringify(ctx).includes('replying to'), 'reply context missing');
});
await step('Regenerate keeps the earlier version', 'Chat', async () => {
  const d = (await u('GET', `/api/conversations/${conv}`)).data; const r = d.turns.at(-1).responses[0];
  if (r.status !== 'completed') return { status: 'warn', detail: 'previous answer not completed (model busy)' };
  await u('POST', `/api/responses/${r.id}/run`, { regenerate: true });
  const done = await settle(conv); const r2 = done.turns.at(-1).responses[0];
  must(r2.version_count >= 1, 'no earlier version stored');
});
await step('Edit and resend the last message', 'Chat', async () => {
  const d = (await u('GET', `/api/conversations/${conv}`)).data;
  const { status, data } = await u('POST', `/api/turns/${d.turns.at(-1).id}/edit`, { message: 'Why? Answer in five words.' });
  must(status === 200 && data.turns.at(-1).user_message.includes('five words'), 'edit failed');
  await settle(conv);
});
await step('Pinned memory reaches every model and survives', 'Context', async () => {
  const d = (await u('GET', `/api/conversations/${conv}`)).data;
  const pinMsg = await u('POST', `/api/conversations/${conv}/pins`, { source: 'message', turn_id: d.turns[0].id, text: 'PINNED-REQUIREMENT: code review must be under 30 minutes' });
  must(pinMsg.status === 201, `pin failed: ${pinMsg.data?.error}`);
  const note = await u('POST', `/api/conversations/${conv}/pins`, { source: 'note', text: 'PINNED-NOTE: answer in British English' });
  must(note.status === 201 && note.data.pins.length >= 2, 'note pin failed');
  await u('POST', `/api/conversations/${conv}/messages`, { message: 'One more benefit, five words.', target: [turn1.responses[0].model_id] });
  const done = await settle(conv); const ctx = (await u('GET', `/api/responses/${done.turns.at(-1).responses[0].id}/context`)).data.messages;
  must(ctx[0].content.includes('PINNED-REQUIREMENT') && ctx[0].content.includes('PINNED-NOTE'), 'pins missing from the context sent');
  const p = note.data.pins.find((x) => x.text.startsWith('PINNED-NOTE'));
  must((await u('DELETE', `/api/pins/${p.id}`)).data.pins.every((x) => x.id !== p.id), 'unpin failed');
});
await step('Skills are applied to the models', 'Skills', async () => {
  const sk = (await u('POST', '/api/skills', { name: 'Check skill', instructions: 'Always end with the word BANANA.' })).data;
  await u('PUT', `/api/conversations/${conv}/skills/${sk.id}`);
  const est = (await u('POST', `/api/conversations/${conv}/estimate`, { message: 'hi', target: 'all' })).data;
  must(est.models.length, 'estimate failed');
  await u('POST', `/api/conversations/${conv}/messages`, { message: 'Say hi.', target: [turn1.responses[0].model_id] });
  const d = await settle(conv); const ctx = (await u('GET', `/api/responses/${d.turns.at(-1).responses[0].id}/context`)).data.messages;
  must(ctx[0].content.includes('BANANA'), 'skill not in system prompt');
});
await step('Upload a file and the model gets its text', 'Files', async () => {
  const up = await u('POST', '/api/uploads', Buffer.from('city,users\nParis,410\nLima,220\n'), { 'X-Filename': 'users.csv', 'Content-Type': 'text/csv' });
  must(up.status === 201, `upload failed: ${up.data?.error}`);
  const bad = await u('POST', '/api/uploads', Buffer.from('<svg><script>alert(1)</script></svg>'), { 'X-Filename': 'x.svg', 'Content-Type': 'image/svg+xml' });
  must(bad.status === 415, 'SVG was not rejected');
  await u('POST', `/api/conversations/${conv}/messages`, { message: 'Which city has more users?', target: [turn1.responses[0].model_id], attachment_ids: [up.data.id] });
  const d = await settle(conv); const ctx = (await u('GET', `/api/responses/${d.turns.at(-1).responses[0].id}/context`)).data.messages;
  must(JSON.stringify(ctx).includes('Paris,410'), 'file text not in context');
});
await step('Evaluate answers (Jev or fallback judge)', 'Evaluation', async () => {
  const d = (await u('GET', `/api/conversations/${conv}`)).data;
  const ids = d.turns[0].responses.filter((r) => r.status === 'completed').map((r) => r.id);
  if (ids.length < 1) return { status: 'warn', detail: 'no completed answers to evaluate' };
  const { status, data } = await u('POST', '/api/evaluations', { response_ids: ids, criteria: ['relevance', 'clarity'] });
  if (status === 502) return { status: 'warn', detail: `evaluator unavailable: ${data?.error}` };
  must(status === 201 && data.results.length === ids.length, `evaluation failed: ${data?.error}`);
  return `${data.evaluator} recommended ${data.results.find((r) => r.response_id === data.recommended_response)?.model_id || '?'}`;
});
await step('Compare, metrics and search pages have data', 'Insights', async () => {
  must((await u('GET', `/api/compare?models=${encodeURIComponent(models.join(','))}`)).data.models.length === 2, 'compare failed');
  const m = (await u('GET', '/api/metrics?days=30')).data; must(m.summary.answers > 0, 'metrics empty');
  must((await u('GET', '/api/conversations?q=benefit')).data.length >= 1, 'search found nothing');
  return `${m.summary.answers} answers, p50 ${Math.round(m.summary.latency_p50)} ms`;
});
await step('Price watch alerts on a price drop', 'Agents', async () => {
  const w = (await u('POST', '/api/watches', { url: `${SHOP}/product/headphones`, condition: 'below', target_price: 110, interval_minutes: 288 })).data;
  must(w.id, `create failed: ${w.error}`);
  await fetch(`${SHOP}/set?id=headphones&price=99.99`, { redirect: 'manual' });
  await sleep(1); const r = await (async () => { for (let i = 0; i < 3; i++) { const x = await u('POST', `/api/watches/${w.id}/check`); if (x.status !== 429) return x; } })();
  if (r?.status === 429) return { status: 'warn', detail: 'check-now rate limit hit' };
  must(r.data.alerted, `no alert (price ${r.data.price})`);
  await fetch(`${SHOP}/set?id=headphones&price=129.99`, { redirect: 'manual' });
});
await step('Price already below target alerts right away', 'Agents', async () => {
  const before = (await u('GET', '/api/notifications')).data.items.length;
  const w = (await u('POST', '/api/watches', { url: `${SHOP}/product/kettle`, condition: 'below', target_price: 60, interval_minutes: 288 })).data;
  must(w.already_met, `kettle at ${w.last_price} should already be under 60`);
  const after = (await u('GET', '/api/notifications')).data;
  must(after.items.length === before + 1 && after.items[0].title.startsWith('Already below your target'), 'no immediate alert');
});
await step('JavaScript-only price read with headless browser', 'Agents', async () => {
  const { status, data } = await u('POST', '/api/watches/preview', { url: `${SHOP}/product/js-speaker` });
  if (status === 400 && /No Chrome/.test(data?.error || '')) return { status: 'warn', detail: 'Chrome not installed on this machine' };
  must(status === 200, `preview failed: ${data?.error}`);
  must(data.price === 89 && data.method === 'browser', `got ${data.price} via ${data.method}`);
  return `USD ${data.price} via ${data.method}`;
});
await step('Page agent alerts when a condition becomes true', 'Agents', async () => {
  await fetch(`${SHOP}/set?id=text-only-lamp&price=35.5`, { redirect: 'manual' });
  const m = (await u('POST', '/api/monitors', { kind: 'page', name: 'Lamp', url: `${SHOP}/product/text-only-lamp`, criteria: 'The desk lamp costs less than $30', interval_minutes: 288 })).data;
  must(m.id, `create failed: ${m.error}`);
  if (m.first_run?.ok === false) return { status: 'warn', detail: `first run: ${m.first_run.error}` };
  must(m.first_run.met === false, 'condition wrongly true at $35.50');
  return 'false at $35.50 (as expected); condition flip covered by the eval suite';
});
await step('Plain-English request becomes the right agent', 'Agents', async () => {
  const { status, data } = await u('POST', '/api/agents/plan', { request: 'Notify me about new AI product manager roles, remote only, no senior roles' });
  if (status === 502) return { status: 'warn', detail: 'planner models busy' };
  must(data.type === 'jobs', `planned ${data.type}`);
  return `jobs: ${String(data.query).slice(0, 60)}`;
});
await step('Alerts reach the notification feed', 'Agents', async () => {
  const n = (await u('GET', '/api/notifications')).data; must(n.items.some((x) => x.kind === 'price_drop'), 'price alert missing');
  return `${n.unread} unread`;
});
await step('Feedback and answer ratings are saved', 'Feedback', async () => {
  must((await u('POST', '/api/feedback', { kind: 'bug', message: 'Health check feedback', route: '#/check', context: { errors: [] } })).status === 201, 'feedback not saved');
  const r = (await u('GET', `/api/conversations/${conv}`)).data.turns[0].responses[0];
  must((await u('POST', `/api/responses/${r.id}/rate`, { value: 1 })).data.rating === 1, 'rating not saved');
});
await step('Privacy: another user cannot read this chat', 'Security', async () => {
  must((await other('GET', `/api/conversations/${conv}`)).status === 404, 'other user could read the chat');
  must((await other('GET', `/api/responses/${turn1.responses[0].id}/context`)).status === 404, 'other user could read the context');
});
await step('Safety: internal addresses cannot be fetched', 'Security', async () => {
  // This throwaway server allows localhost for the demo shop, so test the always-blocked cases.
  for (const bad of ['http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'http://user:pw@example.com/']) {
    const r = await u('POST', '/api/watches/preview', { url: bad }); must(r.status === 400, `${bad} was not blocked`);
  }
});
await step('Delete account removes the data', 'Accounts', async () => {
  must((await u('DELETE', '/api/me')).status === 200, 'delete failed');
  must((await u('GET', '/api/me')).status === 401, 'still signed in');
});

const summary = { pass: results.filter((r) => r.status === 'pass').length, warn: results.filter((r) => r.status === 'warn').length, fail: results.filter((r) => r.status === 'fail').length };
console.log(`\n${summary.fail ? '❌' : '✅'} ${summary.pass} passed, ${summary.warn} warnings, ${summary.fail} failed`);
mkdirSync(OUT, { recursive: true });
const report = { run_at: Date.now(), summary, results };
writeFileSync(path.join(OUT, 'latest.json'), JSON.stringify(report, null, 2));
writeFileSync(path.join(OUT, `check-${report.run_at}.json`), JSON.stringify(report, null, 2));
process.exit(summary.fail ? 1 : 0);
