# Personal Finance Guru — Build Spec

> A multi-user app where an AI interfaces with a user's real financial data (via Plaid) and additional context to deliver **transparent, grounded** overviews and guidance. This document is written for Claude Code to build from. Build in the phases defined below; do not skip checkpoints.

---

## 0. Core Principles (do not violate)

1. **The AI never computes a number.** Deterministic tools compute every figure. The model only *narrates, prioritizes, and contextualizes* over tool output. If you catch the model summing transactions or deriving a FIRE number in prose, that's a bug.
2. **Every figure carries provenance.** Tool results return `{ data, provenance }`. Provenance = which accounts, as-of timestamp, and the computation applied. Transparency is a structural property, not a prompt instruction.
3. **Money is integer cents** (`BIGINT` in Postgres, `bigint`/`Decimal` in code). Never floats. Ever.
4. **Plaid is the system of record; we never mirror its financial data.** The app is a stateless compute-and-narration layer. Financial data (balances, holdings, transactions) is fetched live from Plaid and held **only ephemerally** — in memory for the life of a request/session — then discarded. Postgres never stores a copy of Plaid's financial datasets. This is a deliberate data-minimization stance: it keeps financial PII out of our durable store, shrinking breach blast radius and compliance scope.
5. **One tool implementation, two front doors.** A shared `core` package is consumed by (a) the app's server-side agent loop and (b) a thin MCP wrapper for Claude Code testing. No duplicated logic.
6. **Constrained workflows.** Each user intent maps to a fixed pipeline of tool calls. The model's freedom is in narration, not in which numbers exist. This is what makes processing predictable *and* auditable.
7. **Educational coach, not licensed advisor.** The guru explains and contextualizes; it does not issue prescriptive directives. Framing and disclaimers reflect this.

---

## 1. Architecture Overview

```
Plaid (sandbox) ──live fetch──▶ in-memory session snapshot (never persisted)
                                     │
Postgres  ── tokens, user context, ──┤
             derived aggregates,      │
             audit trace (no raw PII) │
                           ┌──────────┴────────┐
                           │   core package    │   pure TS, user-scoped by arg
                           │  tools + compute  │
                           │   + workflows     │
                           └──────────┬────────┘
                    ┌─────────┴──────────┐
        ┌───────────┴──────────┐   ┌─────┴───────────────┐
        │  App agent loop      │   │  MCP wrapper (thin) │
        │ (Next.js server)     │   │  for Claude Code    │
        │ intent → workflow →  │   │  testing / power    │
        │ synthesis (Messages) │   │  use                │
        └──────────────────────┘   └─────────────────────┘
```

**Agent loop (app path):** auth → resolve `userId` → (fetch live Plaid data into an in-memory **session snapshot** on session start) → intent router (Haiku) → workflow executor (fixed tool sequence, deterministic, reads the snapshot) → assembles an **evidence bundle** → synthesis model (Sonnet default, Opus for depth) generates narrative grounded in the bundle → response includes structured evidence for the UI's "how I got this" cards. The session snapshot is discarded at session end; only derived aggregates (net worth snapshot) are appended to Postgres — no raw financial data is persisted.

**MCP path:** thin server exposing the **atomic `core` tools** (`listAccounts`, `getBalances`, `netWorth`, `fireProgress`, etc. — not the workflow pipelines), authenticated with a dev token, for interactive testing in Claude Code. This is the Checkpoint 1 harness. In this path, Claude Code (as the MCP client) decides which tools to call and in what order based on the prompt — that's fine for a local dev/testing harness, but it means the MCP path does **not** exercise the same constrained, deterministic workflow pipeline (§5) that the deployed app uses. The `summary_overview` workflow's fixed pipeline logic must be validated on its own (unit/integration test calling the workflow executor directly), not inferred from MCP session behavior.

---

## 2. Recommended Stack (optimize for easy build + deploy)

