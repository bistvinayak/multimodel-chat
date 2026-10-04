// In-memory model health from real traffic, so the UI can warn about busy free
// models and suggest alternatives that are actually answering right now.
const h = new Map(); // model_id -> { kind: 'ok'|'limited'|'blocked', at }  (latest event wins)
const BUSY_WINDOW = 3 * 60_000;
const OK_WINDOW = 15 * 60_000;
const BLOCKED_WINDOW = 6 * 60 * 60_000;

const record = (kind) => (id) => { h.set(id, { kind, at: Date.now() }); };
export const recordOk = record('ok');
export const recordLimited = record('limited');
export const recordBlocked = record('blocked');

/** 'busy' | 'ok' | 'blocked' | 'unknown' */
export function healthOf(id, now = Date.now()) {
  const x = h.get(id);
  if (!x) return 'unknown';
  const age = now - x.at;
  if (x.kind === 'blocked' && age < BLOCKED_WINDOW) return 'blocked';
  if (x.kind === 'limited' && age < BUSY_WINDOW) return 'busy';
  if (x.kind === 'ok' && age < OK_WINDOW) return 'ok';
  return 'unknown';
}

export const _reset = () => h.clear();
