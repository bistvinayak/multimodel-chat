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
| Accounts | Email and password sign-up with scrypt hashing and HttpOnly session cookies. Every query is scoped to the signed-in user. Account deletion removes all of the user's data. |
| Model catalog | Live from OpenRouter, with a busy now or responding label from recent traffic, so free status and prices are never hard-coded. Filters for free, fast, reasoning, coding and popular. Routers such as `openrouter/auto` are excluded because they would silently swap models mid-comparison. |
| Parallel turns | One request per model, all concurrent. OpenRouter's `models` fallback array is never used, because it is sequential fallback rather than parallel output. |
| Streaming | Each card streams independently and shows generating, completed, failed, rate limited or stopped. You can stop one model without stopping the others. |
| Failures | Each model fails and retries on its own. Rate limits retry the same model 4 times with backoff (about 40s), and the card shows a live countdown. After that, the card explains the problem in plain language, keeps the raw provider error under Technical details, and offers one-click swaps to free models that are responding right now. A swap pauses the busy model, never removes it, and is always the user's explicit choice. |
| Context | Shared user messages, plus each model's own history, plus the decisions you selected. Skipped turns are merged so roles still alternate. The "Context sent" button shows the exact messages each model received. |
| Context window | Token budget per model. Older turns are condensed into a list of your earlier messages instead of being dropped. Selected decisions always survive. |
| Response actions | Use as context (whole answer or highlighted part), Continue with this (applies to the next turn only), Ask this model, Copy, Save, Use as final, and Context sent. |
| Model lanes | Add, pause, resume or remove models mid-conversation. Free users get at most 3 active models (`MAX_MODELS`). History stays visible after removal. |
| Cost | Cost estimate before sending, real cost, tokens and latency per answer, and running totals per conversation. |
| Finish | Lists saved and final picks from any model and any turn, with copy and Markdown download. |
| Preference signal | Use, continue, save and final actions log a preference event with the competing responses and display position, ready for selection-rate analytics. |
| Mobile | Answers become tabs per turn instead of squeezed columns. |

## Architecture

```
public/        vanilla JS frontend (no build step)
server.js      HTTP API + static files
lib/db.js      SQLite schema (users, conversations, conversation_models, turns,
               responses, context_selections, preference_events)
lib/context.js Context Manager: builds each model's message list per turn
lib/openrouter.js  streaming client + error classification
lib/models.js  live catalog + tags
```

The API key stays on the server. The browser never sees it.

## Not in V1 yet

These are planned for V1.5 and later, as the PRD describes: Jev evaluation, blind mode, model recommendations, LLM conversation summaries (V1 condenses older turns with a simple rule instead), combining responses, and analytics dashboards.
