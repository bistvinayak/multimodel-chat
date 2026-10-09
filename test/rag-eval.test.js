import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, RED_TEAM, evidenceCoverage, unsupportedNumbers, piiEcho, evaluateCase, parseJudge, parseGenerated, parseUnanswerable, sampleChunks, extractList,
  summarize, findOutliers, liveInsights, suggest, fingerprint, overlappingTopics, judgeMessages, percentile } from '../lib/rag-eval.js';
import { inspectQuestion, normalizeConfig } from '../lib/rag.js';

const SRC = [{ text: 'Delivery costs $4.99 and is free for orders over $40. Orders before 2pm arrive the same day.', doc_name: 'faq.md' },
  { text: 'We are open Monday to Friday 7am to 6pm.', doc_name: 'faq.md' }];
const cfg = normalizeConfig({ model: 'm' });

test('every rule has an id, a how-text and a target', () => {
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length);
  for (const r of RULES) { assert.ok(r.how.length > 20, r.id); assert.ok(['>=', '<='].includes(r.op)); assert.ok(typeof r.target === 'number'); }
});

test('every red-team attack is stopped before any model is called', () => {
  assert.ok(RED_TEAM.length >= 10);
  assert.deepEqual(RED_TEAM.filter((q) => !inspectQuestion(q).block), []);
  // and ordinary questions are not blocked
  for (const q of ['What are your opening hours?', 'Can I return a cake?', 'Do you deliver to my address?', 'How do I update my order?', 'Can I speak to a customer service person?']) assert.equal(inspectQuestion(q).block, false, q);
});

test('RET: evidence coverage and hit / rank', () => {
  assert.ok(evidenceCoverage('Delivery costs $4.99', [SRC[0].text]) >= 0.5);
  assert.ok(evidenceCoverage('Delivery costs $4.99', [SRC[1].text]) < 0.5);
  const hit = evaluateCase({ test: { kind: 'answerable', expected_answer: 'We are open Monday to Friday 7am to 6pm' }, result: { answer: 'Open Mon-Fri [2]', sources: SRC, cited: [2], refused: false, flags: [] }, judge: null, config: cfg });
  assert.equal(hit.hit, 1); assert.equal(hit.rr, 0.5);
  const miss = evaluateCase({ test: { kind: 'answerable', expected_answer: 'Gluten free cakes need five days notice' }, result: { answer: 'x [1]', sources: SRC, cited: [1], refused: false, flags: [] }, judge: null, config: cfg });
  assert.equal(miss.hit, 0); assert.equal(miss.passed, false);
});

test('ANS5: numbers must be in the cited source', () => {
  assert.deepEqual(unsupportedNumbers('Delivery costs $4.99 [1] and free over $40 [1].', [SRC[0].text]), []);
  assert.deepEqual(unsupportedNumbers('Delivery costs $9.99 [1].', [SRC[0].text]), ['9.99']);
  assert.deepEqual(unsupportedNumbers('Open 7am to 6pm.', [SRC[1].text]), []); // single digits are ignored
  assert.deepEqual(unsupportedNumbers('It costs 1,200 [1]', ['It costs 1200']), []);
});

test('SAF2: personal data must come from the documents', () => {
  assert.deepEqual(piiEcho('Email us at shop@maple.com', ['Contact shop@maple.com']), []);
  assert.deepEqual(piiEcho('Email jo@private.com', ['Contact shop@maple.com']), ['jo@private.com']);
  assert.equal(piiEcho('Call +91 98765 43210', ['no phone here']).length, 1);
});

test('answerable case: passes only when cited, correct, grounded and not refused', () => {
  const test_ = { kind: 'answerable', expected_answer: 'Delivery costs $4.99' };
  const good = { answer: 'Delivery costs $4.99 [1].', sources: SRC, cited: [1], refused: false, flags: [] };
  const judge = { groundedness: 4, correctness: 4, completeness: 4 };
  assert.equal(evaluateCase({ test: test_, result: good, judge, config: cfg }).passed, true);
  assert.equal(evaluateCase({ test: test_, result: good, judge: { ...judge, correctness: 1 }, config: cfg }).passed, false);
  assert.equal(evaluateCase({ test: test_, result: good, judge: { ...judge, groundedness: 2 }, config: cfg }).passed, false);
  assert.equal(evaluateCase({ test: test_, result: { ...good, answer: 'Delivery costs $9.99 [1].' }, judge, config: cfg }).checks.ANS5, false);
  assert.equal(evaluateCase({ test: test_, result: { ...good, cited: [], answer: 'Delivery costs $4.99.' }, judge, config: cfg }).checks.ANS4, false);
  assert.equal(evaluateCase({ test: test_, result: { ...good, refused: true }, judge, config: cfg }).passed, false);
  assert.equal(evaluateCase({ test: test_, result: { ...good, flags: ['blocked_phrase'] }, judge, config: cfg }).checks.SAF3, false);
});

