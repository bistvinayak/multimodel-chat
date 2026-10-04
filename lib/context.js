// Context Manager: builds the exact message list for one model on one turn.
//
// Each model gets: shared user messages + ITS OWN prior answers + the decisions the
// user explicitly promoted (from any model). Other models' answers are never
// passed across lanes unless the user promoted them.

export const estTokens = (s) => Math.ceil((s || '').length / 3.5);

const BASE_SYSTEM = `You are one of several AI models answering the same user in a shared multi-model workspace. The user sees each model's answer side by side and picks the best ideas as they go.
- Answer the user's latest message directly and completely.
- Assistant messages earlier in this thread are your own previous answers.
- Where several user messages appear merged together, those turns were answered by other models, not by you.`;

function truncate(s, maxTokens) {
  const maxChars = Math.max(0, Math.floor(maxTokens * 3.5));
  return s.length <= maxChars ? s : s.slice(0, maxChars) + '\n[...truncated]';
}

/**
 * @param db
 * @param {{conversation_id:string, created_at:number, user_message:string}} turn
 * @param {string} modelId
 * @param {{context_length?:number}|null} model
 * @param {number} maxOut  max completion tokens requested
 * @param {Array} pins     'continue' selections applying to this turn
 * @param {Array} skills   [{name, instructions}] the user switched on for this conversation
 */
export function buildContext(db, turn, modelId, model, maxOut, pins, skills = []) {
  const ctxLen = Math.min(model?.context_length || 32_000, 200_000);
  const budget = Math.max(2_000, ctxLen - maxOut - 1_000);

  const priorTurns = db.prepare(
    'SELECT id, user_message FROM turns WHERE conversation_id=? AND created_at < ? ORDER BY created_at'
  ).all(turn.conversation_id, turn.created_at);

  const own = new Map(
    db.prepare(
      `SELECT turn_id, content FROM responses
       WHERE conversation_id=? AND model_id=? AND content <> '' AND status IN ('completed','stopped')`
    ).all(turn.conversation_id, modelId).map((r) => [r.turn_id, r.content])
  );

  const canonical = db.prepare(
    `SELECT s.selected_text, r.model_id FROM context_selections s JOIN responses r ON r.id=s.response_id
     WHERE s.conversation_id=? AND s.selection_type='canonical' AND s.active=1 AND s.created_at < ?
     ORDER BY s.created_at`
  ).all(turn.conversation_id, turn.created_at);

  // Priority 1: current request + system + the user's skills (capped at 20% of budget).
  let system = BASE_SYSTEM;
  if (skills.length) {
    const block = skills.map((k) => `### ${k.name}\n${k.instructions.trim()}`).join('\n\n');
    system += `\n\n## Skills the user turned on\nFollow these instructions in every answer in this conversation.\n\n${truncate(block, budget * 0.2)}`;
  }
  // Priority 2: canonical decisions (capped at 40% of budget).
  if (canonical.length) {
    const block = canonical.map((c, i) => `${i + 1}. (from ${c.model_id})\n${c.selected_text.trim()}`).join('\n\n');
    system += `\n\n## Decisions the user selected as shared context\nThe user explicitly chose these from earlier answers, some written by other models. Treat them as the agreed direction unless the user changes it.\n\n${truncate(block, budget * 0.4)}`;
  }
  if (pins?.length) {
    const block = pins.map((p) => `(from ${p.model_id})\n${p.selected_text.trim()}`).join('\n\n');
    system += `\n\n## Answer the user chose to continue from\nThe user picked this answer as the starting point for their next message:\n\n${truncate(block, budget * 0.25)}`;
  }

  let remaining = budget - estTokens(system) - estTokens(turn.user_message);

  // Priority 3+: recent history, newest first, until the budget runs out.
  const kept = [];
  let i = priorTurns.length - 1;
  for (; i >= 0; i--) {
    const t = priorTurns[i];
    const cost = estTokens(t.user_message) + estTokens(own.get(t.id));
    if (cost > remaining) break;
    remaining -= cost;
    kept.unshift({ user: t.user_message, assistant: own.get(t.id) || null });
  }

  // Older turns that did not fit: keep the user's own words in condensed form
  // so requirements are not silently lost.
  const dropped = priorTurns.slice(0, i + 1);
  if (dropped.length) {
    let lines = dropped.map((t) => `- ${t.user_message.replace(/\s+/g, ' ').slice(0, 240)}`);
    const cap = Math.max(200, budget * 0.15);
    while (lines.length && estTokens(lines.join('\n')) > cap) lines.shift();
    system += `\n\n## Earlier conversation (condensed)\nOlder turns were omitted for length. The user's earlier messages were:\n${lines.join('\n')}`;
  }

  const messages = [{ role: 'system', content: system }];
  const pushUser = (content) => {
    const last = messages[messages.length - 1];
    if (last.role === 'user') last.content += `\n\n---\n\n${content}`;
    else messages.push({ role: 'user', content });
  };
  for (const k of kept) {
    pushUser(k.user);
    if (k.assistant) messages.push({ role: 'assistant', content: k.assistant });
  }
  pushUser(turn.user_message);

  return {
    messages,
    promptTokensEst: messages.reduce((n, m) => n + estTokens(m.content) + 4, 0),
    droppedTurns: dropped.length,
  };
}
