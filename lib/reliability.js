// App-wide model reliability, aggregated across every user's answers.
// Feeds the "Free & best" ranking, fallback picks and background models, so a model that keeps
// failing stops being promoted. Counts only: no message content is read.

export const PRIOR_OK = 2, PRIOR_N = 3;      // smoothing: a new model starts at about 67% success
export const DEMOTE_MIN_TRIES = 4;            // need this many recent tries before demoting
export const DEMOTE_BELOW = 0.35;             // recent success rate under this = demoted
export const WATCH_BELOW = 0.6;               // under this = shown as "unreliable" but still ranked

const pctl = (xs, p) => {
  const a = xs.filter((x) => x != null).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
};

/**
 * rows: [{ model_id, status, error_kind, latency_ms, first_token_ms, completion_tokens, created_at, user_id }]
 * picks: Map model_id -> number of times users chose its answer
 * ratings: Map model_id -> { up, down }
 * Returns Map model_id -> stats with `adj` (score adjustment) and `status` ('good'|'unreliable'|'demoted'|'new').
 */
export function computeReliability(rows, { picks = new Map(), ratings = new Map(), now = Date.now(), recentMs = 24 * 3600_000 } = {}) {
  const by = new Map();
  for (const r of rows) {
    if (!['completed', 'failed', 'rate_limited'].includes(r.status)) continue; // pending, generating and user-stopped don't count
    let s = by.get(r.model_id);
    if (!s) by.set(r.model_id, (s = { tries: 0, ok: 0, limited: 0, failed: 0, recent_tries: 0, recent_ok: 0, errors: {}, users: new Set(), lat: [], ttft: [], tps: [], last_error_at: null, last_ok_at: null }));
    const ok = r.status === 'completed';
    s.tries++; s.users.add(r.user_id);
    if (ok) { s.ok++; s.last_ok_at = Math.max(s.last_ok_at || 0, r.created_at); s.lat.push(r.latency_ms); s.ttft.push(r.first_token_ms);
      if (r.latency_ms > 0 && r.completion_tokens) s.tps.push(r.completion_tokens / (r.latency_ms / 1000)); }
    else {
      if (r.status === 'rate_limited' || r.error_kind === 'rate_limit') s.limited++; else s.failed++;
      const k = r.error_kind || r.status; s.errors[k] = (s.errors[k] || 0) + 1;
      s.last_error_at = Math.max(s.last_error_at || 0, r.created_at);
    }
    if (now - r.created_at <= recentMs) { s.recent_tries++; if (ok) s.recent_ok++; }
  }
  const out = new Map();
  for (const [id, s] of by) {
    const success = (s.ok + PRIOR_OK) / (s.tries + PRIOR_N);
    const recent = s.recent_tries ? s.recent_ok / s.recent_tries : null;
    const rt = ratings.get(id) || { up: 0, down: 0 };
    const pk = picks.get(id) || 0;
    let status = s.tries < 3 ? 'new' : success < WATCH_BELOW ? 'unreliable' : 'good';
    if (recent != null && s.recent_tries >= DEMOTE_MIN_TRIES && recent < DEMOTE_BELOW) status = 'demoted';
    // -8 (always failing) .. +4 (always works), plus small bonuses for picks and thumbs.
    let adj = (success - PRIOR_OK / PRIOR_N) * 12 + Math.min(2, pk / 5) + Math.max(-2, Math.min(2, (rt.up - rt.down) / 3));
    if (status === 'demoted') adj -= 10;
    out.set(id, {
      model_id: id, tries: s.tries, ok: s.ok, limited: s.limited, failed: s.failed, users: s.users.size,
      success_rate: s.tries ? s.ok / s.tries : null, smoothed_success: Math.round(success * 1000) / 1000,
      recent_tries: s.recent_tries, recent_success_rate: recent,
      rate_limit_rate: s.tries ? s.limited / s.tries : null, failure_rate: s.tries ? s.failed / s.tries : null,
      errors: s.errors, picks: pk, thumbs_up: rt.up, thumbs_down: rt.down,
      latency_p50: pctl(s.lat, 0.5), ttft_p50: pctl(s.ttft, 0.5), tokens_per_sec: pctl(s.tps, 0.5),
      last_error_at: s.last_error_at, last_ok_at: s.last_ok_at,
      adj: Math.round(adj * 10) / 10, status,
    });
  }
  return out;
}
