import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { buildContext } from '../lib/context.js';
import { classifyError } from '../lib/openrouter.js';

function seed() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO users (id,name,email,password_hash,created_at) VALUES ('u','U','u@x.com','x',1)`).run();
  db.prepare(`INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES ('c','u','t',1,1)`).run();
  const turn = (id, msg, at) => db.prepare(`INSERT INTO turns (id,conversation_id,user_message,mode,target_models,created_at) VALUES (?,?,?,?,?,?)`).run(id, 'c', msg, 'all', '[]', at);
  const resp = (id, turnId, model, content, status = 'completed') =>
    db.prepare(`INSERT INTO responses (id,turn_id,conversation_id,model_id,content,status,created_at) VALUES (?,?,?,?,?,?,1)`).run(id, turnId, 'c', model, content, status);
  turn('t1', 'Build a research agent', 10);
  resp('a1', 't1', 'A', 'A says planner-worker');
  resp('b1', 't1', 'B', 'B says monolith');
  turn('t2', 'Only for A', 20);
  resp('a2', 't2', 'A', 'A answer two');
  return { db, turn, resp };
}

test('each model sees only its own prior answers', () => {
  const { db } = seed();
  const { messages } = buildContext(db, { conversation_id: 'c', created_at: 30, user_message: 'next' }, 'B', null, 1000, []);
  const text = JSON.stringify(messages);
  assert.ok(text.includes('B says monolith'));
  assert.ok(!text.includes('A says planner-worker'));
  assert.ok(!text.includes('A answer two'));
});

test('turns a model skipped are merged as user messages, roles alternate', () => {
  const { db } = seed();
  const { messages } = buildContext(db, { conversation_id: 'c', created_at: 30, user_message: 'next' }, 'B', null, 1000, []);
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(messages[3].content, /Only for A[\s\S]*next/);
});

test('promoted decisions reach every model, including ones that did not write them', () => {
  const { db } = seed();
  db.prepare(`INSERT INTO context_selections (id,conversation_id,response_id,selected_text,selection_type,created_at) VALUES ('s','c','a1','Use planner-worker','canonical',25)`).run();
  const { messages } = buildContext(db, { conversation_id: 'c', created_at: 30, user_message: 'next' }, 'B', null, 1000, []);
  assert.match(messages[0].content, /Use planner-worker/);
  // ...but not on turns that happened before the decision was made
  const earlier = buildContext(db, { conversation_id: 'c', created_at: 20, user_message: 'x' }, 'B', null, 1000, []);
  assert.doesNotMatch(earlier.messages[0].content, /Use planner-worker/);
});

test('long history is trimmed oldest-first and condensed, never dropping the current message', () => {
  const { db, turn, resp } = seed();
  for (let i = 0; i < 40; i++) { turn(`x${i}`, `requirement ${i} ` + 'z'.repeat(800), 100 + i); resp(`r${i}`, `x${i}`, 'B', 'y'.repeat(800)); }
  const { messages, droppedTurns, promptTokensEst } = buildContext(db, { conversation_id: 'c', created_at: 999, user_message: 'CURRENT' }, 'B', { context_length: 8000 }, 1000, []);
  assert.ok(droppedTurns > 0);
  assert.ok(promptTokensEst < 8000);
  assert.match(messages.at(-1).content, /CURRENT$/);
  assert.match(messages[0].content, /Earlier conversation \(condensed\)/);
});

test('error classification', () => {
  assert.equal(classifyError(429, { error: { message: 'x' } }).status, 'rate_limited');
  assert.equal(classifyError(402, { error: { message: 'Insufficient credits' } }).kind, 'insufficient_credits');
  assert.equal(classifyError(400, { error: { message: "This endpoint's maximum context length is 8192" } }).kind, 'context_limit');
  assert.equal(classifyError(503, 'down').kind, 'provider_unavailable');
});

import { retryAfterMs } from '../lib/openrouter.js';
import { healthOf, recordOk, recordLimited, recordBlocked, _reset } from '../lib/health.js';

test('retry-after parsing', () => {
  const h = (o) => ({ get: (k) => o[k] ?? null });
  assert.equal(retryAfterMs(h({ 'retry-after': '7' })), 7000);
  assert.equal(retryAfterMs(h({ 'x-ratelimit-reset': String(1_000_000 + 5000) }), null, 1_000_000), null); // too small to be epoch
  assert.equal(retryAfterMs(h({ 'x-ratelimit-reset': String(2e12 + 4000) }), null, 2e12), 4000);
  assert.equal(retryAfterMs(h({})), null);
  assert.equal(retryAfterMs(null, { error: { metadata: { headers: { 'X-RateLimit-Reset': String(2e12 + 9000) } } } }, 2e12), 9000);
});

test('model health: busy after a 429, ok after a success, blocked after a 403', () => {
  _reset();
  assert.equal(healthOf('m'), 'unknown');
  recordLimited('m'); assert.equal(healthOf('m'), 'busy');
  recordOk('m'); assert.equal(healthOf('m'), 'ok');
  recordLimited('m'); assert.equal(healthOf('m'), 'busy');
  assert.equal(healthOf('m', Date.now() + 4 * 60_000), 'unknown'); // busy expires
  recordBlocked('x'); assert.equal(healthOf('x'), 'blocked');
});

test('a reply tells every recipient which answer (or quoted part) is being replied to', () => {
  const { db } = seed();
  const turn = { conversation_id: 'c', created_at: 30, user_message: 'Why that?', reply_to_response: 'a1', reply_quote: 'planner-worker' };
  const own = buildContext(db, turn, 'A', null, 1000, []).messages[0].content;
  const other = buildContext(db, turn, 'B', null, 1000, []).messages[0].content;
  assert.match(own, /replying to this part of your own earlier answer\n+planner-worker/);
  assert.match(other, /written by A, another model/);
  assert.doesNotMatch(other, /A says planner-worker/); // only the quoted part is shared
});

import { summaryPlan, cleanTitle, SUMMARY_KEEP_RECENT } from '../lib/memory.js';

test('rolling summary replaces dropped turns and keeps uncovered ones condensed', () => {
  const { db, turn, resp } = seed();
  for (let i = 0; i < 30; i++) { turn(`x${i}`, `requirement ${i} ` + 'z'.repeat(900), 100 + i); resp(`r${i}`, `x${i}`, 'B', 'y'.repeat(900)); }
  const opts = { summary: { text: 'Goal: build a review analyzer. Decision: use Postgres.', upto: 115 } };
  const { messages, droppedTurns, summaryUsed, promptTokensEst } = buildContext(db, { conversation_id: 'c', created_at: 999, user_message: 'NOW' }, 'B', { context_length: 12000 }, 1000, [], [], opts);
  assert.ok(droppedTurns > 0 && summaryUsed);
  assert.match(messages[0].content, /Conversation summary so far[\s\S]*use Postgres/);
  assert.ok(promptTokensEst <= 12000 - 1000, `prompt ${promptTokensEst} must fit the budget`);
  assert.doesNotMatch(messages[0].content, /requirement 3 /); // covered by the summary, not repeated
});

test('summary plan: only when history is large, never folds the newest turns', () => {
  const small = Array.from({ length: 6 }, (_, i) => ({ user_message: 'short', created_at: i }));
  assert.equal(summaryPlan(small, null), null);
  const big = Array.from({ length: 30 }, (_, i) => ({ user_message: 'w'.repeat(2000), created_at: i }));
  const plan = summaryPlan(big, null);
  assert.equal(plan.fold.length, 30 - SUMMARY_KEEP_RECENT);
  assert.equal(plan.upto, 30 - SUMMARY_KEEP_RECENT - 1);
  assert.equal(summaryPlan(big, plan.upto), null); // nothing new to fold yet
});

test('title cleanup', () => {
  assert.equal(cleanTitle('"Code Review Benefits."'), 'Code Review Benefits');
  assert.equal(cleanTitle('Title: Planning A Research Agent\nextra'), 'Planning A Research Agent');
  assert.equal(cleanTitle('Hi'), null);
});

import { initSecrets, encrypt, decrypt } from '../lib/secrets.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('personal keys are encrypted at rest and tamper-evident', () => {
  initSecrets(mkdtempSync(path.join(tmpdir(), 'mmw-')));
  const key = 'sk-or-v1-' + 'a'.repeat(64);
  const blob = encrypt(key);
  assert.ok(!blob.includes(key) && blob.startsWith('v1:'));
  assert.notEqual(encrypt(key), blob);                  // random IV every time
  assert.equal(decrypt(blob), key);
  const parts = blob.split(':'); parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(parts.join(':')));       // GCM auth tag rejects edits
});

import { detect } from '../lib/attachments.js';

test('file detection uses magic bytes, not names', () => {
  assert.equal(detect(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), 'x.png').kind, 'image');
  assert.equal(detect(Buffer.from('%PDF-1.4\n...'), 'renamed.txt').kind, 'pdf');
  assert.equal(detect(Buffer.from('a,b\n1,2\n'), 'data.csv').kind, 'text');
  assert.equal(detect(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'x.png').mime, 'image/png');
  assert.equal(detect(Buffer.from([1, 2, 0, 4, 5]), 'notes.txt'), null);                  // binary disguised as text
  assert.equal(detect(Buffer.from('<svg><script>alert(1)</script></svg>'), 'a.svg'), null); // SVG is not accepted
  assert.equal(detect(Buffer.from('MZ\x90\x00'), 'setup.exe'), null);
});

test('attachments: vision models get image parts, others get the description; text and PDFs are inlined', () => {
  const { db } = seed();
  const ins = db.prepare(`INSERT INTO attachments (id,user_id,conversation_id,turn_id,name,kind,mime,size,sha256,path,status,text_content,description,description_model,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.prepare(`INSERT INTO turns (id,conversation_id,user_message,mode,target_models,created_at) VALUES ('t9','c','Look at these','all','[]',50)`).run();
  ins.run('img', 'u', 'c', 't9', 'chart.png', 'image', 'image/png', 10, 'h', '/x', 'ready', null, 'A bar chart titled Sales', 'vision-model', 1);
  ins.run('doc', 'u', 'c', 't9', 'report.pdf', 'pdf', 'application/pdf', 10, 'h', '/y', 'ready', 'Churn is 4.2%', null, null, 2);
  ins.run('raw', 'u', 'c', 't9', 'scan.pdf', 'pdf', 'application/pdf', 10, 'h', '/z', 'ready', null, null, null, 3);
  const turn = { id: 't9', conversation_id: 'c', created_at: 50, user_message: 'Look at these' };
  const seeing = buildContext(db, turn, 'A', { vision: true }, 1000, []);
  const blind = buildContext(db, turn, 'A', { vision: false }, 1000, []);
  const last = (r) => r.messages.at(-1).content;
  assert.ok(last(seeing).some((p) => p.type === 'image_url' && p.image_url.url === 'attachment://img'));
  assert.ok(!JSON.stringify(last(blind)).includes('image_url'));
  assert.match(JSON.stringify(last(blind)), /A bar chart titled Sales/);
  assert.match(JSON.stringify(last(seeing)), /Churn is 4\.2%/);                      // extracted PDF text inlined
  assert.ok(last(seeing).some((p) => p.type === 'file' && p.file.file_data === 'attachment://raw')); // unextracted PDF goes as a file
  assert.equal(seeing.needsFileParser, true);
  assert.ok(!JSON.stringify(seeing.messages).includes('base64'));                    // snapshots never hold file bytes
});

