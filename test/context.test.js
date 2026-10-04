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
