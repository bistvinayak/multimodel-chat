// News & job monitor agent. Sources are official/public feeds and APIs only:
//   news: Google News RSS search, Hacker News (Algolia API)
//   jobs: HN "Who is hiring" thread, Remotive API, RemoteOK API, Arbeitnow API,
//         and company career boards via Greenhouse / Ashby / Lever public job-board APIs.
// LinkedIn/Indeed are intentionally not scraped (their terms forbid it).
import { safeFetch, htmlToText } from './watch.js';
import { complete } from './openrouter.js';

export const UA = 'MultiModelWorkspace-Monitor/1.0 (personal news and job alerts)';
export const SOURCES = {
  google_news: { kind: 'news', label: 'Google News', ttl: 30, desc: 'Articles from thousands of news sites, last 7 days' },
  hn: { kind: 'news', label: 'Hacker News', ttl: 15, desc: 'Tech stories people are discussing' },
  hn_hiring: { kind: 'jobs', label: 'HN: Who is hiring', ttl: 60, desc: 'Monthly Hacker News thread where startups post openings, many in the US or remote' },
  remotive: { kind: 'jobs', label: 'Remotive', ttl: 360, desc: 'Remote-only job board' },     // Remotive asks for a few requests a day at most
  remoteok: { kind: 'jobs', label: 'Remote OK', ttl: 60, desc: 'Remote-only job board' },
  arbeitnow: { kind: 'jobs', label: 'Arbeitnow', ttl: 60, desc: 'Job board focused on Europe, mostly Germany' },
  companies: { kind: 'jobs', label: 'Company career pages', ttl: 60, desc: 'Official openings straight from the companies\' own careers pages' },
};
// Verified public boards (Oct 2026). Users can add any other greenhouse:/ashby:/lever: board.
export const COMPANY_PRESETS = [
  'greenhouse:anthropic', 'ashby:openai', 'greenhouse:xai', 'greenhouse:databricks', 'greenhouse:scaleai', 'ashby:perplexity', 'ashby:cohere',
  'ashby:harvey', 'ashby:cursor', 'ashby:elevenlabs', 'greenhouse:stripe', 'greenhouse:figma', 'ashby:notion', 'ashby:linear', 'ashby:ramp',
  'greenhouse:airbnb', 'lever:palantir', 'lever:spotify',
  // Big tech & fintech, many with APM / rotational programs (verified Oct 2026)
  'greenhouse:robinhood', 'greenhouse:coinbase', 'greenhouse:brex', 'greenhouse:datadog', 'greenhouse:duolingo', 'greenhouse:roblox',
  'greenhouse:pinterest', 'greenhouse:lyft', 'greenhouse:instacart', 'greenhouse:reddit', 'ashby:plaid', 'greenhouse:asana', 'greenhouse:cloudflare',
];

/** Find a company's public job board by name: tries Greenhouse, Ashby and Lever. */
export async function resolveCompany(name) {
  const base = String(name || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 -]/g, '').trim();
  if (!base) return null;
  const slugs = [...new Set([base.replace(/[\s-]+/g, ''), base.replace(/\s+/g, '-'), base.split(/\s+/)[0]])].filter(Boolean).slice(0, 3);
  for (const slug of slugs) {
    for (const [ats, url, pick] of [
      ['greenhouse', `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, (d) => d.jobs],
      ['ashby', `https://api.ashbyhq.com/posting-api/job-board/${slug}`, (d) => d.jobs],
      ['lever', `https://api.lever.co/v0/postings/${slug}?mode=json`, (d) => d],
    ]) {
      try {
        const jobs = pick(await getJSON(url));
        if (Array.isArray(jobs) && jobs.length) return { board: `${ats}:${slug}`, name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), jobs: jobs.length };
      } catch { /* not on this ATS */ }
    }
  }
  return null;
}

