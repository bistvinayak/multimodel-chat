// Minimal SMTP client (no dependencies) for transactional email such as password resets.
// Configure with environment variables; works with any provider that offers SMTP (Zoho Mail, Gmail app passwords,
// Brevo, Mailgun, SES, ...):
//   SMTP_HOST, SMTP_PORT (465 by default), SMTP_USER, SMTP_PASS, MAIL_FROM ("Vigyan <no-reply@yourdomain.com>")
//   SMTP_SECURE = tls (implicit TLS, default for 465) | starttls (default for 587) | none (local testing only)
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

export function mailConfig(env = process.env) {
  if (!env.SMTP_HOST || !env.MAIL_FROM) return null;
  const port = Number(env.SMTP_PORT || 465);
  const secure = env.SMTP_SECURE || (port === 465 ? 'tls' : port === 587 ? 'starttls' : 'none');
  return { host: env.SMTP_HOST, port, secure, user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: env.MAIL_FROM };
}
export const mailEnabled = (env = process.env) => !!mailConfig(env);

const ADDR = /^[^\s<>"',;:\\()[\]]+@[^\s<>"',;:\\()[\]]+\.[^\s<>"',;:\\()[\]]+$/;
const oneLine = (s) => String(s ?? '').replace(/[\r\n\0]+/g, ' ').trim();
const addrOf = (from) => { const m = String(from).match(/<([^>]+)>/); return (m ? m[1] : String(from)).trim(); };
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

/** Builds the raw message. Header values are forced onto one line so user-influenced text can never add headers. */
export function buildMessage({ from, to, subject, text }) {
  const fromName = oneLine(from).replace(/\s*<[^>]*>\s*$/, '');
  const fromHeader = fromName && fromName !== addrOf(from) ? `${encodeHeader(fromName)} <${addrOf(from)}>` : addrOf(from);
  const domain = addrOf(from).split('@')[1] || 'localhost';
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${fromHeader}`, `To: ${oneLine(to)}`, `Subject: ${encodeHeader(oneLine(subject))}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body, '',
  ].join('\r\n');
}

/** Reads SMTP replies (including multi-line ones) from a socket. */
function reader(sock) {
  let buf = ''; const waiting = []; let err = null;
  const pump = () => {
    while (waiting.length) {
      const lines = buf.split('\r\n');
      const last = lines.findIndex((l) => /^\d{3} /.test(l));
      if (last === -1) break;
      const reply = lines.slice(0, last + 1); buf = lines.slice(last + 1).join('\r\n');
      waiting.shift().ok({ code: Number(reply[last].slice(0, 3)), text: reply.map((l) => l.slice(4)).join('\n') });
    }
    if (err) while (waiting.length) waiting.shift().bad(err);
  };
  sock.on('data', (d) => { buf += d.toString('utf8'); pump(); });
  sock.on('error', (e) => { err = e; pump(); });
  sock.on('close', () => { err = err || new Error('The mail server closed the connection'); pump(); });
  return () => new Promise((ok, bad) => { waiting.push({ ok, bad }); pump(); });
}

/** Sends one plain-text email. Throws on any SMTP error (messages never include the password). */
export async function sendMail({ to, subject, text }, cfg = mailConfig(), { timeoutMs = 20_000, ca } = {}) {
  if (!cfg) throw new Error('Email is not configured');
  if (!ADDR.test(String(to))) throw new Error('Invalid recipient address');
  if (cfg.user && cfg.secure === 'none' && !/^(127\.|localhost$|::1$)/.test(cfg.host)) throw new Error('Refusing to send a password over an unencrypted connection');
  const msg = buildMessage({ from: cfg.from, to, subject, text });
  const connectOpts = { host: cfg.host, port: cfg.port, servername: cfg.host, ...(ca ? { ca } : {}) };
  let sock = cfg.secure === 'tls' ? tls.connect(connectOpts) : net.connect({ host: cfg.host, port: cfg.port });
  const timer = setTimeout(() => sock.destroy(new Error('Timed out talking to the mail server')), timeoutMs);
  try {
    await new Promise((ok, bad) => { sock.once(cfg.secure === 'tls' ? 'secureConnect' : 'connect', ok); sock.once('error', bad); });
    let read = reader(sock);
    const expect = async (codes, what) => { const r = await read(); if (!codes.includes(r.code)) throw new Error(`Mail server rejected ${what}: ${r.code} ${oneLine(r.text).slice(0, 120)}`); return r; };
    const cmd = async (line, codes, what) => { sock.write(line + '\r\n'); return expect(codes, what); };
    await expect([220], 'the connection');
    let ehlo = await cmd(`EHLO ${os.hostname().replace(/[^\w.-]/g, '') || 'localhost'}`, [250], 'EHLO');
    if (cfg.secure === 'starttls') {
      await cmd('STARTTLS', [220], 'STARTTLS');
      sock.removeAllListeners('data'); sock.removeAllListeners('close');
      sock = tls.connect({ socket: sock, servername: cfg.host, ...(ca ? { ca } : {}) });
      await new Promise((ok, bad) => { sock.once('secureConnect', ok); sock.once('error', bad); });
      read = reader(sock);
      ehlo = await cmd(`EHLO ${os.hostname().replace(/[^\w.-]/g, '') || 'localhost'}`, [250], 'EHLO');
    }
    if (cfg.user) {
      await cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64')}`, [235], 'the login');
    }
    await cmd(`MAIL FROM:<${addrOf(cfg.from)}>`, [250], 'the sender');
    await cmd(`RCPT TO:<${String(to).trim()}>`, [250, 251], 'the recipient');
    await cmd('DATA', [354], 'DATA');
    sock.write(msg.replace(/^\./gm, '..') + '\r\n.\r\n');
    await expect([250], 'the message');
    sock.write('QUIT\r\n');
    return { sent: true };
  } finally { clearTimeout(timer); sock.destroy(); }
}
