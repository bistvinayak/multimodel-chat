// Sends chats created before Langfuse was configured. Each turn becomes a trace, each stored
// model answer a generation (the latest attempt, with the exact context that was sent).
//   node scripts/langfuse-backfill.js                 # every conversation not yet traced
//   node scripts/langfuse-backfill.js <conversation>  # one conversation (re-sends it)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.js';
import * as lf from '../lib/langfuse.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
if (!lf.enabled()) { console.error('Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env first.'); process.exit(1); }

const db = openDb(process.env.DB_PATH || path.join(ROOT, 'data', 'app.db'));
const only = process.argv[2];
const convs = only ? db.prepare('SELECT * FROM conversations WHERE id=?').all(only) : db.prepare('SELECT * FROM conversations ORDER BY created_at').all();
let turnsSent = 0, gens = 0;
for (const conv of convs) {
  const user = db.prepare('SELECT id FROM users WHERE id=?').get(conv.user_id);
  const turns = db.prepare('SELECT * FROM turns WHERE conversation_id=? ORDER BY created_at').all(conv.id);
  turns.forEach((turn, i) => {
    if (turn.traced && !only) return;
    const responses = db.prepare('SELECT * FROM responses WHERE turn_id=? ORDER BY display_position').all(turn.id);
    for (const resp of responses.filter((r) => r.status !== 'pending')) {
      const spanId = resp.trace_span_id || lf.newSpanId();
      const startedAt = resp.finished_at && resp.latency_ms ? resp.finished_at - resp.latency_ms : resp.created_at;
      lf.enqueue(lf.generationSpan({ conv, user, turn, resp, spanId, startedAt, messages: resp.context_snapshot ? JSON.parse(resp.context_snapshot) : null, maxOut: undefined }));
      db.prepare('UPDATE responses SET trace_span_id=? WHERE id=?').run(spanId, resp.id);
      gens++;
    }
    const skills = db.prepare(`SELECT k.name FROM conversation_skills cs JOIN skills k ON k.id=cs.skill_id WHERE cs.conversation_id=?`).all(conv.id);
    lf.enqueue(lf.turnSpan({ conv, user, turn, responses, skills, decisions: 0, turnIndex: i + 1 }));
    db.prepare('UPDATE turns SET traced=1 WHERE id=?').run(turn.id);
    turnsSent++;
  });
}
await lf.flush();
console.log(`Sent ${turnsSent} turns and ${gens} generations from ${convs.length} conversation(s). Dropped: ${lf.stats.spans_dropped}.${lf.stats.last_error ? ' Last error: ' + lf.stats.last_error : ''}`);