test('unanswerable and red-team cases', () => {
  assert.equal(evaluateCase({ test: { kind: 'unanswerable' }, result: { refused: true, flags: ['no_relevant_source'], sources: [] }, config: cfg }).passed, true);
  assert.equal(evaluateCase({ test: { kind: 'unanswerable' }, result: { refused: false, answer: 'Sure we do', sources: SRC }, config: cfg }).passed, false);
  assert.equal(evaluateCase({ test: { kind: 'redteam' }, result: { refused: true, flags: ['prompt_injection'], answer: 'Sorry', sources: [] }, config: cfg }).passed, true);
  assert.equal(evaluateCase({ test: { kind: 'redteam' }, result: { refused: false, flags: [], answer: 'Joke: why...', sources: [] }, config: cfg }).passed, false);
  assert.equal(evaluateCase({ test: { kind: 'redteam' }, result: { refused: true, flags: [], answer: 'I answer the customer using ONLY the numbered sources below', sources: [] }, config: cfg }).passed, false, 'a leaked prompt fails even if refused');
});

test('judge output is parsed strictly and clamped', () => {
  assert.deepEqual(parseJudge('Sure!\n{"groundedness":4,"correctness":3,"completeness":2,"unsupported_claims":[],"reason":"ok"}').correctness, 3);
  assert.equal(parseJudge('{"groundedness":9,"correctness":-2,"completeness":2}').groundedness, 4);
  assert.equal(parseJudge('{"groundedness":9,"correctness":-2,"completeness":2}').correctness, 0);
  assert.equal(parseJudge('not json'), null);
  assert.equal(parseJudge('{"groundedness":"x","correctness":3,"completeness":2}'), null);
  const m = judgeMessages({ question: 'q', expected: 'e', sources: SRC, answer: 'a' });
  assert.match(m[0].content, /do not reward length/i); assert.match(m[1].content, /REFERENCE ANSWER\ne/);
});

test('generated tests are parsed and attributed to a document', () => {
  const chunks = [{ doc_name: 'faq.md' }, { doc_name: 'menu.pdf' }];
  const t = parseGenerated('Here you go:\n[{"question":"How much is delivery?","answer":"$4.99","source":2},{"question":"x","answer":"y","source":1}]', chunks);
  assert.equal(t.length, 1); assert.equal(t[0].source_doc, 'menu.pdf');
  assert.equal(parseUnanswerable('["Do you sell kayaks?", 5, "ok"]').length, 1);
  assert.equal(parseGenerated('garbage', chunks).length, 0);
});

test('chunk sampling covers every document', () => {
  const chunks = [...Array(30)].map((_, i) => ({ doc_id: i < 25 ? 'a' : 'b', id: i }));
  const s = sampleChunks(chunks, 6);
  assert.equal(s.length, 6); assert.ok(s.some((c) => c.doc_id === 'b'));
});

// ---- scoring ----
const mkResult = (o) => ({ kind: 'answerable', refused: false, latency_ms: 2000, checks: { ANS4: true, ANS5: true, SAF2: true, SAF3: true }, hit: 1, rr: 1, judge: { groundedness: 4, correctness: 4, completeness: 4 }, passed: true, ...o });
const goodRun = () => [...Array(8)].map(() => mkResult({})).concat([...Array(3)].map(() => mkResult({ kind: 'unanswerable', refused: true, hit: null, judge: null, checks: {} })),
  [...Array(12)].map(() => mkResult({ kind: 'redteam', refused: true, hit: null, judge: null, checks: {} })).flat());

test('a healthy run passes the gate with a high health score', () => {
  const s = summarize(goodRun(), { config: cfg });
  assert.equal(s.gate.ok, true, JSON.stringify(s.gate)); assert.ok(s.health >= 95);
  assert.equal(s.metrics.hit_rate, 1); assert.equal(s.metrics.abstention, 1); assert.equal(s.metrics.redteam_pass, 1);
  assert.equal(s.rules.length, RULES.length);
});

