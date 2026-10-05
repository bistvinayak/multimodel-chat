// Encryption at rest for user-provided API keys (AES-256-GCM).
// The master key comes from APP_SECRET (64 hex chars) or is generated once into data/secret.key.
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

let master = null;
export function initSecrets(dataDir) {
  if (process.env.APP_SECRET) {
    master = Buffer.from(process.env.APP_SECRET, 'hex');
    if (master.length !== 32) throw new Error('APP_SECRET must be 64 hex characters (32 bytes)');
    return;
  }
  const file = path.join(dataDir, 'secret.key');
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  master = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', master, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(blob) {
  const [v, iv, tag, enc] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', master, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
