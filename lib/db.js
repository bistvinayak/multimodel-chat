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
