# Kickoff prompt for the next session

Paste the block below into a fresh Claude Code session in this repo.

Keep it current. This file has already gone stale once — it still said "Start Phase 1" after
Phase 1 was built, and was only harmless because its first instruction is "read STATE.md."
Rewrite it when the work it describes is done rather than leaving a confidently wrong prompt
in place.

---

```
Take this build to Checkpoint 2 (§8) — deploy, then prove it works as a brand-new user.

Before writing any code:
1. Read docs/STATE.md. It has where things stand, what is deliberately NOT built, known gaps,
   and open decisions. CLAUDE.md is the spec and is already in your context. Pay attention to
   "What is left for Checkpoint 2" and "Before deploy, worth doing" — that is your scope.
2. Verify the environment rather than assuming it: `npm run db:up`, `npm run db:migrate`,
   `npm test`, `npm run typecheck`, and `npm run link:sandbox -- --show`. Tell me if anything
   is off before building on it. Note that Docker Desktop is often not running on this machine
   and 7 tests in packages/core/src/tools/users.test.ts need Postgres — if you see ECONNREFUSED
   on :5433, that is the cause, not a regression.

Phase 1 is functionally complete: Clerk auth, Plaid Link UI, the agent loop, all six workflows,
the dashboard, chat, evidence cards, and the §0.1 attribution guard are all built and tested.
Do not rebuild any of it. What remains is deployment and the acceptance run.

Work in this order, checking in with me between steps:

1. **I create the Neon project** through the Vercel Marketplace — tell me exactly what to pick
   (Postgres version, region) and which env vars you need where. I do all signups and paste
   values into .env myself. Never put real values in .env.example; it is the committed one.
2. **Pre-deploy hygiene**, both listed in STATE.md: migrate off Clerk's deprecated
   `createRouteMatcher`, and settle `/api/plaid/webhook` — it is allowlisted as a public route
   in proxy.ts but no handler exists, so §9's webhook-signature item is currently not met.
   Either write the handler or drop the allowlist entry; do not leave it implying a route.
3. **Deploy to Vercel.** Confirm the plan actually honours `maxDuration = 120` on /api/chat
   before assuming it — a retried synthesis makes that the longest path in the app. Generate a
   fresh TOKEN_ENCRYPTION_KEY for production; do not reuse the dev one.
4. **The acceptance run.** Sign up as a genuinely new user, link First Platypus through the UI,
   set a spend target through the dashboard, and ask follow-ups. Every figure must trace to an
   evidence card. This is the Checkpoint 2 gate, and it has never been done.

Constraints from CLAUDE.md that are not negotiable — flag it if something forces a tradeoff
against them rather than quietly working around it:

- The AI never computes a number. Deterministic tools compute; the model narrates and
  attributes. checkAttribution() enforces this; a figure it cannot match is a bug, not noise
  to be tuned away.
- Money is integer cents as bigint. dollarsToCents is the only function allowed to touch a
  float, and it belongs on the server — do not parse an amount into a number in the browser.
- No raw Plaid financial data at rest. Balances, holdings, and transactions live only in a
  request-scoped in-memory snapshot. Only derived aggregates persist.
- Every DB query is scoped by ctx.userId, enforced in the core package.
- Educational coach, not advisor. Explains and contextualises; never prescriptive.

Add tests as you go — the compute suite is the correctness backbone. Note that a passing suite
is not proof of a correct assertion: the rolling-window date bug survived a test that checked
those exact dates for the wrong property. I handle all git commits myself; don't commit or
offer to.
```
