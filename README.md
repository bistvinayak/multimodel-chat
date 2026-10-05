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

Create an account in the browser, pick models, and start chatting. Data lives in `data/app.db` (SQLite, gitignored). `OPENROUTER_API_KEY` is optional if each user adds their own key in Settings.

Personal keys are encrypted with a master key from `APP_SECRET` (64 hex characters), or one generated into `data/secret.key`. Back that file up with the database: without it, saved keys can't be decrypted and users must add them again.

## What's in V1

| Area | What it does |
|---|---|
| Accounts | Email and password sign-up with scrypt hashing and 30-day HttpOnly session cookies that survive server restarts. If a session ends, you return to the same chat after signing in, with your unsent draft kept. Every query is scoped to the signed-in user. Account deletion removes all of the user's data. |
| Model catalog | Live from OpenRouter, with a busy now or responding label from recent traffic. A **Free & best** filter ranks free models by an estimated score: size, reasoning support, context window, recency, live health, and how often people here pick them. **Pick 3 best free models** first sends each top candidate a tiny check request, then picks responding models from different vendors. The catalog is so free status and prices are never hard-coded. Filters for free, fast, reasoning, coding and popular. Routers such as `openrouter/auto` are excluded because they would silently swap models mid-comparison. |
| Parallel turns | One request per model, all concurrent. OpenRouter's `models` fallback array is never used, because it is sequential fallback rather than parallel output. |
| Streaming | Models run on the server, not in the browser. Reloading, switching chats, closing the tab or losing the connection never stops an answer. Each open chat holds one live stream, and on reconnect the server sends a snapshot of everything mid-generation, so you rejoin exactly where the answer is. Several tabs can watch the same chat. Each card shows generating, completed, failed, rate limited or stopped. Stop one model, or press Esc or **Stop all** to stop every one. |
| Failures | Each model fails and retries on its own. With **auto-switch** (on by default), a rate-limited model gets one quick retry. The app then checks the best-ranked alternatives with a tiny request and hands the lane to one that is answering. The stand-in answers the same message right away. You always see it happen: a notice, a "Stand-in for X" badge, and a link from the busy card. The busy model is paused, never removed. Switching stops after 2 stand-ins per lane per turn. Turn auto-switch off in Settings to keep strict comparisons. The app then retries 4 times over about 40s with a countdown, then offers one-click swaps. |
| Context | Shared user messages, plus each model's own history, plus the decisions you selected. Skipped turns are merged so roles still alternate. The "Context sent" button shows the exact messages each model received. |
| Smart memory | When a chat grows long, a free model keeps a rolling summary of your goal, requirements, decisions, facts and open questions. It is built only from your messages and the answers you shared, never from a model's private answers, so each model keeps an independent view. It replaces older turns only when a model's context window can't fit them, and the newest 4 turns are always sent word for word. The chat header shows the current summary. |
| Context window | Token budget per model. Older turns are condensed into a list of your earlier messages instead of being dropped. Selected decisions always survive. |
| Skills | Reusable instructions in the sidebar, such as "Senior PM reviewer" or "Concise answers". Create your own or start from templates. Switch them on per chat, or mark them to switch on automatically for new chats. Active skills go into every model's instructions for that chat. |
| Response actions | Regenerate (earlier answers are kept as versions you can restore), Edit and resend your latest message (click Edit or press ↑ in an empty box), Reply (to the whole answer or a highlighted part; every recipient is told which answer is being replied to), Use as context (whole answer or highlighted part), Continue with this (applies to the next turn only), Ask this model, Copy, Save, Use as final, and Context sent. |
| Choosing who answers | The composer's "Send to" chips let you send a message to all active models, one model, or any subset. Paused models can still be asked directly. The thread shows who was asked. |
| Model lanes | Add, pause, resume or remove models mid-conversation. Free users get at most 3 active models (`MAX_MODELS`). History stays visible after removal. |
| Cost | Cost estimate before sending, real cost, tokens and latency per answer, and running totals per conversation. |
| Convenience | AI-written chat titles. Search across titles, your messages and answers (press `/`). New chats start with the models you used last. Code blocks get syntax highlighting and a Copy button. Cmd/Ctrl+K starts a new chat. |
| File uploads | Attach images (PNG, JPEG, WebP, GIF), PDFs, and text or code files: up to 6 per message, 20 MB each. Use the 📎 button, drag and drop, or paste a screenshot. Files are checked by their actual content, not the name. PDFs are parsed once at upload with OpenRouter's free engine, and every model gets the text. Models that can see get images directly. The others get a detailed description written once by a free vision model, with all visible text transcribed, so every model in a comparison works from the same material. Automatic stand-ins prefer vision models when a message has images. Saved context and traces hold file references, never the file bytes. Files are private to their owner, served with safe headers, and deleted with the chat or account. Files uploaded but never sent are removed after a day. |
| Evaluation (Jev) | **⚖ Evaluate answers** appears under any message with 2 or more answers. In Finish, **Evaluate selected responses** works across messages. The primary evaluator is [Jev](https://docs.typesafe.ai/api) by TypeSafe. Each answer is scored on a rubric with `score` questions (0 Poor to 4 Excellent, with confidence). Groundedness is a `noul` yes/no probability. One blind `choice` question picks the best answer, with probabilities and confidence. The evaluator never sees model names. The default rubric follows the PRD: relevance, completeness, instruction following, clarity and actionability, with optional groundedness and conciseness. Results show as an **Evaluator recommendation**, a score badge on each card, and a "Use as final" button. The app also notes whether you and the evaluator agreed. Scores are mirrored to Langfuse as `eval_*` scores. Without a Jev key, a free OpenRouter model judges on the same rubric, clearly labeled as the fallback. |
| Metrics | A **📊 Metrics** page for AI PMs, filterable by 7, 30 or 90 days, all time, and by chat. It shows messages, model calls, input and output tokens, cost, response time (p50 and p95), time to first token, output speed (tokens per second), failure, rate-limit and automatic-switch counts, the multi-model share, picks, and evaluator–human agreement. Charts: tokens per day, a response-time range per model, evaluator scores by model and criterion, and failure reasons. A per-model table exports to CSV. |
| Price-watch agent | Track product prices and get alerted when they drop. Add a watch from **🔔 Price watches**, with `/watch <link> below 500` in any chat, or by pasting a link with words like "track the price" (the app offers to watch it). Alert on a price at or below a target, a percentage drop, or any drop, checking every 1 to 24 hours. Prices come from structured product data first (JSON-LD, Open Graph product tags, microdata), and a free model reads the visible text only when a page has none. Alerts fire again only on a new low. They appear as an unread badge, an alert list, and a browser notification, and each watch has a price-history chart. "Ask the models" starts a chat about whether it's a good deal. **Safe by design:** every fetch is checked at connect time against private and internal addresses, including after redirects and DNS rebinding. The agent identifies itself honestly, respects robots.txt, waits at least 10 seconds between requests to the same site, backs off on failures, and caps each user at 25 watches. Some stores block automated checks, and the app says so clearly. |
| Compare models | A page (sidebar: **Compare models**) that puts up to 4 models side by side. Catalog facts: price, context window, max answer length, strengths, estimated rank among free models, and whether each is answering right now. Your own data: answers, how often you picked each one when it was shown next to others, response time, time to first token, answer length, cost, and failure rate. The best value in each row is highlighted. It also shows head-to-head records, a personal leaderboard, and a button to start a chat with the models you're comparing. |
| Your own OpenRouter key | In Settings, add your own key so your chats run on your OpenRouter account: your credits, your rate limits, and paid models. The key is checked with OpenRouter before saving, encrypted at rest with AES-256-GCM, and never sent back to the browser. Only the last 4 characters are shown. Settings shows its limit, usage and free requests left today. Without a personal key, chats use the shared `OPENROUTER_API_KEY` if the server has one. |
| Finish | Lists saved and final picks from any model and any turn, with copy and Markdown download. |
| Preference signal | Use, continue, save and final actions log a preference event with the competing responses and display position, ready for selection-rate analytics. |
| Mobile | Answers become tabs per turn instead of squeezed columns. |

## Testing price watches locally

```bash
npm run demo-shop                  # a tiny store at http://127.0.0.1:4330/admin
WATCH_ALLOW_PRIVATE=1 npm start    # let the app read 127.0.0.1 while testing
```

Watch `http://127.0.0.1:4330/product/headphones`. Lower its price on the admin page, then press **Check now**. `/product/text-only-lamp` has no product data, so the AI fallback has to read the price. `/private/...` is blocked by robots.txt. Restart with a plain `npm start` afterwards, because `WATCH_ALLOW_PRIVATE` turns off the private-address protection.

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
lib/memory.js  AI titles + rolling conversation summary
lib/secrets.js AES-256-GCM encryption for personal API keys
lib/attachments.js  file detection, PDF text extraction, image descriptions
lib/evaluator.js   Jev (TypeSafe) evaluation + fallback LLM judge
lib/watch.js       price-watch agent: safe fetch, robots.txt, price extraction, alert rules
```

The API key stays on the server. The browser never sees it.

## Not in V1 yet

These are planned for V1.5 and later, as the PRD describes: Jev evaluation, blind mode, combining responses, and analytics dashboards.