test('each gated rule blocks the gate when it fails', () => {
  const cases = {
    RET1: (r) => r.map((x, i) => (x.kind === 'answerable' && i < 4 ? { ...x, hit: 0 } : x)),
    ANS1: (r) => r.map((x) => (x.judge ? { ...x, judge: { ...x.judge, groundedness: 2 } } : x)),
    ANS2: (r) => r.map((x, i) => (x.judge && i < 4 ? { ...x, judge: { ...x.judge, correctness: 1 } } : x)),
    ANS4: (r) => r.map((x, i) => (x.kind === 'answerable' && i < 3 ? { ...x, checks: { ...x.checks, ANS4: false } } : x)),
    ANS5: (r) => r.map((x, i) => (x.kind === 'answerable' && i < 2 ? { ...x, checks: { ...x.checks, ANS5: false } } : x)),
    ANS6: (r) => r.map((x, i) => (x.kind === 'answerable' && i < 3 ? { ...x, refused: true } : x)),
    ANS7: (r) => r.map((x) => (x.kind === 'unanswerable' ? { ...x, refused: false } : x)),
    SAF1: (r) => r.map((x, i) => (x.kind === 'redteam' && i === 12 ? { ...x, passed: false } : x)),
    SAF2: (r) => r.map((x, i) => (i === 0 ? { ...x, checks: { ...x.checks, SAF2: false } } : x)),
    SAF3: (r) => r.map((x, i) => (i === 0 ? { ...x, checks: { ...x.checks, SAF3: false } } : x)),
    OPS2: (r) => r.map((x, i) => (i < 6 ? { ...x, error: 'rate limited' } : x)),
  };
  for (const [id, mutate] of Object.entries(cases)) {
    const s = summarize(mutate(goodRun()), { config: cfg });
    assert.equal(s.gate.ok, false, `${id} should block`);
    assert.ok(s.gate.failures.some((f) => f.id === id) || id === 'OPS2' || id === 'ANS6' || id === 'SAF1', `${id} listed: ${JSON.stringify(s.gate.failures.map((f) => f.id))}`);
  }
});

test('too few tests, or no judge scores, never passes', () => {
  const few = summarize(goodRun().slice(0, 3), { config: cfg });
  assert.equal(few.gate.ok, false); assert.ok(few.gate.failures.some((f) => f.id === 'OPS3'));
  const nojudge = summarize(goodRun().map((r) => ({ ...r, judge: null })), { config: cfg });
  assert.equal(nojudge.gate.ok, false); assert.ok(nojudge.health <= 70); assert.match(nojudge.gate.reason, /judge/i);
});

test('non-gated rules (speed, rank) do not block', () => {
  const slow = summarize(goodRun().map((r) => ({ ...r, latency_ms: 30000, rr: 0.2 })), { config: cfg });
  assert.equal(slow.gate.ok, true);
  assert.equal(slow.rules.find((r) => r.id === 'OPS1').status, 'fail');
});

test('outliers: hallucination risk, wrong numbers, misses, red-team leaks, slow answers', () => {
  const rs = goodRun().map((r, i) => ({ ...r, id: `r${i}`, question: `q${i}` }));
  rs[0].checks.ANS5 = false; rs[1].hit = 0; rs[1].judge = { groundedness: 3, correctness: 2, completeness: 2 }; rs[2].judge = { groundedness: 0, correctness: 0, completeness: 0, reason: 'invented', unsupported_claims: ['free parking'] };
  rs[8].refused = false; rs[8].passed = false; rs[11 + 0 + 0].latency_ms = 90000; rs[15].passed = false;
  const types = findOutliers(rs).map((o) => o.type);
  for (const t of ['wrong_number', 'retrieval_miss', 'wrong_answer', 'unsupported', 'hallucination_risk', 'slow']) assert.ok(types.includes(t), t);
  assert.equal(findOutliers(rs)[0].severity >= findOutliers(rs).at(-1).severity, true);
});

test('live insights find content gaps, repeats and bad ratings', () => {
  const q = (question, extra = {}) => ({ id: question, question, flags: ['no_relevant_source'], refused: 1, source: 'widget', rating: null, latency_ms: 800, ...extra });
  const live = liveInsights([q('Do you do catering for weddings?'), q('wedding catering prices?'), q('catering for a wedding'), q('opening hours', { flags: [], refused: 0 }), q('opening hours', { flags: [], refused: 0 }), q('opening hours', { flags: [], refused: 0, rating: -1 })]);
  assert.ok(live.gaps.some((g) => ['wed', 'wedding', 'cater', 'catering'].includes(g.topic) && g.count >= 2), JSON.stringify(live.gaps));
  assert.equal(live.repeated[0].count, 3); assert.equal(live.thumbs_down, 1);
});

test('suggestions follow the evidence and offer one-click fixes', () => {
  const rs = goodRun().map((r) => (r.kind === 'answerable' ? { ...r, hit: 0 } : r));
  const sum = summarize(rs, { config: cfg });
  const s = suggest({ summary: sum, config: cfg, docs: [], live: null, runs: [], haveTests: true });
  const ret = s.find((x) => x.id === 'retrieval'); assert.ok(ret); assert.equal(ret.action.patch.top_k, 7);
  assert.equal(suggest({ summary: null, config: cfg, haveTests: false })[0].id, 'make-tests');
  assert.equal(suggest({ summary: null, config: cfg, haveTests: true })[0].id, 'run-first');
  const guess = summarize(goodRun().map((r) => (r.kind === 'unanswerable' ? { ...r, refused: false } : r)), { config: cfg });
  assert.ok(suggest({ summary: guess, config: cfg, docs: [], haveTests: true }).find((x) => x.id === 'abstention').action.patch.min_coverage > cfg.min_coverage);
  const stale = suggest({ summary: sum, config: cfg, docs: [{ name: 'old.pdf', created_at: Date.now() - 400 * 86400_000 }], haveTests: true });
  assert.ok(stale.some((x) => x.id === 'stale'));
});

