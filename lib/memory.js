// Background "smart memory": AI chat titles and rolling conversation summaries.
//
// The summary is built ONLY from the user's own messages and the answers the user explicitly
// shared ("Use as context"). Private model answers are never summarized into it, so every
// model keeps an independent view while still remembering requirements and decisions.
import { estTokens } from './context.js';

export const SUMMARY_KEEP_RECENT = 4;          // newest turns always sent verbatim
export const SUMMARY_TRIGGER_TOKENS = 12_000;  // shared history size that triggers summarizing
const trigger = () => Number(process.env.MEMORY_TRIGGER_TOKENS) || SUMMARY_TRIGGER_TOKENS;

export function titlePrompt(firstMessage, firstAnswer) {
  return [
    { role: 'system', content: 'You name chat conversations. Reply with only a title of 3 to 6 words in Title Case. No quotes, no punctuation at the end, no emoji.' },
    { role: 'user', content: `User's first message:\n${firstMessage.slice(0, 2000)}\n\nFirst answer (for context):\n${(firstAnswer || '').slice(0, 1200)}\n\nTitle:` },
  ];
}

export function cleanTitle(raw) {
  const line = String(raw || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  const t = line.replace(/^(title\s*:\s*)/i, '').replace(/^["'“”‘’*#\s]+|["'“”‘’*.\s]+$/g, '').slice(0, 80);
  return t.split(/\s+/).length >= 2 && t.length >= 4 ? t : null;
}

/** Should we (re)summarize? Returns the turns to fold into the summary, or null. */
export function summaryPlan(turns, summaryUpto, decisionsText = '') {
  if (turns.length <= SUMMARY_KEEP_RECENT + 1) return null;
  const foldable = turns.slice(0, turns.length - SUMMARY_KEEP_RECENT);
  const fresh = foldable.filter((t) => !summaryUpto || t.created_at > summaryUpto);
  if (!fresh.length) return null;
  const sharedTokens = turns.reduce((n, t) => n + estTokens(t.user_message) + 400, 0) + estTokens(decisionsText); // ~400/turn for a model's own answer
  return sharedTokens >= trigger() ? { fold: fresh, upto: foldable.at(-1).created_at } : null;
}

export function summaryPrompt(previous, turns, decisions) {
  const msgs = turns.map((t, i) => `${i + 1}. ${t.user_message.replace(/\s+/g, ' ').slice(0, 1500)}`).join('\n');
  return [
    { role: 'system', content: `You maintain the running memory of a long chat between a user and several AI models.
Write a compact summary that lets a model continue the conversation without the old messages.
Use exactly these sections, with short bullet points:
Goal, Requirements and constraints, Decisions made, Facts the user gave, Open questions.
Only use what the user wrote and the decisions they explicitly selected. Do not invent anything.
Keep it under 350 words.` },
    { role: 'user', content: `${previous ? `Current summary:\n${previous}\n\n` : ''}${decisions ? `Decisions the user selected:\n${decisions}\n\n` : ''}New user messages to fold in:\n${msgs}\n\nUpdated summary:` },
  ];
}
