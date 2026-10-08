// Merges review files into one de-duplicated store, keeping only the chosen countries.
// Re-running with new pulls only adds reviews, so the store grows over time.
//   COUNTRIES=us node research/merge-reviews.js data/research/reviews-us.json <input.json>...
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [out, ...inputs] = process.argv.slice(2);
const keep = new Set((process.env.COUNTRIES || 'us').split(','));
const store = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { reviews: [] };
const byKey = new Map(store.reviews.map((r) => [r.app + r.id, r]));
const before = byKey.size;
for (const f of [out, ...inputs]) {
  if (!existsSync(f)) continue;
  for (const r of JSON.parse(readFileSync(f, 'utf8')).reviews) if (keep.has(r.country) && !byKey.has(r.app + r.id)) byKey.set(r.app + r.id, r);
}
const reviews = [...byKey.values()].sort((a, b) => b.date.localeCompare(a.date));
writeFileSync(out, JSON.stringify({ updated_at: new Date().toISOString(), source: 'Apple App Store customer-review RSS (most recent + most helpful, merged)', countries: [...keep], reviews }, null, 1));
const by = {}; for (const r of reviews) by[r.app] = (by[r.app] || 0) + 1;
console.log(`store ${out}: ${before} -> ${reviews.length} reviews`, by);