const cache = new Map(); // key -> { at, data }
async function cached(key, ttlMin, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMin * 60_000) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}
const getJSON = async (url, maxBytes = 25 * 1024 * 1024) => {
  const r = await safeFetch(url, { accept: 'application/json', timeoutMs: 45_000, maxBytes, userAgent: UA });
  if (r.status !== 200) throw new Error(`${new URL(url).hostname} returned HTTP ${r.status}`);
  return JSON.parse(r.body);
};
const strip = (html, n = 500) => htmlToText(String(html || '')).replace(/\s+/g, ' ').trim().slice(0, n);
const xml = (block, tag) => { const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''; };
const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
export const terms = (q) => String(q || '').split(',').map((t) => t.trim()).filter(Boolean);

// ---------- sources: each returns [{ source, url, title, snippet, company, location, published_at }] ----------
const fetchers = {
  async google_news(m) {
    const q = terms(m.query).map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' OR ');
    const loc = terms(m.location).filter((l) => !/remote/i.test(l));
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`(${q})${loc.length ? ` (${loc.join(' OR ')})` : ''} when:7d`)}&hl=en-US&gl=US&ceid=US:en`;
    const body = await cached(`gn:${url}`, SOURCES.google_news.ttl, async () => (await safeFetch(url, { accept: 'application/rss+xml', userAgent: UA })).body);
    return [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
      source: 'google_news', url: decodeXml(xml(it, 'link')), title: decodeXml(xml(it, 'title')), snippet: strip(decodeXml(xml(it, 'description')), 300),
      company: decodeXml(xml(it, 'source')) || null, location: null, published_at: Date.parse(xml(it, 'pubDate')) || null,
    }));
  },
  async hn(m) {
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    const out = [];
    for (const t of terms(m.query).slice(0, 4)) {
      const d = await cached(`hn:${t}`, SOURCES.hn.ttl, () => getJSON(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(t)}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=40`));
      for (const h of d.hits || []) out.push({ source: 'hn', url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, title: h.title, snippet: `${h.points || 0} points · ${h.num_comments || 0} comments on Hacker News`,
        company: h.url ? new URL(h.url).hostname.replace(/^www\./, '') : 'news.ycombinator.com', location: null, published_at: h.created_at_i * 1000 });
    }
    return out;
  },
  async hn_hiring(m) {
    const threads = await cached('hn:whoishiring', 360, () => getJSON('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=who%20is%20hiring&hitsPerPage=5'));
    const thread = (threads.hits || []).find((h) => /^Ask HN: Who is hiring\?/i.test(h.title));
    if (!thread) return [];
    const out = [];
    for (const t of terms(m.query).slice(0, 4)) {
      const d = await cached(`hnh:${thread.objectID}:${t}`, SOURCES.hn_hiring.ttl, () => getJSON(`https://hn.algolia.com/api/v1/search?tags=comment,story_${thread.objectID}&query=${encodeURIComponent(t)}&hitsPerPage=60`));
      for (const h of d.hits || []) {
        if (h.parent_id !== Number(thread.objectID)) continue; // top-level job posts only
        const text = strip(h.comment_text, 1200);
        const first = text.split(/(?<=\S)\s{2,}|\n/)[0].slice(0, 160);
        const parts = first.split('|').map((x) => x.trim());
        out.push({ source: 'hn_hiring', url: `https://news.ycombinator.com/item?id=${h.objectID}`, title: first, snippet: text.slice(0, 600),
          company: parts[0] || null, location: parts.find((x) => /remote|onsite|hybrid|,|\b[A-Z]{2}\b/.test(x)) || null, published_at: h.created_at_i * 1000 });
      }
    }
    return out;
  },
  async remotive(m) {
    const out = [];
    for (const t of terms(m.query).slice(0, 3)) {
      const d = await cached(`remotive:${t.toLowerCase()}`, SOURCES.remotive.ttl, () => getJSON(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(t)}&limit=50`));
      for (const j of d.jobs || []) out.push({ source: 'remotive', url: j.url, title: j.title, snippet: strip(j.description, 500), company: j.company_name, location: `Remote${j.candidate_required_location ? ` (${j.candidate_required_location})` : ''}`, published_at: Date.parse(j.publication_date) || null });
    }
    return out;
  },
  async remoteok() {
    const d = await cached('remoteok', SOURCES.remoteok.ttl, () => getJSON('https://remoteok.com/api'));
    return (Array.isArray(d) ? d.slice(1) : []).map((j) => ({ source: 'remoteok', url: j.url || `https://remoteok.com/remote-jobs/${j.id}`, title: j.position, snippet: strip(j.description, 500),
      company: j.company, location: `Remote${j.location ? ` (${j.location})` : ''}`, published_at: Date.parse(j.date) || null }));
  },
  async arbeitnow() {
    const d = await cached('arbeitnow', SOURCES.arbeitnow.ttl, () => getJSON('https://www.arbeitnow.com/api/job-board-api'));
    return (d.data || []).map((j) => ({ source: 'arbeitnow', url: j.url, title: j.title, snippet: strip(j.description, 500), company: j.company_name,
      location: `${j.location || ''}${j.remote ? ' (remote)' : ''}`.trim() || null, published_at: j.created_at ? j.created_at * 1000 : null }));
  },
  async companies(m) {
    const boards = JSON.parse(m.companies || '[]');
    const out = [];
    for (const b of boards.slice(0, 50)) {
      const [ats, slug] = String(b).split(':');
      if (!/^[a-z0-9-]+$/i.test(slug || '')) continue;
      try {
        const jobs = await cached(`board:${ats}:${slug}`, SOURCES.companies.ttl, async () => {
          if (ats === 'greenhouse') return ((await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`)).jobs || [])
            .map((j) => ({ url: j.absolute_url, title: j.title, location: j.location?.name || null, published_at: Date.parse(j.first_published || j.updated_at) || null }));
          if (ats === 'ashby') return ((await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`)).jobs || [])
            .map((j) => ({ url: j.jobUrl, title: j.title, location: [j.location, j.isRemote ? 'Remote' : null].filter(Boolean).join(' · ') || null, published_at: Date.parse(j.publishedAt) || null }));
          if (ats === 'lever') return ((await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`)) || [])
            .map((j) => ({ url: j.hostedUrl, title: j.text, location: j.categories?.location || null, published_at: j.createdAt || null }));
          return [];
        });
        for (const j of jobs) out.push({ source: 'companies', ...j, company: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), snippet: '' });
      } catch (e) { out.push({ source: 'companies', error: `${b}: ${e.message}` }); }
    }
    return out;
  },
};

// ---------- matching ----------
const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ')} `;
const hasTerm = (text, t) => norm(text).includes(` ${norm(t).trim()} `);
// Job titles rarely carry topic words ("Product Manager, Learning" at an AI lab), so for jobs a
// term like "AI Product Manager" matches on its role ("product manager"); the AI screener then
// judges the topic using the company and the user's criteria. Abbreviations expand both ways.
const TOPIC_WORDS = /\b(ai|ml|genai|gen ai|llm|llms|generative|artificial intelligence|machine learning|data|nlp|cv|agentic|agents?)\b/gi;
// Program names that are posted under a different title.
const ROLE_ALIASES = { 'rotational product manager': ['associate product manager', 'product manager rotational'], 'graduate product manager': ['associate product manager', 'product manager new grad', 'product manager graduate'],
  'new grad product manager': ['associate product manager'], 'entry level product manager': ['associate product manager'], 'junior product manager': ['associate product manager'] };
const ROLE_ABBR = { rpm: 'rotational product manager', pm: 'product manager', apm: 'associate product manager', tpm: 'technical program manager', swe: 'software engineer',
  sde: 'software engineer', mle: 'machine learning engineer', ds: 'data scientist', em: 'engineering manager', pmm: 'product marketing manager' };
export function jobMatchTerms(query) {
  const out = new Set();
  for (const t of terms(query)) {
    const low = t.toLowerCase().trim();
    out.add(low);
    const role = low.replace(TOPIC_WORDS, ' ').replace(/\s+/g, ' ').trim();
    if (role && role.split(' ').length >= 1 && role !== low) out.add(role);
    for (const [abbr, full] of Object.entries(ROLE_ABBR)) {
      if (new RegExp(`\\b${abbr}\\b`).test(role || low)) out.add((role || low).replace(new RegExp(`\\b${abbr}\\b`), full).trim());
      if ((role || low).includes(full)) out.add(full);
    }
  }
  for (const t of [...out]) for (const a of ROLE_ALIASES[t] || []) out.add(a);
  // Single generic words ("manager", "intern") alone would match far too much; keep multi-word roles or explicit one-word asks.
  return [...out].filter((x) => x && (x.includes(' ') || terms(query).some((q) => q.toLowerCase() === x)));
}

// "USA" never appears in "San Francisco, CA": a location term also matches its states, cities and codes.
const US_STATES = 'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia';
const US_CODES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const LOCATION_ALIASES = {
  usa: [new RegExp(`\\b(usa|u\\.s\\.a?\\.?|us|united states|america|americas|north america|${US_STATES}|san francisco|sf|bay area|seattle|nyc|los angeles|boston|austin|chicago|denver|atlanta|palo alto|mountain view|menlo park|sunnyvale|san jose|san mateo|redmond)\\b`, 'i'), new RegExp(`,\\s*(${US_CODES})\\b`)],
  uk: [/\b(uk|u\.k\.|united kingdom|england|scotland|wales|britain|london|manchester|edinburgh|cambridge|oxford|bristol)\b/i],
  india: [/\b(india|bengaluru|bangalore|mumbai|delhi|new delhi|gurgaon|gurugram|noida|hyderabad|pune|chennai|kolkata|ahmedabad)\b/i],
  canada: [/\b(canada|toronto|vancouver|montreal|ottawa|calgary|waterloo)\b/i, /,\s*(ON|BC|QC|AB)\b/],
  europe: [/\b(europe|eu|emea|germany|berlin|munich|france|paris|netherlands|amsterdam|spain|madrid|barcelona|ireland|dublin|sweden|stockholm|switzerland|zurich|poland|warsaw|portugal|lisbon|italy|milan|denmark|copenhagen)\b/i],
};
LOCATION_ALIASES.us = LOCATION_ALIASES['united states'] = LOCATION_ALIASES.america = LOCATION_ALIASES.usa;
LOCATION_ALIASES['united kingdom'] = LOCATION_ALIASES.england = LOCATION_ALIASES.uk;
LOCATION_ALIASES.eu = LOCATION_ALIASES.emea = LOCATION_ALIASES.europe;
export function locationMatches(term, location) {
  const t = term.toLowerCase().replace(/\./g, '').trim();
  if (t === 'remote') return /remote|anywhere|distributed/i.test(location);
  const aliases = LOCATION_ALIASES[t];
  if (aliases) return aliases.some((re) => re.test(location));
  return hasTerm(location, term);
}

export function prefilter(m, items) {
  const want = m.kind === 'jobs' ? jobMatchTerms(m.query) : terms(m.query), excl = terms(m.exclude), locs = terms(m.location);
  const maxAge = Date.now() - 45 * 86400_000;
  return items.filter((it) => {
    if (it.error || !it.title || !it.url) return false;
    const hay = m.kind === 'jobs' ? it.title : `${it.title} ${it.snippet}`;
    const match = m.kind === 'jobs' ? (t) => hasTerm(hay, t) : (t) => norm(t).trim().split(' ').every((w) => w.length < 2 || norm(hay).includes(` ${w} `));
    if (!want.some(match)) return false;
    if (excl.some((t) => hasTerm(it.title, t))) return false;
    if (it.published_at && it.published_at < maxAge) return false;
    if (locs.length && it.location) {
      const ok = locs.some((l) => locationMatches(l, it.location));
      if (!ok) return false;
    }
    return true;
  });
}
export const dedupeKey = (it) => (it.url ? it.url.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase() : `${it.company}|${it.title}`.toLowerCase());

export async function collect(m) {
  const sources = JSON.parse(m.sources || '[]').filter((s) => SOURCES[s] && SOURCES[s].kind === m.kind);
  const results = await Promise.allSettled(sources.map((s) => fetchers[s](m)));
  const items = [], errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { for (const it of r.value) (it.error ? errors.push(it.error) : items.push(it)); }
    else errors.push(`${SOURCES[sources[i]].label}: ${r.reason?.message || r.reason}`);
  });
  const seen = new Set();
  const unique = items.filter((it) => { const k = dedupeKey(it); if (seen.has(k)) return false; seen.add(k); return true; });
  return { items: unique, errors, scanned: items.length };
}

// ---------- relevance: Jev (calibrated yes/no) or a free LLM judge ----------
export function criteriaText(m) {
  return [`The user wants ${m.kind === 'jobs' ? 'job openings' : 'news'} about: ${terms(m.query).join(', ')}.`,
    m.location ? `Location: ${m.location}.` : '', m.exclude ? `Not interested in: ${m.exclude}.` : '', m.criteria ? `What counts: ${m.criteria}` : ''].filter(Boolean).join(' ');
}
export async function scoreRelevance({ m, items, jev, apiKey, models, feedback = [] }) {
  if (!items.length) return [];
  // The user's own thumbs up/down on earlier results teach the screener their taste.
  const liked = feedback.filter((f) => f.feedback > 0).slice(0, 8), disliked = feedback.filter((f) => f.feedback < 0).slice(0, 8);
  const crit = criteriaText(m) + (liked.length ? `\nThe user marked these as useful: ${liked.map((f) => `"${f.title}"`).join('; ')}.` : '')
    + (disliked.length ? `\nThe user marked these as NOT relevant: ${disliked.map((f) => `"${f.title}"`).join('; ')}.` : '');
  const desc = (it) => `${it.title}${it.company ? ` | ${it.company}` : ''}${it.location ? ` | ${it.location}` : ''}${it.snippet ? `\n${it.snippet.slice(0, 400)}` : ''}`;
  if (jev) {
    const out = [];
    for (let i = 0; i < items.length; i += 8) {
      const batch = items.slice(i, i + 8);
      const res = await Promise.all(batch.map(async (it) => {
        try {
          const r = await fetch(`${jev.base}/v1/systemone`, { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${jev.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'jev-latest', state: `${crit}\n\nITEM:\n${desc(it)}`, questions: { relevant: { type: 'noul', instructions: 'Is this item what the user is looking for?' } } }) });
          const p = Number((await r.json()).answers?.relevant?.noul);
          return Number.isFinite(p) ? { score: p, reason: null, by: 'jev' } : null;
        } catch { return null; }
      }));
      out.push(...res);
    }
    if (out.every(Boolean)) return out;
  }
  const out = new Array(items.length).fill(null);
  for (let i = 0; i < items.length; i += 20) {
    const batch = items.slice(i, i + 20);
    const messages = [
      { role: 'system', content: 'You screen search results for a user. Be strict: only items that clearly match what they want. Reply with JSON only.' },
      { role: 'user', content: `${crit}\n\nItems:\n${batch.map((it, k) => `[${k}] ${desc(it)}`).join('\n\n')}\n\nFor every item reply: {"results": [{"i": 0, "score": 0.0, "reason": "max 12 words"}]}. score is 0 to 1 for how well it matches.` },
    ];
    for (const model of models) {
      try {
        const text = await complete({ apiKey, model, messages, maxTokens: 4000, timeoutMs: 90_000 });
        const j = JSON.parse((text.match(/\{[\s\S]*\}/) || [])[0] || 'null');
        for (const r of j?.results || []) if (Number.isInteger(r.i) && batch[r.i]) out[i + r.i] = { score: Math.max(0, Math.min(1, Number(r.score) || 0)), reason: String(r.reason || '').slice(0, 140), by: model };
        break;
      } catch { /* next model */ }
    }
  }
  // Never guess: an unscreened item is not relevant. The agent leaves it unseen so the next run screens it.
  return out.map((x) => x || { score: null, reason: 'Not screened yet (AI screening was unavailable).', by: 'none' });
}

// ---------- page watcher: alert when a page starts saying something, or changes ----------
export function pageDigest(html) {
  const text = htmlToText(html).replace(/\s+/g, ' ').trim();
  let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return { text, hash: String(h >>> 0) };
}
export async function judgePage({ text, criteria, url, jev, apiKey, models }) {
  const page = text.slice(0, 12000);
  if (jev) {
    try {
      const r = await fetch(`${jev.base}/v1/systemone`, { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${jev.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'jev-latest', state: `PAGE (${url}):\n${page}`, questions: { met: { type: 'noul', instructions: `Is this true based on the page right now: ${criteria}` } } }) });
      const p = Number((await r.json()).answers?.met?.noul);
      if (Number.isFinite(p)) return { met: p >= 0.5, confidence: p, evidence: null, by: 'jev' };
    } catch { /* fall through */ }
  }
  const messages = [
    { role: 'system', content: 'You check whether a condition is currently true on a web page. Use only the page text. Reply with JSON only.' },
    { role: 'user', content: `Condition: ${criteria}\n\nPage text from ${url}:\n${page}\n\nReply exactly: {"met": true or false, "evidence": "short quote from the page, or empty"}` },
  ];
  for (const model of models) {
    try {
      const t = await complete({ apiKey, model, messages, maxTokens: 1500, timeoutMs: 60_000 });
      const j = JSON.parse((t.match(/\{[\s\S]*\}/) || [])[0] || 'null');
      if (j && typeof j.met === 'boolean') return { met: j.met, evidence: String(j.evidence || '').slice(0, 300), by: model };
    } catch { /* next */ }
  }
  throw new Error('Could not evaluate the page (no AI model available right now).');
}

// ---------- planner: plain-English request -> tracker config ----------
export const PLANNER_PROMPT = `You turn a user's tracking request into a tracker config. Choose exactly one type:
- "price": watch a product page price. Needs "url". Use "condition": "below" with "target_price", or "drop_pct" with "drop_pct", or "any_drop".
- "jobs": find new job openings. Needs "query": comma-separated role names and synonyms (e.g. "AI Product Manager, AI PM, Product Manager AI"). Optional "location" (comma-separated, may include "Remote"), "exclude" (comma-separated words to drop, e.g. "Senior, Director" for graduate roles), "criteria" (one sentence on what counts), "use_company_boards": true when the user mentions AI or tech companies, big labs, startups or specific companies.
- "news": find new articles. Needs "query" (comma-separated topics). Optional "criteria".
- "page": alert about a specific web page. Needs "url". "criteria": the condition to check in plain English (e.g. "applications are open"), or empty to alert on any change.
Also give "name" (2-6 words), "interval_minutes" if the user said how often (5 times a day = 288, hourly = 60, daily = 1440), and "summary": one sentence describing what you set up.
Reply with JSON only: {"type": "...", "name": "...", ...}`;

/** Plain-English request -> tracker plan. Shared by the app and the eval suite. */
export async function planRequest({ request, apiKey, models }) {
  let plan, lastErr;
  for (const model of models) {
    try {
      const text = await complete({ apiKey, model, maxTokens: 2000, timeoutMs: 60_000, messages: [{ role: 'system', content: PLANNER_PROMPT }, { role: 'user', content: request }] });
      plan = JSON.parse((text.match(/\{[\s\S]*\}/) || [])[0] || 'null');
      if (plan?.type) { plan.planner_model = model; break; }
    } catch (e) { lastErr = e; }
  }
  if (!plan?.type) throw new Error(`Could not understand the request right now${lastErr ? ` (${lastErr.message})` : ''}. Try again.`);
  // Deterministic hints beat the model when the user was explicit.
  const url = (request.match(/https?:\/\/[^\s<>"')]+/) || [])[0];
  if (url && !plan.url) plan.url = url;
  const perDay = request.match(/(\d+)\s*(?:x|times)\s*(?:a|per|each)?\s*day/i);
  if (perDay) plan.interval_minutes = 1440 / Number(perDay[1]);
  if (!['price', 'jobs', 'news', 'page'].includes(plan.type)) plan.type = url ? 'page' : 'news';
  return plan;
}
