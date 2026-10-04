# Multi-Model Workspace

One conversation. Multiple AI models. One shared context. Pick the best response as you go.

Ask up to three models the same question on every turn and watch them stream side by side. Promote the best answer, or a highlighted part of it, into shared context, and every model builds on it from the next turn. Each model keeps its own reasoning thread. Other models' answers are only shared when you choose to share them.

This is the V1 (P0) scope of the product requirements document.

## Run it

Requires Node.js 22.13 or newer. There are no npm dependencies: it uses Node's built-in `node:sqlite`, `fetch` and `http`.

```bash
cp .env.example .env       # then put your OpenRouter key in .env
npm start                  # http://127.0.0.1:3210
npm test                   # context-manager and error-mapping tests
```

Create an account in the browser, pick models, and start chatting. Data lives in `data/app.db` (SQLite, gitignored).

## What's in V1

| Area | What it does |
|---|---|
| Accounts | Email and password sign-up with scrypt hashing and 30-day HttpOnly session cookies that survive server restarts. If a session ends, you return to the same chat after signing in, with your unsent draft kept. Every query is scoped to the signed-in user. Account deletion removes all of the user's data. |
| Model catalog | Live from OpenRouter, with a busy now or responding label from recent traffic. A **Free & best** filter ranks free models by an estimated score: size, reasoning support, context window, recency, live health, and how often people here pick them. **Pick 3 best free models** first sends each top candidate a tiny check request, then picks responding models from different vendors. The catalog is so free status and prices are never hard-coded. Filters for free, fast, reasoning, coding and popular. Routers such as `openrouter/auto` are excluded because they would silently swap models mid-comparison. |
| Parallel turns | One request per model, all concurrent. OpenRouter's `models` fallback array is never used, because it is sequential fallback rather than parallel output. |
| Streaming | Each card streams independently and shows generating, completed, failed, rate limited or stopped. You can stop one model without stopping the others. |
| Failures | Each model fails and retries on its own. With **auto-switch** (on by default), a rate-limited model gets one quick retry. The app then checks the best-ranked alternatives with a tiny request and hands the lane to one that is answering. The stand-in answers the same message right away. You always see it happen: a notice, a "Stand-in for X" badge, and a link from the busy card. The busy model is paused, never removed. Switching stops after 2 stand-ins per lane per turn. Turn auto-switch off in Settings to keep strict comparisons. The app then retries 4 times over about 40s with a countdown, then offers one-click swaps. |
| Context | Shared user messages, plus each model's own history, plus the decisions you selected. Skipped turns are merged so roles still alternate. The "Context sent" button shows the exact messages each model received. |
| Context window | Token budget per model. Older turns are condensed into a list of your earlier messages instead of being dropped. Selected decisions always survive. |
| Skills | Reusable instructions in the sidebar, such as "Senior PM reviewer" or "Concise answers". Create your own or start from templates. Switch them on per chat, or mark them to switch on automatically for new chats. Active skills go into every model's instructions for that chat. |
| Response actions | Reply (to the whole answer or a highlighted part; every recipient is told which answer is being replied to), Use as context (whole answer or highlighted part), Continue with this (applies to the next turn only), Ask this model, Copy, Save, Use as final, and Context sent. |
| Choosing who answers | The composer's "Send to" chips let you send a message to all active models, one model, or any subset. Paused models can still be asked directly. The thread shows who was asked. |
| Model lanes | Add, pause, resume or remove models mid-conversation. Free users get at most 3 active models (`MAX_MODELS`). History stays visible after removal. |
| Cost | Cost estimate before sending, real cost, tokens and latency per answer, and running totals per conversation. |
| Finish | Lists saved and final picks from any model and any turn, with copy and Markdown download. |
| Preference signal | Use, continue, save and final actions log a preference event with the competing responses and display position, ready for selection-rate analytics. |
| Mobile | Answers become tabs per turn instead of squeezed columns. |

## Langfuse tracing

Add your keys to `.env` and restart. Every chat is then traced:

| Langfuse | What it holds |
|---|---|
| Session | One chat (session id = conversation id) |
| Trace | One message you sent: your text, reply target, mode, models asked, active skills, and every model's final answer |
| Generation | One model run: the exact messages sent, the answer and reasoning, token usage, cost, latency, time to first token, provider, status and level |
| Events | Rate-limit retries and automatic switches, on the generation where they happened |
| Scores | Your choices: `user_use_as_context`, `user_continue`, `user_save`, `user_final`, attached to the chosen answer |

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com    # or https://us.cloud.langfuse.com, or self-hosted
LANGFUSE_LOG_CONTENT=true                   # false = metadata only, no prompts or answers
npm run langfuse:backfill                   # optional: send chats from before tracing was on
```

It uses Langfuse's OpenTelemetry endpoint and needs no SDK. Langfuse Cloud shuts down the legacy ingestion API for traces on 2026-11-16. User ids are opaque UUIDs, and emails are never sent. Tracing runs in the background with retries, so a Langfuse outage never slows or breaks a chat. The chat header links to the session, each answer links to its trace, and Settings shows the connection status.

## Architecture

```
public/        vanilla JS frontend (no build step)
server.js      HTTP API + static files
lib/db.js      SQLite schema (users, conversations, conversation_models, turns,
               responses, context_selections, preference_events)
lib/context.js Context Manager: builds each model's message list per turn
lib/openrouter.js  streaming client + error classification
lib/models.js  live catalog + tags
lib/langfuse.js    OTLP tracing + scores for Langfuse
lib/health.js  live model health from real traffic
```

The API key stays on the server. The browser never sees it.

## Not in V1 yet

These are planned for V1.5 and later, as the PRD describes: Jev evaluation, blind mode, model recommendations, LLM conversation summaries (V1 condenses older turns with a simple rule instead), combining responses, and analytics dashboards.
