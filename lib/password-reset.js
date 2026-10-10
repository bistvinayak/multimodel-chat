// Forgot / reset password. Security rules, each covered by a test:
//  - the response to "forgot password" is identical whether or not the email has an account, and is sent before any work
//    is done, so neither the text nor the timing reveals who is registered
//  - tokens are 256 random bits, stored only as a hash, valid for 1 hour, single use; a new request or a successful reset
//    cancels all older ones
//  - the link is built from PUBLIC_ORIGIN (never the Host header, which an attacker controls) and keeps the token in the
//    URL fragment, so it does not reach server logs or Referer headers
//  - a successful reset signs the account out everywhere and the owner is told by email
//  - limits per email, per address, and on guessing
import crypto from 'node:crypto';
import { sendMail, mailEnabled } from './mail.js';

const TTL_MS = 60 * 60 * 1000;
const sha = (t) => crypto.createHash('sha256').update(`pwreset:${t}`).digest('hex');
export const GENERIC = 'If an account exists for that email, we have sent a link to reset the password. It works for one hour. Check your spam folder too.';

export function registerPasswordReset({ route, db, send, readJson, HttpError, hashPassword, basePath = '', origin, log = console }) {
  const hits = new Map();
  const tooMany = (key, max, windowMs = TTL_MS) => {
    const t = Date.now(); const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return true; }
    arr.push(t); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    return false;
  };
  const ip = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const linkFor = (token) => `${origin().replace(/\/+$/, '')}${basePath}/#/reset/${token}`;

  async function deliver(email, name, token) {
    const link = linkFor(token);
    const text = `Hi ${name || 'there'},\n\nSomeone asked to reset the password for this account. If it was you, open this link within one hour:\n\n${link}\n\nIf it was not you, ignore this email. Your password stays the same.\n`;
    if (!mailEnabled()) {
      // Local development only: with a public origin configured, never write a working link to the logs.
      if (process.env.PUBLIC_ORIGIN) log.warn?.('[password reset] SMTP is not configured, so no email was sent. Set SMTP_HOST and MAIL_FROM.');
      else log.log?.(`[password reset] email is not configured. Reset link for ${email}: ${link}`);
      return;
    }
    await sendMail({ to: email, subject: 'Reset your password', text });
  }

  route('POST', '/api/forgot-password', async (req, res) => {
    const { email } = await readJson(req);
    const em = String(email || '').trim().toLowerCase();
    if (tooMany(`ip:${ip(req)}`, 20)) throw new HttpError(429, 'Too many requests. Please try again in an hour.');
    send(res, 200, { ok: true, message: GENERIC }); // answered first, identical in every case
    try {
      if (!/^\S+@\S+\.\S+$/.test(em) || em.length > 254) return;
      db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(Date.now() - 24 * 3600_000);
      const u = db.prepare('SELECT id, name FROM users WHERE email=?').get(em);
      if (!u || tooMany(`email:${em}`, 3)) return;
      const token = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      db.prepare('UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL').run(now, u.id);
      db.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(sha(token), u.id, now, now + TTL_MS);
      await deliver(em, u.name, token);
    } catch (e) { log.error?.(`[password reset] could not send: ${e.message}`); }
  }, { auth: false });

  const find = (token) => db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND used_at IS NULL AND expires_at > ?').get(sha(String(token || '')), Date.now());
  const BAD = 'This reset link is invalid or has expired. Please ask for a new one.';

  route('POST', '/api/reset-password/check', async (req, res) => {
    if (tooMany(`guess:${ip(req)}`, 30)) throw new HttpError(429, 'Too many attempts. Please try again later.');
    const { token } = await readJson(req);
    send(res, 200, { valid: !!find(token) });
  }, { auth: false });

  route('POST', '/api/reset-password', async (req, res) => {
    if (tooMany(`guess:${ip(req)}`, 30)) throw new HttpError(429, 'Too many attempts. Please try again later.');
    const { token, password } = await readJson(req);
    const row = find(token);
    if (!row) throw new HttpError(400, BAD);
    const pw = String(password || '');
    if (pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (pw.length > 200) throw new HttpError(400, 'That password is too long');
    const u = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(row.user_id);
    if (!u) throw new HttpError(400, BAD);
    const now = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(pw), u.id);
      db.prepare('UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL').run(now, u.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    send(res, 200, { ok: true });
    if (mailEnabled()) sendMail({ to: u.email, subject: 'Your password was changed', text: `Hi ${u.name || 'there'},\n\nThe password for your account was just changed, and you were signed out everywhere.\n\nIf this was not you, reset your password again straight away and check your email account's security.\n` }).catch((e) => log.error?.(`[password reset] notice not sent: ${e.message}`));
  }, { auth: false });
}