import { overall, CRITERIA, DEFAULT_CRITERIA, buildBrief } from '../lib/evaluator.js';

test('evaluation: overall score, default rubric, blind brief', () => {
  assert.equal(overall({ a: { value: 4 }, b: { value: 2 } }), 75);
  assert.equal(overall({ a: { value: null } }), null);
  assert.deepEqual(DEFAULT_CRITERIA, ['relevance', 'completeness', 'instruction_following', 'clarity', 'actionability']); // PRD §17
  assert.ok(CRITERIA.groundedness.noul);
  const brief = buildBrief({ question: 'How do I cut churn?', context: 'Decision: focus on onboarding' });
  assert.match(brief, /USER REQUEST:[\s\S]*cut churn[\s\S]*onboarding/);
});

import { conditionMet, parsePrice, extractStructured, parseRobots, robotsAllows } from '../lib/watch.js';

test('price watch: parsing, structured extraction, robots and alert conditions', () => {
  assert.equal(parsePrice('£1,299.50'), 1299.5);
  assert.equal(parsePrice('1.299,50 €'), 1299.5);
  assert.equal(parsePrice('12,99'), 12.99);
  assert.equal(parsePrice('Rs. 45,999'), 45999);
  const ld = '<title>x</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Kettle","offers":{"@type":"Offer","price":"39.99","priceCurrency":"USD","availability":"https://schema.org/InStock"}}]}</script>';
  assert.deepEqual([extractStructured(ld).price, extractStructured(ld).currency, extractStructured(ld).title, extractStructured(ld).in_stock], [39.99, 'USD', 'Kettle', true]);
  assert.equal(extractStructured('<meta property="product:price:amount" content="19.00"><meta property="product:price:currency" content="EUR">').price, 19);
  const rules = parseRobots('User-agent: *\nDisallow: /cart\nDisallow: /*?add-to-cart=\nAllow: /cart/public\n');
  assert.equal(robotsAllows(rules, '/shop/kettle'), true);
  assert.equal(robotsAllows(rules, '/cart/checkout'), false);
  assert.equal(robotsAllows(rules, '/cart/public/x'), true);
  assert.equal(robotsAllows(rules, '/shop?add-to-cart=5'), false);
  const money = (p) => `$${p.toFixed(2)}`;
  assert.match(conditionMet({ condition: 'below', target_price: 50 }, 45, money), /\$45\.00.*\$50\.00/);
  assert.equal(conditionMet({ condition: 'below', target_price: 50, last_notified_price: 45 }, 46), null); // no repeat alert unless a new low
  assert.match(conditionMet({ condition: 'drop_pct', drop_pct: 10, baseline_price: 100 }, 85, money), /dropped 15% to \$85\.00/);
  assert.equal(conditionMet({ condition: 'drop_pct', drop_pct: 10, baseline_price: 100 }, 95), null);
  assert.match(conditionMet({ condition: 'any_drop', last_price: 20 }, 19), /from 20 to 19/);
});
