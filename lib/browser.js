// Headless browser for pages whose content only appears after JavaScript runs.
// Drives the system Chrome/Chromium over the DevTools protocol: no npm dependencies.
// Safety: every request the page makes (scripts, XHR, redirects) is checked against private and
// internal addresses; images, media and fonts are skipped. One shared browser, at most 2 pages at a
// time, shut down after 5 idle minutes.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { isPrivateIp } from './watch.js';

const CANDIDATES = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
export const chromePath = () => CANDIDATES.find((p) => existsSync(p)) || null;
export const browserEnabled = () => process.env.BROWSER_RENDER !== 'off' && !!chromePath();
// Honest identification: a normal Chrome user agent with our tracker name appended.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 MultiModelWorkspace-PriceWatch/1.0';

let proc = null, port = null, profile = null, starting = null, idle = null, active = 0;
const waiters = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureBrowser() {
  if (proc && proc.exitCode === null) return;
  if (starting) return starting;
  starting = (async () => {
    port = 9400 + Math.floor(Math.random() * 500);
    profile = mkdtempSync(path.join(tmpdir(), 'mmw-browser-'));
    proc = spawn(chromePath(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-sync', '--disable-background-networking', '--metrics-recording-only', '--mute-audio', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
    proc.on('exit', () => { proc = null; try { rmSync(profile, { recursive: true, force: true }); } catch {} });
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch {} await sleep(200); }
    throw new Error('The headless browser did not start.');
  })();
  try { await starting; } finally { starting = null; }
}
function touchIdle() { clearTimeout(idle); idle = setTimeout(() => { if (!active && proc) proc.kill(); }, 5 * 60_000); idle.unref?.(); }
export function shutdownBrowser() { if (proc) proc.kill(); }

async function acquire() { if (active >= 2) await new Promise((r) => waiters.push(r)); active++; }
function release() { active--; waiters.shift()?.(); touchIdle(); }

const hostOk = new Map(); // hostname -> { ok, at }
async function hostAllowed(hostname, allowPrivate) {
  if (allowPrivate) return true;
  const h = hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(h)) return false;
  const hit = hostOk.get(h); if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ok;
  let ok = false;
  try {
    const literal = !!net.isIP(h);
    const addrs = literal ? [{ address: h }] : await dns.lookup(h, { all: true });
    ok = addrs.length > 0 && !addrs.some((a) => isPrivateIp(a.address, { viaDns: !literal }));
  } catch { ok = false; }
  hostOk.set(h, { ok, at: Date.now() });
  return ok;
}

/** Load a page in headless Chrome and return the rendered HTML. */
export async function renderPage(url, { allowPrivate = false, timeoutMs = 30_000, settleMs = 2500 } = {}) {
  if (!browserEnabled()) throw new Error('No Chrome or Chromium found for headless rendering.');
  await acquire();
  let target, ws;
  try {
    await ensureBrowser();
    target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('Could not connect to the headless browser.')); });
    let id = 0; const pending = new Map(); const handlers = {};
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { const { ok, bad } = pending.get(d.id); pending.delete(d.id); d.error ? bad(new Error(d.error.message)) : ok(d.result); }
      else if (d.method && handlers[d.method]) handlers[d.method](d.params);
    };
    const send = (method, params = {}) => new Promise((ok, bad) => { const i = ++id; pending.set(i, { ok, bad }); ws.send(JSON.stringify({ id: i, method, params })); });
    let blocked = null, mainStatus = null;
    // Every request goes through this check, including redirects and requests made by scripts.
    handlers['Fetch.requestPaused'] = async (p) => {
      try {
        const u = new URL(p.request.url);
        if (['Image', 'Media', 'Font'].includes(p.resourceType)) return send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
        if (!/^https?:$/.test(u.protocol) || !(await hostAllowed(u.hostname, allowPrivate))) {
          if (p.resourceType === 'Document') blocked = 'The page tried to load a private or local address, so it was stopped.';
          return send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'AccessDenied' });
        }
        return send('Fetch.continueRequest', { requestId: p.requestId });
      } catch { return send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }).catch(() => {}); }
    };
    handlers['Network.responseReceived'] = (p) => { if (p.type === 'Document' && mainStatus == null) mainStatus = p.response.status; };
    let loaded; const loadedP = new Promise((r) => { loaded = r; });
    handlers['Page.loadEventFired'] = () => loaded();
    await send('Network.enable');
    await send('Network.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'en-US,en;q=0.8' });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await send('Page.enable');
    await send('Page.navigate', { url });
    await Promise.race([loadedP, sleep(timeoutMs)]);
    if (blocked) throw new Error(blocked);
    // Give client-side code a moment to fetch and render prices or late content.
    await sleep(settleMs);
    const r = await send('Runtime.evaluate', { expression: '({ html: document.documentElement.outerHTML, url: location.href, text: (document.body && document.body.innerText || "").length })', returnByValue: true });
    return { html: r.result.value.html, url: r.result.value.url, status: mainStatus, textLength: r.result.value.text };
  } finally {
    try { ws?.close(); } catch {}
    if (target?.id) fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    release();
  }
}
