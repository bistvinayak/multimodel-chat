import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReliability } from '../lib/reliability.js';

const NOW = 1_800_000_000_000;
const row = (model_id, status, ago = 3600_000, extra = {}) => ({ model_id, status, error_kind: status === 'rate_limited' ? 'rate_limit' : status === 'failed' ? 'provider_unavailable' : null,
  latency_ms: 2000, first_token_ms: 500, completion_tokens: 200, created_at: NOW - ago, user_id: extra.user || 'u1', ...extra });

test('a model with few answers is "new" and barely adjusted', () => {
  const r = computeReliability([row('a', 'completed'), row('a', 'failed')], { now: NOW }).get('a');
  assert.equal(r.status, 'new');
  assert.ok(Math.abs(r.adj) < 1);
});

test('a model failing most recent requests is demoted and pushed far down', () => {
  const rows = [...Array(5)].map(() => row('bad', 'rate_limited')).concat(row('bad', 'completed'));
  const r = computeReliability(rows, { now: NOW }).get('bad');
  assert.equal(r.status, 'demoted');
  assert.ok(r.adj < -10);
  assert.equal(r.limited, 5);
  assert.deepEqual(r.errors, { rate_limit: 5 });
});

test('old failures do not demote, but still lower the score', () => {
  const rows = [...Array(5)].map(() => row('old', 'failed', 3 * 86400_000)).concat([...Array(3)].map(() => row('old', 'completed', 3 * 86400_000)));
  const r = computeReliability(rows, { now: NOW }).get('old');
  assert.notEqual(r.status, 'demoted');
  assert.equal(r.status, 'unreliable');
  assert.ok(r.adj < 0);
});

test('a reliable, picked, liked model ranks above an unreliable one', () => {
  const rows = [...Array(8)].map(() => row('good', 'completed')).concat([...Array(4)].map(() => row('meh', 'failed', 3 * 86400_000)), [...Array(4)].map(() => row('meh', 'completed')));
  const m = computeReliability(rows, { now: NOW, picks: new Map([['good', 5]]), ratings: new Map([['good', { up: 3, down: 0 }]]) });
  assert.equal(m.get('good').status, 'good');
  assert.ok(m.get('good').adj > m.get('meh').adj);
  assert.ok(m.get('good').adj > 3);
});

test('stopped and in-progress answers are ignored; users are counted', () => {
  const m = computeReliability([row('x', 'stopped'), row('x', 'pending'), row('x', 'completed', 1000, { user: 'u2' }), row('x', 'completed')], { now: NOW });
  assert.equal(m.get('x').tries, 2);
  assert.equal(m.get('x').users, 2);
  assert.equal(m.get('x').latency_p50, 2000);
  assert.equal(m.get('x').tokens_per_sec, 100);
});
