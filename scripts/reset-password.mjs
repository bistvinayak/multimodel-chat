// Owner recovery tool: set a new password for an account directly in the database.
//   node scripts/reset-password.mjs you@example.com            -> picks a random password and prints it once
//   node scripts/reset-password.mjs you@example.com 'new pass' -> uses the one you give (8+ characters)
// Uses DB_PATH (default data/app.db). Signs the account out everywhere. Run it on the machine that holds the database.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const [email, given] = process.argv.slice(2);
if (!email) { console.error("Usage: node scripts/reset-password.mjs <email> ['new password']"); process.exit(2); }
if (given !== undefined && given.length < 8) { console.error('The password must be at least 8 characters.'); process.exit(2); }

const dbFile = process.env.DB_PATH || path.join(ROOT, 'data', 'app.db');
const db = openDb(dbFile);
const u = db.prepare('SELECT id, name, email FROM users WHERE email=?').get(email.trim().toLowerCase());
if (!u) { console.error(`No account with the email ${email} in ${dbFile}.`); process.exit(1); }
const password = given ?? randomBytes(12).toString('base64url');
db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), u.id);
db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
db.prepare('UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL').run(Date.now(), u.id);
console.log(`Password updated for ${u.name} <${u.email}>. Signed out everywhere.`);
if (given === undefined) console.log(`New password (shown once, change it after signing in): ${password}`);
