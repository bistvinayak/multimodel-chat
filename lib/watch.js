// Price-watch agent: safe fetching, robots.txt, price extraction, and alert conditions.
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { complete } from './openrouter.js';

export const USER_AGENT = 'MultiModelWorkspace-PriceWatch/1.0 (personal price tracker; low frequency)';
const MAX_BYTES = 3 * 1024 * 1024;

// ---------- SSRF guard: only public http(s) hosts, re-checked on every redirect ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

export async function assertPublicUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a valid link.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https links can be watched.');
  if (u.username || u.password) throw new Error('Links with embedded credentials are not allowed.');
  if (u.port && !['80', '443'].includes(u.port) && !allowPrivate) throw new Error('Only standard web ports are allowed.');
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new Error('Private or local addresses cannot be watched.');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error(`Could not find the site ${host}.`); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private or local addresses cannot be watched.');
  return u;
}

/** DNS lookup used at connect time: refuses private addresses, so DNS rebinding can't slip through. */
function guardedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }).then((addrs) => {
      const bad = !allowPrivate && addrs.some((a) => isPrivateIp(a.address));
      if (bad || !addrs.length) return cb(Object.assign(new Error('Private or local addresses cannot be watched.'), { code: 'EPRIVATE' }));
      if (options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    }, cb);
  };
}

function requestOnce(url, { allowPrivate, accept, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET', lookup: guardedLookup(allowPrivate), timeout: timeoutMs,
      headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'en-US,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
    }, (res) => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks = []; let size = 0;
      stream.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(); stream.destroy(); resolve({ res, body: Buffer.concat(chunks).toString('utf8') }); } else chunks.push(c); });
      stream.on('end', () => resolve({ res, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('The site took too long to respond.')));
    req.on('error', (e) => reject(e.code === 'EPRIVATE' ? e : new Error(`Could not load the page (${e.code || e.message}).`)));
    req.end();
  });
}

/** Fetch with manual redirects (each hop re-validated), a size cap and a timeout. */
export async function safeFetch(url, { allowPrivate = false, accept = 'text/html,application/xhtml+xml', timeoutMs = 20_000 } = {}) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current, { allowPrivate });
    const { res, body } = await requestOnce(current, { allowPrivate, accept, timeoutMs });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { current = new URL(res.headers.location, current).href; continue; }
    return { status: res.statusCode, url: current, contentType: res.headers['content-type'] || '', body };
  }
  throw new Error('Too many redirects.');
}

