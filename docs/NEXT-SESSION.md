# Kickoff prompt for the next session

Paste the block below into a fresh Claude Code session in this repo.

Keep it current: once Phase 1 is underway, the "build in this order" list and the two
up-front decisions will be stale. Rewrite them rather than leaving a confidently wrong
prompt in place.

---

```
Start Phase 1 of this build — the multi-user MVP, ending at Checkpoint 2 (§8).

Before writing any code:
1. Read docs/STATE.md. It has where Phase 0 landed, what is deliberately NOT built,
   known gaps, and open decisions. CLAUDE.md is the spec and is already in your context.
2. Verify the environment still works rather than assuming it: `npm run db:up`,
   `npm run db:migrate`, `npm test`, and `npm run link:sandbox -- --show`. Tell me if
   anything is off before building on it.

Two decisions I want to settle before you start:

- The `pfg` namespace (npm scope, Docker container, Postgres role, MCP server key) was
  invented during scaffolding, not taken from the spec. Renaming is cheapest now, before
  Neon and Vercel config reference it. Recommend keep or rename, and say what it costs.
- I still need to create the Clerk and Neon accounts. Tell me exactly what to sign up for,
  which keys you need, and where they go — I will do the signups and paste values into
  .env myself. Never put real values in .env.example; it is the committed one.

Then build in this order, checking in with me between steps:

1. Clerk auth + user store — everything else is user-scoped, so this comes first.
2. Next.js app skeleton + real Plaid Link flow (§7.1), replacing scripts/link-sandbox-item.ts.
3. Agent loop: intent router (Haiku) → workflow executor → synthesis (Sonnet). The executor
   exists and is tested; wrap it. This is the first time a model is actually in the loop —
   there is no synthesis code, no system prompt, and no Anthropic SDK in the repo today.
4. The remaining five workflows. Mostly assembly: every compute function they need is built
   and unit-tested. Register each in packages/core/src/workflows/index.ts as it lands.
5. Dashboard, chat, and evidence "why" cards rendering the bundle.

Constraints from CLAUDE.md that are not negotiable — flag it if something forces a tradeoff
against them rather than quietly working around it:

- The AI never computes a number. Deterministic tools compute; the model narrates and
  attributes. Catching the model doing arithmetic in prose is a bug, not a style issue.
- Money is integer cents as bigint. dollarsToCents at the Plaid boundary is the only
  function allowed to touch a float.
- No raw Plaid financial data at rest. Balances, holdings, and transactions live only in a
  request-scoped in-memory snapshot. Only derived aggregates persist.
- Every DB query is scoped by ctx.userId, enforced in the core package.
- Educational coach, not advisor. Explains and contextualises; never prescriptive.

Add tests as you go — the compute suite is the correctness backbone and Phase 1 should not
regress it. I handle all git commits myself; don't commit or offer to.
```