TypeScript throughout (matches the developer's Node background; single language across app, core, and MCP).

- **App/UI/API/agent loop:** Next.js (App Router) on **Vercel** — app, API routes, agent loop, Plaid fetches, and webhooks all deploy as one unit.
- **DB:** Postgres via **Neon** (Vercel Postgres was sunset; connect Neon/Supabase through the Vercel Marketplace — credentials auto-injected, standard connection string, one bill). Local Postgres for dev.
- **Scheduled jobs:** Vercel Cron (net-worth snapshot job).
- **ORM:** Drizzle (lightweight, SQL-forward). Prisma acceptable.
- **Auth:** Clerk (fastest multi-user path). Auth.js/Supabase Auth acceptable.
- **Aggregation:** Plaid Node SDK (sandbox).
- **AI:** Anthropic SDK. Haiku for intent classification, Sonnet for synthesis, Opus for deep analysis. **Stream** the agent loop and set `maxDuration` — Vercel functions are time-limited.
- **MCP:** `@modelcontextprotocol/sdk` (TypeScript). **Runs locally as a dev/test harness — not deployed for MVP.**
- **Package manager / monorepo tooling:** npm workspaces. No Turborepo for MVP — the package count is small enough that plain workspace scripts are sufficient.
- **Testing:** Vitest for all unit tests, including the `core` compute-function suite (§4).
- **Local dev DB:** Docker Compose Postgres, matching the Postgres major version used on Neon. Migrations run against it via Drizzle.

**Deployment note:** Vercel fits the frontend + serverless-heavy shape of the MVP well. If the agent loop later grows into long-running, background, or containerized work, that's the seam to peel heavy compute onto a worker (Railway/Render/Fly). Not an MVP concern.

**Account/credential status (as of spec finalization):** Plaid sandbox keys and an Anthropic API key are already available. **Clerk account and Neon project still need to be created** — do this as an explicit early step in Phase 1 (Clerk) and before first deploy (Neon), not assumed to pre-exist.

Suggested monorepo layout:
```
/apps/web        → Next.js app (UI + agent loop API)
/apps/mcp        → thin MCP server
/packages/core   → tools, compute, workflows, provenance types
/packages/db     → Drizzle schema + migrations + client
/packages/plaid  → Plaid client + sync + normalization
```

---

## 3. Data Model

Postgres persists **only** tokens, the user's own context, and a PII-free audit trail. It does **not** store Plaid's financial datasets. Amounts that *are* stored (user-set targets/goals) are in cents.

**Persisted in Postgres:**
- **users** — `id`, `auth_provider_id`, `email`, `created_at`. (Clerk owns auth; this mirrors the minimum.)
- **plaid_items** — `id`, `user_id`, `plaid_item_id`, `access_token_encrypted`, `institution_name`, `status`, `created_at`. Access token **encrypted at rest** (AES-GCM, key from secret manager/env; KMS upgrade path). *(No `transactions_cursor`: with no persisted transaction store, use windowed `/transactions/get` on demand rather than cursor-based `/transactions/sync`.)*
- **linked_accounts** *(minimal registry — judgment call, keep or fetch live)* — `id`, `user_id`, `item_id`, `plaid_account_id`, `nickname`, `mask`, `type`, `subtype`. **No balances or values.** Exists only so the UI can show what's connected without a live call.
- **user_profile** — `user_id`, `annual_income_cents`, `target_annual_spend_cents`, `risk_tolerance`, `notes_json`. (User-provided, not Plaid-derived.)
- **goals** — `id`, `user_id`, `type`, `target_cents BIGINT`, `target_date`, `created_at`.
- **networth_snapshots** *(Tier-1 derived aggregate)* — `id`, `user_id`, `as_of_date`, `net_worth_cents BIGINT`, `assets_cents BIGINT`, `liabilities_cents BIGINT`. One row per period; a *computed number*, not raw Plaid data. Enables net-worth-over-time without the transaction ledger.
- **period_summaries** *(Tier-1 derived aggregate, optional)* — `id`, `user_id`, `period`, `metric` (e.g. spend-by-category, savings_rate), `value_json`. Computed rollups for trends.
- **insight_log** — `id`, `user_id`, `workflow`, `params_json`, `tool_calls_json` (tool names + params + **provenance references**, not raw values), `model`, `created_at`. Powers transparency + eval **without persisting financial figures**. Evidence is regenerated live on demand, not stored.

**Derived-aggregate sensitivity:** a net-worth time series is itself sensitive. Protect `networth_snapshots` / `period_summaries` with **DB encryption-at-rest + application-level `user_id` scoping** (§3 Isolation) for MVP, *not* field-level encryption (you need to compute and chart over these values). Row-level security is a Phase 2 addition on top of this, not an MVP requirement. Reserve field-level encryption for Plaid tokens.

**Two-tier persistence policy:**
- **Tier 1 (in MVP):** persist derived aggregates only (above). Raw Plaid data stays ephemeral. Net worth history is derived from balances + holdings at fetch time and appended — **no transaction ledger, no `/transactions/sync` cursor required.**
- **Tier 2 (deferred, feature-gated):** persisting the raw transaction ledger to enable `/transactions/sync` incremental deltas (lower payload, richer transaction search). This *is* the PII-heavy mirror — note that incremental sync only reduces payload *because* you keep the base set. Only adopt when a specific feature justifies the retention/breach tradeoff.

**In-memory only (session snapshot — never persisted):** account balances, holdings, securities, transactions. Modeled as types in the `core` package, populated by live Plaid fetch, discarded at session end.

**Isolation (MVP decision):** application-level scoping only — every `core` tool takes `ctx: { userId }` and every query includes `WHERE user_id = :ctx.userId`, enforced by convention in the `core` package (all DB access goes through it; no ad-hoc queries elsewhere). Postgres **Row-Level Security** is deferred to a Phase 2 hardening pass, not built into Phase 0/1 schema or Drizzle session-variable plumbing. Revisit before onboarding real (non-sandbox) users.

**Chat history caveat:** assistant turns containing figures ("net worth ~$X") are derived PII. Minimize what's retained, and make conversation history **user-deletable**.

---

## 4. Core Package — Tools & Compute

Every tool signature is `(ctx: { userId }, params) => { data, provenance }`.
`provenance = { source: 'db'|'compute', asOf, accountIds?, computation? }`.

**Aggregation (read DB):**
- `listAccounts(ctx)`
- `getBalances(ctx, { accountIds? })`
- `getHoldings(ctx, { accountIds? })`
- `getTransactions(ctx, { from, to, accountIds?, categories? })`

`period` params below are always an explicit `{ from, to }` ISO date range — no shorthand enums (`'current_month'`, `'ytd'`, etc.) inside `core`. Resolving relative phrases ("this month", "last quarter") from user language into concrete dates is the router/workflow layer's job, not the compute layer's — keeps compute functions pure date-range-in, figure-out.

**Compute (pure, deterministic — the only source of derived numbers):**
- `netWorth(ctx)` — assets − liabilities from latest balances, across all account types.
- `cashFlow(ctx, { period })` — inflow/outflow from transactions.
- `savingsRate(ctx, { period })` — (income − spend) / income.
- `spendingByCategory(ctx, { period })` — grouped by Plaid's `personal_finance_category` (primary/detailed) directly; no custom category mapping table.
- `assetAllocation(ctx)` — from holdings + security types.
- `fireProgress(ctx, { annualSpendCents?, multiple=25, withdrawalRate? })` — `annualSpendCents` defaults from profile if omitted. If `withdrawalRate` is provided it overrides `multiple` (target = spend / withdrawalRate); otherwise target = spend × `multiple`. Progress = **investable net worth** / target, where investable net worth = assets from `investment`-type and `depository`-type accounts only, minus liabilities — real estate, vehicles, and other illiquid asset types are excluded even though they count toward `netWorth`.

  **Housing debt is excluded from that subtraction** (`loan` accounts with subtype `mortgage` or `home equity`). Excluding the property while still subtracting the mortgage secured against it charges the user twice for the same house: once in the assets measured, and again through the mortgage payment already inside the `annualSpendCents` that sets the target. Every other liability — credit cards, auto, student — is still subtracted in full, because those payments are not structurally part of a long-run retirement spending figure. `fireProgress` reports the excluded housing debt as `excludedLiabilitiesCents` so it stays visible rather than silently dropped; `netWorth` is unaffected and still counts both the property and its mortgage.

  *Known limitation:* Plaid types a rental property as `other`, identically to a primary residence, so a rental is excluded here even though it does produce withdrawable income. Distinguishing them needs a user-context flag (Phase 1); until then it surfaces as a provenance note.

**Context (write):**
- `getUserContext(ctx)` — profile + goals + notes.
- `setProfile(ctx, { annualIncomeCents?, targetAnnualSpendCents?, riskTolerance? })`
- `setGoal(ctx, goal)`
- `addNote(ctx, note)`

All compute functions unit-tested with fixture data. These tests are the correctness backbone.

---

## 5. Workflows (intent → fixed pipeline)

Router classifies the prompt into one workflow (Haiku, constrained output). Executor runs that workflow's tool sequence deterministically, assembles the evidence bundle, hands it to synthesis.

| Workflow | Tool pipeline |
|---|---|
| `summary_overview` | listAccounts → getBalances → netWorth → assetAllocation → fireProgress |
| `spending_analysis` | getTransactions → spendingByCategory → cashFlow → savingsRate |
| `investment_review` | getHoldings → assetAllocation |
| `goal_progress` | getUserContext → (relevant compute) → fireProgress |
| `transaction_lookup` | getTransactions (filtered) |
| `general_qa` | constrained fallback; may call a bounded subset, else answers from prior evidence only |

**Evidence bundle** = ordered list of `{ tool, params, data, provenance }`. The synthesis prompt requires the model to attribute every figure it states to an entry in the bundle. The bundle is what the UI renders as expandable "why" cards. It is **not** persisted — `insight_log` stores only the reasoning trace (workflow, tool names, params, provenance references); evidence values are regenerated live when a user revisits a "why" card.

---

## 6. AI Identity (feeds the system prompt)

**Persona:** a transparent, grounded financial *coach*, named **Jolly**.

**Principles the system prompt encodes:**
- States only figures present in the evidence bundle; attributes each to its source.
- Educational and contextual, never prescriptive ("here's what your allocation looks like and the tradeoffs" — not "buy X").
- Proactive but not alarmist; surfaces what matters without manufacturing urgency.
- Honest about gaps ("I don't have investment data from this institution yet").
- Includes a standing, non-intrusive disclaimer: educational, not personalized financial advice.

---

## 7. Data Access (live fetch, no durable financial store)

1. **Link:** frontend Plaid Link → `public_token` → server exchanges for `access_token` → store **encrypted** on `plaid_items`. Optionally populate the minimal `linked_accounts` registry (nickname/mask/type only).
2. **Session start:** fetch live into the in-memory session snapshot — balances (`/accounts/balance/get`), holdings (`/investments/holdings/get`), and a transaction window (`/transactions/get`, e.g. last 90 days). One fetch per session, not per question.
3. **Compute + narrate** over the snapshot for the session's duration.
4. **Session end:** discard the snapshot. Nothing financial is written to Postgres.

**Session snapshot on serverless (decided):** Vercel functions are stateless — an "in-memory snapshot" does **not** survive across the turns of a chat (each request may hit a fresh instance). **MVP uses refetch-per-turn**: each chat turn's request re-fetches balances/holdings/transactions live from Plaid into a request-scoped in-memory snapshot, computes, narrates, and discards it. No Upstash/Vercel KV in the MVP — simplest path, nothing cached, no PII briefly at rest in Redis, at the cost of per-turn Plaid latency. A TTL'd Upstash cache is a possible later optimization if per-turn latency proves too high, not built now.

Note: this refetch-per-turn constraint is specific to the **app path** (§1, Vercel serverless). The **MCP path** (Checkpoint 1) runs as a long-lived local process, so a true in-memory session snapshot across tool calls works there without this workaround.

**Append derived aggregates:** after computing `netWorth` for a session, append a `networth_snapshots` row (and optionally `period_summaries`). This is the only financial data that persists, and it's derived, not raw.

Cost tradeoff (accepted): live fetch adds per-session latency — transactions are the heaviest — in exchange for holding no raw financial PII at rest. Never store bank credentials; only the encrypted Plaid token.

---

## 8. Phases & Checkpoints

Build strictly in order. The two riskiest unknowns — **can we get clean data in** and **is the guidance good** — are validated at Checkpoints 1 and 2 respectively.

### Phase 0 — Foundations & the Data Pipe → **Checkpoint 1: Summary E2E**
Scope: monorepo + env; Postgres schema + migrations (tokens/context/audit only); Plaid sandbox Link + token exchange + encrypted storage; live-fetch layer that builds the in-memory session snapshot; core aggregation tools (reading the snapshot) + `netWorth`, `assetAllocation`, `fireProgress`; `summary_overview` workflow executor (tested directly, not via MCP — see §1 MCP path note); thin MCP wrapper exposing the atomic tools.

**Checkpoint 1 acceptance** (two parts, both required):
1. **Pipeline correctness:** a direct test/script invocation of the `summary_overview` workflow executor (not through MCP) returns a **correct, provenance-backed** evidence bundle computed from a live-fetched sandbox snapshot. This proves Plaid → live fetch → normalize → tools → fixed pipeline works end to end, with no financial data persisted.
2. **Tool correctness in situ:** in Claude Code, connected to the MCP server as a sandbox user, ask for a financial summary and get a correct answer built from the atomic tools (`listAccounts` → `getBalances` → `netWorth` → `assetAllocation` → `fireProgress`, called by Claude Code itself in that session). This validates the atomic tools work correctly when driven live, independent of the fixed-pipeline test in (1).

No UI, no auth yet.

### Phase 1 — Multi-user MVP → **Checkpoint 2: Demoable MVP**
Scope: Clerk auth + user store; per-user Plaid Link flow in the UI; app-side agent loop (intent router → workflow executor → synthesis via Messages API); web UI (connect accounts, summary dashboard, chat, evidence/"why" cards); remaining workflows (`spending_analysis`, `investment_review`, `goal_progress`, `transaction_lookup`); context tools (profile, goals, notes).

**Checkpoint 2 acceptance:** A new user can sign up, link a sandbox institution, see a transparent summary dashboard, and ask follow-up questions in chat — each answer showing traceable evidence. Deployed to Vercel + managed Postgres. **This is the demoable product.**

### Phase 2 — AI Sophistication, Identity & Transparency
Scope: formalized identity/system prompt; hardened constrained-workflow router; deepened evidence rendering (every figure traceable to source in the UI); `insight_log` wired for transparency + eval; proactive insights and goal tracking over time; model routing + cost controls; **SnapTrade adapter** behind the aggregator interface for brokerage depth.

---

## 9. Security Checklist (multi-user financial data)

- Plaid access tokens encrypted at rest (AES-GCM; key in secret manager/env; KMS upgrade path).
- Every DB query scoped by `user_id`, enforced by the `core` package (§3 Isolation). Postgres RLS deferred to Phase 2 hardening, not MVP.
- Plaid webhook signature verification.
- No bank credentials stored — ever.
- **No raw Plaid financial data at rest** — balances, holdings, transactions live only in a request-scoped in-memory session snapshot, refetched per chat turn (§7). No Redis/KV cache in MVP. Only *derived aggregates* (net worth snapshots, period summaries) persist, protected by encryption-at-rest.
- Chat history minimized and user-deletable (assistant turns can contain derived financial figures).
- Secrets never in the repo; `.env` for dev, secret manager for deploy.
- (Developer action item) Confirm employer outside-activity/IP policy before real (non-sandbox) data.

---

## 10. Explicit Non-Goals for MVP
- SnapTrade / any second aggregator (Phase 2).
- Writing edits back into external documents.
- Prescriptive trade recommendations.
- Real (non-sandbox) financial institutions until security checklist + employer check are cleared.
- Persisting the raw Plaid **transaction ledger** (Tier 2). Deferred until a feature justifies the retention tradeoff. *Note:* Tier-1 derived aggregates (net worth snapshots, period summaries) **are** in scope — those are computed numbers, not a raw-data mirror.