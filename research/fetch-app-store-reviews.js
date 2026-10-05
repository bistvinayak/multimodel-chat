// Collects recent App Store reviews through Apple's public customer-review RSS feed (official, no key).
// Up to 10 pages x 50 reviews per app per storefront. Polite: one request per second.
//   node research/fetch-app-store-reviews.js
// Output: data/research/app-store-reviews.json (git-ignored: raw review text is not redistributed).
// Google Play is not collected: Google's terms prohibit scraping Play reviews; use a licensed export instead.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPS = [
  { app: 'ChatGPT', id: 6448311069 },
  { app: 'Claude', id: 6473753684 },
  { app: 'Perplexity', id: 1668000334 },
];
const COUNTRIES = ['us', 'gb', 'in', 'ca', 'au'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
for (const a of APPS) {
  for (const c of COUNTRIES) {
    let got = 0;
    for (let page = 1; page <= 10; page++) {
      const url = `https://itunes.apple.com/${c}/rss/customerreviews/page=${page}/id=${a.id}/sortby=mostrecent/json`;
      let entries = [];
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'MultiModelWorkspace-Research/1.0' }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) break;
        const j = await r.json();
        entries = [].concat(j.feed?.entry || []).filter((e) => e['im:rating']);
      } catch { break; }
      if (!entries.length) break;
      for (const e of entries) out.push({ app: a.app, country: c, id: e.id?.label, rating: Number(e['im:rating'].label), title: e.title?.label || '', text: e.content?.label || '', version: e['im:version']?.label || '', date: e.updated?.label || '' });
      got += entries.length;
      await sleep(1000);
    }
    console.log(`${a.app.padEnd(10)} ${c}: ${got}`);
  }
}
// De-duplicate (the same review can appear on overlapping pages)
const seen = new Set(); const reviews = out.filter((r) => (seen.has(r.app + r.id) ? false : seen.add(r.app + r.id)));
mkdirSync(path.join(ROOT, 'data', 'research'), { recursive: true });
writeFileSync(path.join(ROOT, 'data', 'research', 'app-store-reviews.json'), JSON.stringify({ fetched_at: new Date().toISOString(), source: 'Apple App Store customer-review RSS', countries: COUNTRIES, reviews }, null, 1));
console.log('total', reviews.length);
