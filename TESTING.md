# Testing the app

There are three ways to check the app, from fastest to most hands-on.

## 1. Automated app health check (about 1.5 minutes)

```bash
npm run check
```

It starts a throwaway copy of the app with its own database and demo shop, then walks through every feature like a user would: sign-up, chatting with two models, context rules, replies, regenerate, edit, skills, file uploads, evaluation, compare and metrics, price watches, page agents, the planner, alerts, feedback, privacy between users, the safety guards, and account deletion. Each step is marked ✅ pass, ⚠️ warning (something outside the app got in the way, such as busy free models), or ❌ fail. You can run it from **Metrics → App health check** too.

## 2. AI quality evals (about 2 minutes)

```bash
npm run eval                         # all suites
npm run eval -- --suite relevance    # one suite
npm run eval -- --models a/x:free,b/y:free --suite relevance   # compare models
```

These score each AI step against labeled cases in `evals/datasets/`, with quality gates:

| Suite | Measures | Gate |
|---|---|---|
| Planner | Plain-English request turned into the right agent and fields | case pass rate ≥ 80% |
| Relevance | Jobs and news screening (includes your 👍/👎 as extra cases) | F1 ≥ 0.75 |
| Page judge | Whether a condition is true on a page | accuracy ≥ 85% |
| Price reader | The current price, read from product pages | accuracy ≥ 90% |

Results show under **Metrics → AI quality**. Add a case by editing the JSON files.

## 3. Click-through checklist (about 15 minutes)

Start the demo shop to test price and page agents without touching real stores:

```bash
npm run demo-shop                  # http://127.0.0.1:4330/admin
WATCH_ALLOW_PRIVATE=1 npm start    # local testing only; restart with plain `npm start` after
```

| # | Do this | You should see |
|---|---|---|
| 1 | New conversation → **★ Pick 3 best free models** → ask a question | Three answers stream side by side |
| 2 | Reload the page while answers are streaming | They keep going and finish |
| 3 | **Use as context** on one answer, then ask a follow-up | "Shared context" shows in the header. **Context sent** proves every model got it |
| 4 | **↩ Reply** on an answer, tick a second model, send | The reply quote shows above your message, with "Asked X and Y" |
| 5 | **↻ Regenerate**, then **Versions** | Earlier answers are listed and can be restored |
| 6 | Press ↑ in the empty message box | You can edit your last message and resend it |
| 7 | 📎 attach an image and a PDF | Models that can't see images get a description, and **Context sent** shows the PDF text |
| 8 | **⚖ Evaluate answers** | A recommendation, a score table, and whether it agrees with your pick |
| 9 | 👍 / 👎 on an answer, then 💬 Feedback (bottom left) | It's saved under **Metrics → Feedback** |
| 10 | **Agents** → "New graduate or AI PM roles, London or remote" → Set up | A plan to review, then a jobs agent with real openings |
| 11 | Open the agent, 👎 a result | It disappears. 👍/👎 counts teach the agent |
| 12 | **Agents** → "Tell me when http://127.0.0.1:4330/product/headphones falls below 110, check 5 times a day" | A price watch at USD 129.99 |
| 13 | Lower the price on the demo shop admin page → ⋯ / **Check now** | An alert, a red badge in the sidebar, and an entry under **Alerts** |
| 14 | **Metrics** | Tokens, latency, cost, evaluator scores, AI quality, the health check, and feedback |
| 15 | **Compare** two models | Catalog facts, your pick rates, and head-to-head records |
