import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?,?,?)').run(sha(token), userId, Date.now());
  return token;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Cookie name and path are configurable so the app can share a domain with other apps (for example under /chat/).
export const COOKIE_NAME = process.env.SESSION_COOKIE || 'sid';
const COOKIE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '') + '/';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
export const sessionToken = (req) => parseCookies(req.headers.cookie)[COOKIE_NAME];

export function userFromRequest(db, req) {
  const token = sessionToken(req);
  if (!token) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha(token)) || null;
}

export function sessionCookie(token, maxAgeSec = 60 * 60 * 24 * 30) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${maxAgeSec}${COOKIE_SECURE}`;
}
