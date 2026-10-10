// A fake SMTP server for tests. Speaks plain SMTP, implicit TLS, or STARTTLS, and records what it receives.
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A throwaway self-signed certificate for localhost. */
export function selfSigned() {
  const dir = mkdtempSync(path.join(tmpdir(), 'smtp-cert-'));
  writeFileSync(path.join(dir, 'c.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-config', path.join(dir, 'c.cnf')], { stdio: 'ignore' });
  const out = { key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

export async function fakeSmtp({ mode = 'none', user = '', pass = '', rejectRcpt = false, certs } = {}) {
  const inbox = []; const log = [];
  const handle = (sock, upgraded = false) => {
    let buf = '', data = null, cur = { rcpt: [], authed: false, tls: upgraded || mode === 'tls' };
    const w = (s) => { log.push('S: ' + s); sock.write(s + '\r\n'); };
    const lines = () => {
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data !== null) { if (line === '.') { cur.data = data.replace(/^\.\./gm, '.'); inbox.push(cur); data = null; cur = { rcpt: [], authed: cur.authed, tls: cur.tls }; w('250 queued'); } else data += line + '\r\n'; continue; }
        log.push('C: ' + (/^AUTH/i.test(line) ? 'AUTH ***' : line));
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) { sock.write(`250-fake\r\n${mode === 'starttls' && !cur.tls ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN\r\n`); }
        else if (up === 'STARTTLS') { w('220 ready'); sock.removeAllListeners('data'); const t = new tls.TLSSocket(sock, { isServer: true, key: certs.key, cert: certs.cert }); handle(t, true); return; }
        else if (up.startsWith('AUTH PLAIN')) { const [, u, p] = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0'); if (u === user && p === pass) { cur.authed = true; w('235 ok'); } else w('535 bad credentials'); }
        else if (up.startsWith('MAIL FROM:')) { if (user && !cur.authed) w('530 auth required'); else { cur.from = line.slice(10).replace(/[<>]/g, ''); w('250 ok'); } }
        else if (up.startsWith('RCPT TO:')) { if (rejectRcpt) w('550 no such user'); else { cur.rcpt.push(line.slice(8).replace(/[<>]/g, '')); w('250 ok'); } }
        else if (up === 'DATA') { data = ''; w('354 go'); }
        else if (up === 'QUIT') { w('221 bye'); sock.end(); }
        else w('500 what');
      }
    };
    sock.on('data', (d) => { buf += d.toString('utf8'); lines(); });
    sock.on('error', () => {});
    if (!upgraded) w('220 fake ESMTP');
  };
  const server = mode === 'tls' ? tls.createServer({ key: certs.key, cert: certs.cert }, (s) => handle(s)) : net.createServer((s) => handle(s));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { port: server.address().port, inbox, log, close: () => new Promise((ok) => server.close(ok)),
    waitFor: async (n = 1, ms = 5000) => { const end = Date.now() + ms; while (inbox.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); return inbox; } };
}

/** Decode the text body of a recorded message. */
export const bodyOf = (m) => Buffer.from(m.data.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\s+/g, ''), 'base64').toString('utf8');
export const headerOf = (m, name) => (m.data.split('\r\n\r\n')[0].match(new RegExp(`^${name}: (.*)$`, 'im')) || [])[1];
