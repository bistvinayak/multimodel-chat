import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  preferences TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  conversation_summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at);
CREATE TABLE IF NOT EXISTS conversation_models (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',          -- active | paused | removed
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (conversation_id, model_id)
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message TEXT NOT NULL,
  mode TEXT NOT NULL,                              -- all | single
  target_models TEXT NOT NULL,                     -- JSON array
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_conv ON turns(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  served_model TEXT,
  provider TEXT,
  display_position INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  reasoning TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | generating | completed | failed | rate_limited | stopped
  error_kind TEXT,
  error TEXT,
  finish_reason TEXT,
  latency_ms INTEGER,
  first_token_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost REAL,
  context_snapshot TEXT,                           -- JSON of the exact messages sent
  saved INTEGER NOT NULL DEFAULT 0,
  final INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resp_turn ON responses(turn_id);
CREATE INDEX IF NOT EXISTS idx_resp_conv_model ON responses(conversation_id, model_id);
CREATE TABLE IF NOT EXISTS context_selections (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  selected_text TEXT NOT NULL,
  selection_type TEXT NOT NULL,                    -- canonical | continue
  active INTEGER NOT NULL DEFAULT 1,
  consumed_turn_id TEXT,                           -- for 'continue': the turn it was applied to
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,                 -- switched on for new conversations
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id, name);
CREATE TABLE IF NOT EXISTS conversation_skills (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, skill_id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,       -- NULL until sent with a message
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                                          -- image | pdf | text
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',                        -- processing | ready | failed
  error TEXT,
  text_content TEXT,                                           -- text files, extracted PDF text
  description TEXT,                                            -- for models that cannot see images
  description_model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_turn ON attachments(conversation_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_att_user ON attachments(user_id, created_at);
CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT,                                                -- set when all candidates answer the same message
  evaluator TEXT NOT NULL,                                     -- jev | llm-judge
  evaluator_model TEXT,
  criteria TEXT NOT NULL,                                      -- JSON array
  candidates TEXT NOT NULL,                                    -- JSON array of response ids
  recommended_response TEXT,
  recommended_confidence REAL,
  probabilities TEXT,                                          -- JSON: response id -> probability (Jev choice)
  input_tokens INTEGER, output_tokens INTEGER,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_conv ON evaluations(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS evaluation_scores (
  evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  response_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  criterion TEXT NOT NULL,                                     -- a rubric key, or 'overall'
  score REAL,                                                  -- 0..4 (overall: 0..100)
  confidence REAL,
  PRIMARY KEY (evaluation_id, response_id, criterion)
);
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  condition TEXT NOT NULL,                                     -- below | drop_pct | any_drop
  target_price REAL, drop_pct REAL,
  currency TEXT,
  baseline_price REAL, last_price REAL, lowest_price REAL, last_notified_price REAL,
  in_stock INTEGER,
  method TEXT,                                                 -- structured | ai
  interval_minutes INTEGER NOT NULL DEFAULT 360,
  status TEXT NOT NULL DEFAULT 'active',                       -- active | paused | error
  last_error TEXT, failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER, next_check_at INTEGER NOT NULL,
  conversation_id TEXT,                                        -- chat it was created from, if any
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_due ON watches(status, next_check_at);
CREATE TABLE IF NOT EXISTS watch_checks (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  price REAL, currency TEXT, in_stock INTEGER,
  ok INTEGER NOT NULL, error TEXT, method TEXT, model TEXT
);
CREATE INDEX IF NOT EXISTS idx_wcheck ON watch_checks(watch_id, checked_at);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT, url TEXT, watch_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at);
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                          -- jobs | news | page
  name TEXT NOT NULL,
  request TEXT,                                                -- the user's own words, if made from a request
  query TEXT, location TEXT, exclude TEXT, criteria TEXT, url TEXT,
  sources TEXT NOT NULL DEFAULT '[]', companies TEXT NOT NULL DEFAULT '[]',
  interval_minutes INTEGER NOT NULL DEFAULT 720,
  status TEXT NOT NULL DEFAULT 'active',
  state TEXT NOT NULL DEFAULT '{}',                            -- page watcher: last hash / last met
  last_run_at INTEGER, next_run_at INTEGER NOT NULL, last_error TEXT, failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mon_due ON monitors(status, next_run_at);
CREATE TABLE IF NOT EXISTS monitor_items (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  source TEXT, url TEXT, title TEXT, snippet TEXT, company TEXT, location TEXT,
  published_at INTEGER, found_at INTEGER NOT NULL,
  score REAL, reason TEXT, relevant INTEGER NOT NULL DEFAULT 0, dismissed INTEGER NOT NULL DEFAULT 0,
  feedback INTEGER,                                            -- 1 useful, -1 not relevant (user)
  feedback_at INTEGER,
  UNIQUE (monitor_id, dedupe_key)
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                          -- bug | idea | question | praise
  message TEXT NOT NULL,
  route TEXT, context TEXT,                                    -- JSON: browser, viewport, chat, recent client errors
  screenshot TEXT,                                             -- optional data URL (capped)
  status TEXT NOT NULL DEFAULT 'new',                          -- new | triaged | done
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pins (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                                        -- message | answer | note
  turn_id TEXT, response_id TEXT, model_id TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pins_conv ON pins(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS preference_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  event_type TEXT NOT NULL,                        -- use_as_context | continue | save | final
  winning_response TEXT NOT NULL,
  winning_model TEXT NOT NULL,
  compared_responses TEXT NOT NULL,                -- JSON array of response ids shown alongside
  compared_models TEXT NOT NULL,                   -- JSON array
  display_position INTEGER,
  task_type TEXT,
  created_at INTEGER NOT NULL
);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  // Lightweight migrations for databases created by earlier versions.
  const turnCols = db.prepare('PRAGMA table_info(turns)').all().map((c) => c.name);
  if (!turnCols.includes('reply_to_response')) db.exec('ALTER TABLE turns ADD COLUMN reply_to_response TEXT');
  if (!turnCols.includes('reply_quote')) db.exec('ALTER TABLE turns ADD COLUMN reply_quote TEXT');
  const respCols = db.prepare('PRAGMA table_info(responses)').all().map((c) => c.name);
  if (!respCols.includes('replaced_by')) db.exec('ALTER TABLE responses ADD COLUMN replaced_by TEXT');      // stand-in response id
  if (!respCols.includes('stands_in_for')) db.exec('ALTER TABLE responses ADD COLUMN stands_in_for TEXT');  // response it replaced
  if (!respCols.includes('auto_switched')) db.exec('ALTER TABLE responses ADD COLUMN auto_switched INTEGER NOT NULL DEFAULT 0');
  if (!turnCols.includes('traced')) db.exec('ALTER TABLE turns ADD COLUMN traced INTEGER NOT NULL DEFAULT 0');   // Langfuse root span sent
  if (!respCols.includes('trace_span_id')) db.exec('ALTER TABLE responses ADD COLUMN trace_span_id TEXT');     // latest Langfuse generation span
  const convCols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
  if (!convCols.includes('summary_upto')) db.exec('ALTER TABLE conversations ADD COLUMN summary_upto INTEGER');
  if (!convCols.includes('title_source')) db.exec("ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto'"); // auto | ai | user
  if (!respCols.includes('versions')) db.exec("ALTER TABLE responses ADD COLUMN versions TEXT NOT NULL DEFAULT '[]'");             // earlier answers
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('openrouter_key_enc')) db.exec('ALTER TABLE users ADD COLUMN openrouter_key_enc TEXT');      // AES-GCM encrypted
  if (!userCols.includes('openrouter_key_last4')) db.exec('ALTER TABLE users ADD COLUMN openrouter_key_last4 TEXT');
  if (!userCols.includes('openrouter_key_added_at')) db.exec('ALTER TABLE users ADD COLUMN openrouter_key_added_at INTEGER');
  if (!userCols.includes('jev_key_enc')) db.exec('ALTER TABLE users ADD COLUMN jev_key_enc TEXT');
  if (!userCols.includes('jev_key_last4')) db.exec('ALTER TABLE users ADD COLUMN jev_key_last4 TEXT');
  if (!userCols.includes('trial_used')) db.exec('ALTER TABLE users ADD COLUMN trial_used INTEGER NOT NULL DEFAULT 0'); // messages sent on the shared key
  if (!respCols.includes('rating')) db.exec('ALTER TABLE responses ADD COLUMN rating INTEGER');                         // user 👍 1 / 👎 -1
  if (!respCols.includes('key_source')) db.exec('ALTER TABLE responses ADD COLUMN key_source TEXT');                    // personal | shared
  // Anything left mid-generation by a crash/restart is no longer running.
  db.prepare(`UPDATE responses SET status='stopped', error='Interrupted by server restart', error_kind='interrupted'
              WHERE status='generating'`).run();
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
