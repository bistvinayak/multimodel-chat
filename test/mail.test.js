import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendMail, mailConfig, buildMessage } from '../lib/mail.js';
import { fakeSmtp, selfSigned, bodyOf, headerOf } from './helpers-smtp.js';

let certs; before(() => { certs = selfSigned(); });
const cfgFor = (srv, extra = {}) => ({ host: '127.0.0.1', port: srv.port, secure: 'none', user: '', pass: '', from: 'Vigyan <no-reply@example.com>', ...extra });

test('config: defaults follow the port, and missing settings mean "email off"', () => {
  assert.equal(mailConfig({}), null);
  assert.equal(mailConfig({ SMTP_HOST: 'smtp.example.com' }), null, 'needs MAIL_FROM too');
  assert.equal(mailConfig({ SMTP_HOST: 'h', MAIL_FROM: 'a@b.co' }).secure, 'tls');
  assert.equal(mailConfig({ SMTP_HOST: 'h', MAIL_FROM: 'a@b.co', SMTP_PORT: '587' }).secure, 'starttls');
  assert.equal(mailConfig({ SMTP_HOST: 'h', MAIL_FROM: 'a@b.co', SMTP_PORT: '2525' }).secure, 'none');
  assert.equal(mailConfig({ SMTP_HOST: 'h', MAIL_FROM: 'a@b.co', SMTP_SECURE: 'starttls', SMTP_PORT: '25' }).secure, 'starttls');
});

test('sends a message with login, correct envelope, headers and an intact body', async () => {
  const srv = await fakeSmtp({ user: 'mailer', pass: 's3cret' });
  try {
    await sendMail({ to: 'priya@example.com', subject: 'Reset your password', text: 'Hello Priya,\n\n.starts with a dot\nhttps://x.test/#/reset/abc' }, cfgFor(srv, { user: 'mailer', pass: 's3cret' }));
    const [m] = await srv.waitFor(1);
    assert.equal(m.from, 'no-reply@example.com'); assert.deepEqual(m.rcpt, ['priya@example.com']); assert.ok(m.authed);
    assert.equal(headerOf(m, 'To'), 'priya@example.com'); assert.equal(headerOf(m, 'Subject'), 'Reset your password'); assert.equal(headerOf(m, 'From'), 'Vigyan <no-reply@example.com>');
    assert.match(headerOf(m, 'Message-ID'), /^<[0-9a-f]+@example\.com>$/); assert.ok(headerOf(m, 'Date'));
    assert.equal(bodyOf(m), 'Hello Priya,\r\n\r\n.starts with a dot\r\nhttps://x.test/#/reset/abc');
    assert.ok(!srv.log.join('\n').includes('s3cret'), 'the password never appears in plain text');
  } finally { await srv.close(); }
});

test('non-English text survives, in the subject and the body', async () => {
  const srv = await fakeSmtp();
  try {
    await sendMail({ to: 'a@example.com', subject: 'पासवर्ड रीसेट', text: 'नमस्ते, café ☕' }, cfgFor(srv));
    const [m] = await srv.waitFor(1);
    assert.match(headerOf(m, 'Subject'), /^=\?UTF-8\?B\?/);
    assert.equal(Buffer.from(headerOf(m, 'Subject').slice(10, -2), 'base64').toString(), 'पासवर्ड रीसेट');
    assert.equal(bodyOf(m), 'नमस्ते, café ☕');
  } finally { await srv.close(); }
});

test('user-influenced text can never add headers or recipients', async () => {
  const srv = await fakeSmtp();
  try {
    for (const to of ['a@example.com\r\nBcc: evil@example.com', 'a@example.com>\r\nRCPT TO:<evil@example.com', 'a b@example.com', 'a@example.com,b@example.com', '<a@example.com>', '']) {
      await assert.rejects(() => sendMail({ to, subject: 's', text: 't' }, cfgFor(srv)), /Invalid recipient/, JSON.stringify(to));
    }
    await sendMail({ to: 'a@example.com', subject: 'Hi\r\nBcc: evil@example.com', text: 'x' }, cfgFor(srv));
    const [m] = await srv.waitFor(1);
    assert.equal(m.data.split('\r\n\r\n')[0].split('\r\n').filter((l) => /^bcc:/i.test(l)).length, 0, 'no injected header');
    assert.equal(headerOf(m, 'Subject'), 'Hi Bcc: evil@example.com');
    assert.deepEqual(m.rcpt, ['a@example.com']);
    assert.equal(buildMessage({ from: 'x@y.co', to: 'a@b.co', subject: 's', text: 't' }).split('\r\n')[0], 'From: x@y.co');
  } finally { await srv.close(); }
});

test('server refusals become clear errors, and the password is never in them', async () => {
  const srv = await fakeSmtp({ user: 'mailer', pass: 's3cret', rejectRcpt: true });
  try {
    await assert.rejects(() => sendMail({ to: 'a@example.com', subject: 's', text: 't' }, cfgFor(srv, { user: 'mailer', pass: 'WRONG-PASSWORD' })), (e) => /login/.test(e.message) && /535/.test(e.message) && !/WRONG-PASSWORD/.test(e.message));
    await assert.rejects(() => sendMail({ to: 'a@example.com', subject: 's', text: 't' }, cfgFor(srv, { user: 'mailer', pass: 's3cret' })), /recipient.*550/);
  } finally { await srv.close(); }
});

test('implicit TLS (port 465 style) and STARTTLS (587 style) both work and encrypt the login', async () => {
  for (const mode of ['tls', 'starttls']) {
    const srv = await fakeSmtp({ mode, user: 'mailer', pass: 's3cret', certs });
    try {
      await sendMail({ to: 'a@example.com', subject: `over ${mode}`, text: 'secure body' }, { host: 'localhost', port: srv.port, secure: mode, user: 'mailer', pass: 's3cret', from: 'no-reply@example.com' }, { ca: certs.cert });
      const [m] = await srv.waitFor(1);
      assert.ok(m.tls, `${mode}: the message arrived over an encrypted connection`); assert.ok(m.authed); assert.equal(bodyOf(m), 'secure body');
    } finally { await srv.close(); }
  }
});

test('a certificate it does not trust is refused', async () => {
  const srv = await fakeSmtp({ mode: 'tls', certs });
  try { await assert.rejects(() => sendMail({ to: 'a@example.com', subject: 's', text: 't' }, { host: 'localhost', port: srv.port, secure: 'tls', user: '', pass: '', from: 'a@b.co' })); }
  finally { await srv.close(); }
});

test('it will not send a password over an unencrypted connection to another machine', async () => {
  await assert.rejects(() => sendMail({ to: 'a@example.com', subject: 's', text: 't' }, { host: 'mail.example.com', port: 25, secure: 'none', user: 'u', pass: 'p', from: 'a@b.co' }), /unencrypted/);
});

test('an unreachable mail server fails fast instead of hanging', async () => {
  const t0 = Date.now();
  await assert.rejects(() => sendMail({ to: 'a@example.com', subject: 's', text: 't' }, { host: '127.0.0.1', port: 9, secure: 'none', user: '', pass: '', from: 'a@b.co' }, { timeoutMs: 3000 }));
  assert.ok(Date.now() - t0 < 4000);
});