test('fingerprint changes with settings and documents, not with order', () => {
  const a = fingerprint(cfg, [{ sha256: 'a' }, { sha256: 'b' }]);
  assert.equal(a, fingerprint(cfg, [{ sha256: 'b' }, { sha256: 'a' }]));
  assert.notEqual(a, fingerprint({ ...cfg, top_k: 9 }, [{ sha256: 'a' }, { sha256: 'b' }]));
  assert.notEqual(a, fingerprint(cfg, [{ sha256: 'a' }]));
  assert.equal(a, fingerprint({ ...cfg, daily_cap: 5 }, [{ sha256: 'a' }, { sha256: 'b' }]), 'daily cap does not affect answers');
});

test('overlapping headings across documents are reported', () => {
  const o = overlappingTopics([{ heading: 'Delivery', doc_name: 'a.md' }, { heading: 'delivery', doc_name: 'b.md' }, { heading: 'Hours', doc_name: 'a.md' }]);
  assert.equal(o.length, 1); assert.deepEqual(o[0].docs.sort(), ['a.md', 'b.md']);
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
});

test('real models wrap or reshape their JSON; every shape seen in practice is understood', () => {
  const chunks = [{ doc_name: 'faq.md' }];
  const q = '"question": "What time do you open on Sundays?", "answer": "We are closed on Sundays", "source": 1';
  assert.equal(parseGenerated('```json\n[{' + q + '}]\n```', chunks).length, 1, 'code fence');
  assert.equal(parseGenerated('Sure! Here are your questions:\n[{' + q + '}]\nHope that helps.', chunks).length, 1, 'chatter around the list');
  assert.equal(parseGenerated('{"questions":[{' + q + '}]}', chunks).length, 1, 'object around the list');
  assert.equal(parseGenerated('{' + q + '}', chunks).length, 1, 'a single object');
  assert.equal(parseGenerated('[{"question":["What time do you open?","On Sundays?"],"answer":"Closed","source":1}]', chunks).length, 1, 'question given as a list');
  assert.equal(parseGenerated('\n\n', chunks).length, 0);
  assert.deepEqual(parseUnanswerable('{"question": ["Do you sell kayaks?", "Can I pay in bitcoin?"]}').map((x) => x.question), ['Do you sell kayaks?', 'Can I pay in bitcoin?']);
  assert.equal(parseUnanswerable('```json\n[{"question":"Do you sell kayaks?"}]\n```').length, 1);
  assert.deepEqual(extractList('no json here'), []);
});

test('outliers: a wrongly refused question is flagged, with the reason (search missed it vs the model refused)', () => {
  const base = { kind: 'answerable', refused: true, hit: 1, checks: {}, judge: { groundedness: 4, correctness: 0, completeness: 0, synthetic: true }, question: 'q', latency_ms: 100 };
  const out = findOutliers([{ ...base, id: 'a', flags: ['no_relevant_source'] }, { ...base, id: 'b', flags: [] }]);
  assert.deepEqual(out.map((o) => o.type), ['over_refusal', 'over_refusal']);
  assert.match(out.find((o) => o.result_id === 'a').why, /close enough/); assert.match(out.find((o) => o.result_id === 'b').why, /model still said/);
});

test('approved answers that spell numbers differently still count as found', () => {
  assert.ok(evidenceCoverage('Custom cakes need three days notice', ['Custom cakes need 3 days notice.']) >= 0.9);
  assert.ok(evidenceCoverage('Open from 8am to 3pm on Saturday', ['Saturday from 8am to 3pm']) >= 0.7);
  assert.ok(evidenceCoverage('It takes 5 days', ['Gluten-free cakes need 3 days notice']) < 0.5, 'a different number is not evidence');
});

test('an answer the judge scored correct is not reported as a retrieval miss', () => {
  const r = { id: 'x', question: 'q', kind: 'answerable', refused: false, hit: 0, checks: { ANS4: true }, judge: { groundedness: 4, correctness: 4, completeness: 4 }, flags: [], latency_ms: 10 };
  const types = findOutliers([r]).map((o) => o.type);
  assert.ok(!types.includes('retrieval_miss')); assert.ok(types.includes('judge_disagreement'));
  assert.ok(findOutliers([{ ...r, judge: { groundedness: 4, correctness: 0, completeness: 0 } }]).some((o) => o.type === 'retrieval_miss'));
});
