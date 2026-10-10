// End to end: the real server with a real (fake) SMTP server, walking the whole forgot / reset flow and its security rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fakeSmtp, bodyOf, headerOf } from './helpers-smtp.js';

let smtp, child, dir, base, dbFile, cookie = '';
const PORT = 4400 + Math.floor(Math.random() * 90);
let clientIp = '10.0.0.1';
const call = async (method, url, body, headers = {}) => {
  const r = await fetch(base + url, { method, headers: { 'X-Forwarded-For': clientIp, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
const linkOf = (m) => bodyOf(m).match(/https?:\/\/\S+/)[0];
const tokenOf = (m) => linkOf(m).split('/#/reset/')[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const nextEmail = () => { clientIp = `10.0.${n % 250}.${(n >> 8) + 1}`; return `user${++n}@example.com`; };
const signup = async (email, password = 'old-password-1') => { cookie = ''; const r = await call('POST', '/api/signup', { name: 'Priya', email, password }); assert.equal(r.status, 201); };
const login = (email, password) => { cookie = ''; return call('POST', '/api/login', { email, password }); };

before(async () => {
  smtp = await fakeSmtp({ user: 'mailer', pass: 's3cret' });
  dir = mkdtempSync(path.join(tmpdir(), 'pwreset-')); dbFile = path.join(dir, 'app.db'); base = `http://127.0.0.1:${PORT}`;
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: path.resolve('.'), stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: dbFile, APP_SECRET: 'e'.repeat(64), OPENROUTER_API_KEY: 'x', ADMIN_EMAILS: '',
      PUBLIC_ORIGIN: 'https://vinayakbist.com', BASE_PATH: '', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'none', SMTP_USER: 'mailer', SMTP_PASS: 's3cret', MAIL_FROM: 'Vigyan <no-reply@vinayakbist.com>' } });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await sleep(100); }
});
after(async () => { child?.kill(); await smtp?.close(); rmSync(dir, { recursive: true, force: true }); });

test('the full journey: ask for a link, reset, old password dead, new one works, everywhere signed out', async () => {
  const email = nextEmail(); await signup(email);
  const otherDevice = cookie; // a second, still-open session
  const asked = await call('POST', '/api/forgot-password', { email });
  assert.equal(asked.status, 200); assert.match(asked.body.message, /If an account exists/);
  const mails = await smtp.waitFor(smtp.inbox.length + 1); const m = mails.at(-1);
  assert.deepEqual(m.rcpt, [email]); assert.equal(headerOf(m, 'Subject'), 'Reset your password'); assert.equal(m.from, 'no-reply@vinayakbist.com');
  const link = linkOf(m);
  assert.match(link, /^https:\/\/vinayakbist\.com\/#\/reset\/[A-Za-z0-9_-]{43}$/, 'built from PUBLIC_ORIGIN, token in the fragment');
  const token = tokenOf(m);

  assert.equal((await call('POST', '/api/reset-password/check', { token })).body.valid, true);
  assert.equal((await call('POST', '/api/reset-password', { token, password: 'short' })).status, 400, 'weak password refused, link still usable');
  assert.equal((await call('POST', '/api/reset-password/check', { token })).body.valid, true);
  assert.equal((await call('POST', '/api/reset-password', { token, password: 'a-brand-new-password' })).status, 200);

  assert.equal((await login(email, 'old-password-1')).status, 401, 'old password no longer works');
  assert.equal((await login(email, 'a-brand-new-password')).status, 200, 'new password works');
  cookie = otherDevice; assert.equal((await call('GET', '/api/me')).status, 401, 'other open sessions were signed out');
  const notice = (await smtp.waitFor(smtp.inbox.length + 1, 3000)).at(-1);
  assert.equal(headerOf(notice, 'Subject'), 'Your password was changed'); assert.deepEqual(notice.rcpt, [email]);
});

test('a link works once only', async () => {
  const email = nextEmail(); await signup(email); const before = smtp.inbox.length;
  await call('POST', '/api/forgot-password', { email }); await smtp.waitFor(before + 1);
  const token = tokenOf(smtp.inbox.at(-1));
  assert.equal((await call('POST', '/api/reset-password', { token, password: 'first-new-password' })).status, 200);
  const again = await call('POST', '/api/reset-password', { token, password: 'second-new-password' });
  assert.equal(again.status, 400); assert.match(again.body.error, /invalid or has expired/);
  assert.equal((await call('POST', '/api/reset-password/check', { token })).body.valid, false);
  assert.equal((await login(email, 'first-new-password')).status, 200); assert.equal((await login(email, 'second-new-password')).status, 401);
});

test('links expire after an hour', async () => {
  const email = nextEmail(); await signup(email); const before = smtp.inbox.length;
  await call('POST', '/api/forgot-password', { email }); await smtp.waitFor(before + 1);
  const token = tokenOf(smtp.inbox.at(-1));
  const db = new DatabaseSync(dbFile); db.prepare('UPDATE password_resets SET expires_at=?').run(Date.now() - 1000); db.close();
  assert.equal((await call('POST', '/api/reset-password/check', { token })).body.valid, false);
  assert.equal((await call('POST', '/api/reset-password', { token, password: 'a-brand-new-password' })).status, 400);
  assert.equal((await login(email, 'old-password-1')).status, 200, 'password unchanged');
});

test('asking again cancels the older link', async () => {
  const email = nextEmail(); await signup(email); let before = smtp.inbox.length;
  await call('POST', '/api/forgot-password', { email }); await smtp.waitFor(before + 1); const first = tokenOf(smtp.inbox.at(-1)); before = smtp.inbox.length;
  await call('POST', '/api/forgot-password', { email }); await smtp.waitFor(before + 1); const second = tokenOf(smtp.inbox.at(-1));
  assert.notEqual(first, second);
  assert.equal((await call('POST', '/api/reset-password/check', { token: first })).body.valid, false);
  assert.equal((await call('POST', '/api/reset-password/check', { token: second })).body.valid, true);
});

test('nothing reveals whether an email has an account: same answer, no email for strangers', async () => {
  const known = nextEmail(); await signup(known); const before = smtp.inbox.length;
  const a = await call('POST', '/api/forgot-password', { email: known });
  const b = await call('POST', '/api/forgot-password', { email: 'nobody-at-all@example.com' });
  const c = await call('POST', '/api/forgot-password', { email: 'not an email' });
  const d = await call('POST', '/api/forgot-password', {});
  for (const r of [a, b, c, d]) { assert.equal(r.status, 200); assert.deepEqual(r.body, a.body); }
  await smtp.waitFor(before + 1); await sleep(400);
  assert.equal(smtp.inbox.length - before, 1, 'only the real account got an email');
  assert.deepEqual(smtp.inbox.at(-1).rcpt, [known]);
  assert.equal(smtp.inbox.some((m) => m.rcpt.includes('nobody-at-all@example.com')), false);
});

test('email address is matched without regard to case or spaces', async () => {
  const email = nextEmail(); await signup(email); const before = smtp.inbox.length;
  await call('POST', '/api/forgot-password', { email: `  ${email.toUpperCase()} ` });
  await smtp.waitFor(before + 1); assert.deepEqual(smtp.inbox.at(-1).rcpt, [email]);
});

test('limits: three links per email per hour, and wrong tokens are rate limited', async () => {
  const email = nextEmail(); await signup(email); const before = smtp.inbox.length;
  for (let i = 0; i < 5; i++) await call('POST', '/api/forgot-password', { email });
  await smtp.waitFor(before + 3); await sleep(500);
  assert.equal(smtp.inbox.length - before, 3, 'the 4th and 5th request sent nothing');
  let blocked = 0;
  for (let i = 0; i < 40; i++) if ((await call('POST', '/api/reset-password/check', { token: `guess${i}`.padEnd(43, 'x') })).status === 429) blocked++;
  assert.ok(blocked >= 5, `guessing was cut off (${blocked} blocked)`);
});

test('a forged Host header cannot redirect the link to another site', async () => {
  const email = nextEmail(); await signup(email); const before = smtp.inbox.length;
  await call('POST', '/api/forgot-password', { email }, { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' });
  await smtp.waitFor(before + 1);
  assert.ok(linkOf(smtp.inbox.at(-1)).startsWith('https://vinayakbist.com/#/reset/'));
  assert.ok(!smtp.inbox.at(-1).data.includes('evil.example'));
});

test('tokens are stored hashed, never in plain text', async () => {
  const email = nextEmail(); await signup(email); const before = smtp.inbox.length;
  await call('POST', '/api/forgot-password', { email }); await smtp.waitFor(before + 1);
  const token = tokenOf(smtp.inbox.at(-1));
  const db = new DatabaseSync(dbFile); const rows = db.prepare('SELECT token_hash FROM password_resets').all(); db.close();
  assert.ok(rows.length > 0 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash) && r.token_hash !== token));
});

/** Start a second server with its own settings, to test configurations the main one does not have. */
async function startServer(port, env) {
  const d = mkdtempSync(path.join(tmpdir(), 'pwreset2-')); let out = '';
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: path.join(d, 'app.db'), APP_SECRET: 'f'.repeat(64), OPENROUTER_API_KEY: 'x', ADMIN_EMAILS: '', BASE_PATH: '', ...env } });
  c.stdout.on('data', (x) => (out += x)); c.stderr.on('data', (x) => (out += x));
  const b = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(b + '/healthz')).ok) break; } catch {} await sleep(100); }
  const post = async (url, body, cookieHeader) => { const r = await fetch(b + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { cookie: cookieHeader } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { b, post, out: () => out, stop: () => { c.kill(); rmSync(d, { recursive: true, force: true }); } };
}

test('a mail server that refuses the message: same answer to the caller, nothing leaked, server stays up', async () => {
  const refusing = await fakeSmtp({ rejectRcpt: true });
  const s = await startServer(PORT + 100, { PUBLIC_ORIGIN: 'https://vinayakbist.com', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(refusing.port), SMTP_SECURE: 'none', MAIL_FROM: 'no-reply@vinayakbist.com' });
  try {
    await s.post('/api/signup', { name: 'P', email: 'p@example.com', password: 'old-password-1' });
    const r = await s.post('/api/forgot-password', { email: 'p@example.com' });
    assert.equal(r.status, 200); assert.match(r.body.message, /If an account exists/);
    await sleep(600);
    assert.equal(refusing.inbox.length, 0);
    assert.match(s.out(), /could not send/, 'the operator is told in the log');
    assert.ok(!/#\/reset\//.test(s.out()), 'and the log never contains a working link');
    assert.ok((await fetch(s.b + '/healthz')).ok, 'still serving');
  } finally { s.stop(); await refusing.close(); }
});

test('no email configured: a public site never writes the link to its logs; a local one does, for development', async () => {
  const pub = await startServer(PORT + 101, { PUBLIC_ORIGIN: 'https://vinayakbist.com' });
  const local = await startServer(PORT + 102, {});
  try {
    for (const s of [pub, local]) { await s.post('/api/signup', { name: 'P', email: 'p@example.com', password: 'old-password-1' }); assert.equal((await s.post('/api/forgot-password', { email: 'p@example.com' })).status, 200); }
    await sleep(600);
    assert.ok(!/#\/reset\//.test(pub.out()), 'public: no link in the log'); assert.match(pub.out(), /SMTP is not configured/);
    assert.match(local.out(), /Reset link for p@example\.com: http:\/\/127\.0\.0\.1:\d+\/#\/reset\/[\w-]{43}/, 'local: link printed for development');
    // and that logged link really works
    const token = local.out().match(/#\/reset\/([\w-]{43})/)[1];
    assert.equal((await local.post('/api/reset-password', { token, password: 'dev-new-password' })).status, 200);
  } finally { pub.stop(); local.stop(); }
});

test('script and style URLs change with their content, so a CDN can never serve a stale copy', async () => {
  const { createHash } = await import('node:crypto'); const { readFileSync } = await import('node:fs');
  const h = (...f) => { const x = createHash('sha256'); for (const n of f) x.update(readFileSync(path.join('public', n))); return x.digest('hex').slice(0, 8); };
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes(`src="app.js?v=${h('app.js', 'rag.js')}"`), 'app.js carries a hash of itself and rag.js');
  assert.ok(html.includes(`href="styles.css?v=${h('styles.css')}"`));
  const js = await (await fetch(`${base}/app.js?v=${h('app.js', 'rag.js')}`)).text();
  assert.ok(js.includes(`from './rag.js?v=${h('rag.js')}'`), 'the import of rag.js is versioned too');
  assert.ok(!js.includes("from './rag.js'"));
});