// ---------- robots.txt ----------
const robotsCache = new Map(); // origin -> { at, rules }
export function parseRobots(txt) {
  const groups = []; let cur = null;
  for (const line of txt.split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const [, k, v] = m; const key = k.toLowerCase();
    if (key === 'user-agent') { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
    else if ((key === 'allow' || key === 'disallow') && cur) cur.rules.push({ allow: key === 'allow', path: v });
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && USER_AGENT.toLowerCase().includes(a))) || groups.find((g) => g.agents.includes('*'));
  return mine ? mine.rules.filter((r) => r.path) : [];
}
const ruleMatches = (pattern, path) => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')).test(path);
export function robotsAllows(rules, pathWithQuery) {
  // Longest matching rule wins; Allow wins ties.
  let best = null;
  for (const r of rules) if (ruleMatches(r.path, pathWithQuery) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  return !best || best.allow;
}
export async function checkRobots(url, opts) {
  const u = new URL(url);
  let entry = robotsCache.get(u.origin);
  if (!entry || Date.now() - entry.at > 6 * 3600_000) {
    let rules = [];
    try { const r = await safeFetch(`${u.origin}/robots.txt`, { ...opts, accept: 'text/plain', timeoutMs: 10_000 }); if (r.status === 200) rules = parseRobots(r.body); } catch { /* no robots.txt: allowed */ }
    entry = { at: Date.now(), rules }; robotsCache.set(u.origin, entry);
  }
  return robotsAllows(entry.rules, u.pathname + u.search);
}

// ---------- price extraction ----------
const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&pound;/g, '£').replace(/&euro;/g, '€');
export function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  // Take the first number token only, so "Rs. 45,999" isn't misread via the dot in "Rs.".
  let s = (String(v).match(/\d[\d.,\s\u00a0]*\d|\d/) || [''])[0].replace(/[\s\u00a0]/g, '');
  if (!s) return null;
  // 1.299,00 -> 1299.00 ; 1,299.00 -> 1299.00 ; 12,99 -> 12.99
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const meta = (html, name) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${name}["'][^>]*>`, 'i')); return m ? decode((m[0].match(/content=["']([^"']*)["']/i) || [])[1] || '') || null : null; };
const titleOf = (html) => decode((html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i) || html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '').trim().slice(0, 200) || null;

/** Structured data first: JSON-LD Product/Offer, then Open Graph / product meta, then microdata. */
export function extractStructured(html) {
  const out = { title: titleOf(html) };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) { stack.push(...n); continue; }
      const type = [].concat(n['@type'] || []).join(',');
      if (/Product/i.test(type) && n.offers) {
        const offers = [].concat(n.offers);
        for (const o of offers) {
          const p = parsePrice(o.price ?? o.lowPrice ?? o.priceSpecification?.price);
          if (p != null) return { ...out, title: n.name ? decode(n.name).slice(0, 200) : out.title, price: p, currency: o.priceCurrency || o.priceSpecification?.priceCurrency || null,
            in_stock: o.availability ? !/OutOfStock|SoldOut|Discontinued/i.test(o.availability) : null, method: 'structured' };
        }
      }
      for (const v of Object.values(n)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  const mp = parsePrice(meta(html, 'product:price:amount') || meta(html, 'og:price:amount'));
  if (mp != null) return { ...out, price: mp, currency: meta(html, 'product:price:currency') || meta(html, 'og:price:currency'), in_stock: null, method: 'structured' };
  const ip = html.match(/itemprop=["']price["'][^>]*?(?:content=["']([^"']+)["'])?[^>]*>([^<]{0,40})/i);
  if (ip) { const p = parsePrice(ip[1] || ip[2]); if (p != null) {
    const cur = (html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)/i) || [])[1] || symbolCurrency(ip[2]);
    // Breadcrumbs also use itemprop="name": take the name nearest to the price, in either direction.
    const names = [...html.matchAll(/itemprop=["']name["'][^>]*?(?:content=["']([^"']+)["'][^>]*)?>([^<]{0,200})/gi)].map((m) => ({ i: m.index, v: (m[1] || m[2] || '').trim() })).filter((n) => n.v.length > 1);
    const name = [...names].sort((a, b) => Math.abs(a.i - ip.index) - Math.abs(b.i - ip.index))[0]?.v || (html.match(/<h1[^>]*>([^<]{2,200})<\/h1>/i) || [])[1];
    return { ...out, title: name ? decode(name).trim() : out.title, price: p, currency: cur || null, in_stock: null, method: 'structured' }; } }
  return out;
}
const symbolCurrency = (s) => ({ '$': 'USD', '£': 'GBP', '€': 'EUR', '₹': 'INR', '¥': 'JPY' }[(String(s || '').match(/[$£€₹¥]/) || [])[0]] || null);

export function htmlToText(html) {
  return decode(html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/** Fallback: a free model reads the price from the visible text near currency amounts. */
export async function extractWithAI({ apiKey, models, html, url }) {
  const text = htmlToText(html);
  const title = titleOf(html) || '';
  // Keep the parts of the page that matter: around currency amounts, plus the top of the page.
  const windows = [];
  for (const m of text.matchAll(/([$£€₹¥]|USD|EUR|GBP|INR|Rs\.?)\s?\d[\d.,]*/g)) windows.push(text.slice(Math.max(0, m.index - 160), m.index + 120));
  const snippet = `${text.slice(0, 1500)}\n...\n${[...new Set(windows)].slice(0, 25).join('\n---\n')}`.slice(0, 7000);
  const messages = [
    { role: 'system', content: 'You read product web pages. Find the CURRENT selling price of the main product on the page (not related products, not shipping, not the crossed-out old price). Reply with JSON only.' },
    { role: 'user', content: `URL: ${url}\nTitle: ${title}\n\nPage text:\n${snippet}\n\nReply exactly: {"title": "...", "price": 0.00, "currency": "ISO code", "in_stock": true, "confidence": 0.0}. Use null for price if there is no single clear product price.` },
  ];
  let last;
  for (const m of models) {
    try {
      const out = await complete({ apiKey, model: m, messages, maxTokens: 1500, timeoutMs: 60_000 });
      const j = JSON.parse((out.match(/\{[\s\S]*\}/) || [])[0] || 'null');
      if (!j) throw new Error('no JSON');
      const price = parsePrice(j.price);
      if (price == null) return { title: j.title || title, price: null, method: 'ai', model: m, error: 'No clear product price on the page.' };
      return { title: (j.title || title || '').slice(0, 200), price, currency: j.currency || null, in_stock: typeof j.in_stock === 'boolean' ? j.in_stock : null, method: 'ai', model: m, confidence: j.confidence ?? null };
    } catch (e) { last = e; }
  }
  throw new Error(`Could not read the price (${last?.message || 'no model available'}).`);
}

// ---------- conditions ----------
/** Returns a human message when the alert should fire for `price`, else null. `money` formats prices. */
export function conditionMet(w, price, money = (p) => String(p)) {
  if (price == null) return null;
  const newLow = w.last_notified_price == null || price < w.last_notified_price; // only re-alert on a new low
  if (w.condition === 'below' && w.target_price != null && price <= w.target_price && newLow) return `is now ${money(price)}, at or below your target of ${money(w.target_price)}`;
  if (w.condition === 'drop_pct' && w.baseline_price && w.drop_pct && price <= w.baseline_price * (1 - w.drop_pct / 100) && newLow)
    return `dropped ${Math.round((1 - price / w.baseline_price) * 100)}% to ${money(price)}, down from ${money(w.baseline_price)}`;
  if (w.condition === 'any_drop' && w.last_price != null && price < w.last_price) return `dropped from ${money(w.last_price)} to ${money(price)}`;
  return null;
}
