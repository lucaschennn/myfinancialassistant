# Personal Finance Guru — Build Spec

> A multi-user app where an AI interfaces with a user's real financial data — from an aggregator (Plaid) or from the user's own statements and exports — plus additional context, to deliver **transparent, grounded** overviews and guidance. This document is written for Claude Code to build from. Build in the phases defined below; do not skip checkpoints.
>
> **Phase 2 is document ingestion; Phase 3 is the developer playground; deployment moved to Phase 4.** See §8 for why. `docs/STATE.md` is where things actually stand; `docs/PHASE-2-INGESTION.md` is the buildable detail for the current phase and `docs/PHASE-3-PLAYGROUND.md` for the next. `docs/how-jolly-works.html` is the visual guide.

---

## 0. Core Principles (do not violate)

1. **The AI never computes a number.** Deterministic tools compute every figure. The model only *narrates, prioritizes, and contextualizes* over tool output. If you catch the model summing transactions or deriving a FIRE number in prose, that's a bug.
2. **Every figure carries provenance.** Tool results return `{ data, provenance }`. Provenance = which accounts, as-of timestamp, and the computation applied. Transparency is a structural property, not a prompt instruction. **This extends to the work itself, not only the figures:** because §7 refetches live from Plaid on every turn rather than caching, each screen and each answer has a real network cost, and that cost is disclosed where it is incurred rather than hidden behind a spinner. A user should be able to see which of our routes ran and which external services were called on their behalf. See §8 Phase 1.5.
3. **Money is integer cents** (`BIGINT` in Postgres, `bigint`/`Decimal` in code). Never floats. Ever.
4. **Never mirror a system of record we do not own.** Where an external system already holds the authoritative copy of a financial dataset, we do not keep a second one. Plaid is such a system: balances, holdings, and transactions are fetched live and held **only ephemerally** — in memory for the life of a request — then discarded. Postgres never stores a copy of Plaid's financial datasets. This is a deliberate data-minimization stance: it keeps financial PII out of our durable store, shrinking breach blast radius and compliance scope.

   **The corollary, added in Phase 2:** a dataset with *no* external system of record has to be stored by us or it does not exist. A CSV export or a PDF statement the user uploads is authoritative precisely because they handed it over; there is nothing to refetch it from. So manually-sourced financial data **is** persisted — the original document and the ledger derived from it. This is not a relaxation of the principle, it is the same principle applied to a different fact pattern, and the test for which regime applies is mechanical: *can we get this back from somewhere else on demand?* If yes, do not keep it. If no, keep it, encrypt it, and let the user delete it.

   The two regimes must stay **visibly** distinct rather than blurring into "we store some financial data now." Every account, balance, holding, and transaction carries its `source`, every figure's provenance names the sources behind it, and the UI says which is which. See §7 and §3.
5. **One tool implementation, two front doors.** A shared `core` package is consumed by (a) the app's server-side agent loop and (b) a thin MCP wrapper for Claude Code testing. No duplicated logic. The Phase 3 playground is a third consumer of the same `core` and the same tool catalog, not a reimplementation. Anything it needs to vary becomes a parameter of the production function with today's value as the default.
6. **Constrained workflows.** Each user intent maps to a fixed pipeline of tool calls. The model's freedom is in narration, not in which numbers exist. This is what makes processing predictable *and* auditable.
7. **Educational coach, not licensed advisor.** The guru explains and contextualizes; it does not issue prescriptive directives. Framing and disclaimers reflect this.
8. **Extraction is transcription, not computation.** §0.1 forbids the model from *deriving* a figure. Reading a figure off a bank statement is a different act, and Phase 2 permits it under a guard as strict as the one §0.1 gets: the model may only emit the **verbatim string** it claims to have read, never a parsed number; a deterministic function converts that string to cents; the string must be found in the document's own extracted text or the row is rejected as hallucinated; and nothing enters the ledger until a human has confirmed it. A number the model invented and a number it transcribed must not be indistinguishable downstream. See §7.

---

## 1. Architecture Overview

```
Plaid (sandbox) ──live fetch────┐
                                ├──▶ merged in-memory session snapshot
Manual ledger (Postgres) ───────┘         (Plaid rows never persisted;
   ▲                                       manual rows read from DB)
   │ commit, after human review                  │
Documents (CSV / PDF / typed) ── parse ──────────┤
                                                 │
Postgres ── tokens, user context, ───────────────┤
            manual ledger + documents,           │
            derived aggregates,                  │
            audit trace (no raw PII)             │
                           ┌─────────────────────┴───┐
                           │      core package       │   pure TS, user-scoped by arg
                           │ sources + tools+compute │
                           │      + workflows        │
                           └──────────┬──────────────┘
                    ┌─────────────────┴──┐
        ┌───────────┴──────────┐   ┌─────┴───────────────┐
        │  App agent loop      │   │  MCP wrapper (thin) │
        │ (Next.js server)     │   │  for Claude Code    │
        │ intent → workflow →  │   │  testing / power    │
        │ synthesis (Messages) │   │  use                │
        └──────────────────────┘   └─────────────────────┘
```

**Agent loop (app path):** auth → resolve `userId` → build the **session snapshot** by merging every configured source (live Plaid fetch + the stored manual ledger) → intent router (Haiku) → workflow executor (fixed tool sequence, deterministic, reads the snapshot) → assembles an **evidence bundle** → synthesis model (Sonnet default, Opus for depth) generates narrative grounded in the bundle → response includes structured evidence for the UI's "how I got this" cards. The snapshot is discarded when the request ends; only derived aggregates (net worth snapshot) are appended to Postgres. Plaid's rows are never persisted; manual rows were already persisted at import time and are read, not written, here.

**Sources are pluggable, and the snapshot is the merge point.** Every compute function in §4 and every workflow in §5 reads the merged snapshot and does not know or care which source an account came from — that is the seam that lets a user with no Plaid connection at all get the same dashboard, and the same seam the deferred SnapTrade adapter slots into. What a compute function *does* see is each row's `source`, which it uses for provenance only, never for arithmetic.

**MCP path:** thin server exposing the **atomic `core` tools** (`listAccounts`, `getBalances`, `netWorth`, `fireProgress`, etc. — not the workflow pipelines), authenticated with a dev token, for interactive testing in Claude Code. This is the Checkpoint 0 harness. In this path, Claude Code (as the MCP client) decides which tools to call and in what order based on the prompt — that's fine for a local dev/testing harness, but it means the MCP path does **not** exercise the same constrained, deterministic workflow pipeline (§5) that the deployed app uses. The `summary_overview` workflow's fixed pipeline logic must be validated on its own (unit/integration test calling the workflow executor directly), not inferred from MCP session behavior.

**Playground path (Phase 3):** `/playground` in the web app, gated by `PLAYGROUND_ENABLED`. It drives the same stages as the agent loop through `/api/playground/*`, one stage at a time or all together, with per-run config overrides that the production loop never accepts. It reads; it does not write financial data. See `docs/PHASE-3-PLAYGROUND.md`.

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

**Document ingestion (Phase 2):**
- **CSV parsing:** a small dependency or hand-rolled parser — the requirement is RFC 4180 quoting and nothing more. Do **not** pull in a spreadsheet-shaped library for this.
- **PDF text extraction:** a text-layer extractor (e.g. `pdfjs-dist` / `unpdf`) running **server-side only**. OCR of scanned images is explicitly out of scope (§10) — a statement with no text layer is rejected with that reason stated, not guessed at.
- **PDF field identification:** an Anthropic call, constrained by §0.8's transcription guard. The extracted text is the input; verbatim quoted strings are the output.
- **File storage:** a `DocumentStore` interface. Local dev writes AES-GCM-encrypted blobs to a gitignored directory. **Nothing on Vercel's filesystem survives a request**, so the deploy phase must supply a real blob store (Vercel Blob or S3) behind the same interface — this is a named prerequisite of the deploy phase, not a surprise to discover there.

**Account/credential status:** Plaid sandbox keys, an Anthropic API key, and Clerk development keys are all in place. **Neon project and Vercel project still need to be created** — both belong to the deploy phase (§8 Phase 4), not to earlier phases.

Monorepo layout:
```
/apps/web        → Next.js app (UI + agent loop API)
/apps/mcp        → thin MCP server
/packages/core   → sources, tools, compute, workflows, provenance types
/packages/db     → Drizzle schema + migrations + client + crypto
/packages/plaid  → Plaid client + fetch + normalization   ── a source
/packages/ingest → document store, parsers, extraction, commit  ── a source (Phase 2)
```

---

## 3. Data Model

Postgres persists tokens, the user's own context, a PII-free audit trail, derived aggregates, and — from Phase 2 — the **manual ledger and the documents it came from** (§0.4). It does **not** store Plaid's financial datasets, and never will. Every money column is cents.

**Persisted in Postgres:**
- **users** — `id`, `auth_provider_id`, `email`, `created_at`. (Clerk owns auth; this mirrors the minimum.)
- **plaid_items** — `id`, `user_id`, `plaid_item_id`, `access_token_encrypted`, `institution_name`, `status`, `created_at`. Access token **encrypted at rest** (AES-GCM, key from secret manager/env; KMS upgrade path). *(No `transactions_cursor`: with no persisted transaction store, use windowed `/transactions/get` on demand rather than cursor-based `/transactions/sync`.)*
- **linked_accounts** *(minimal registry — judgment call, keep or fetch live)* — `id`, `user_id`, `item_id`, `plaid_account_id`, `nickname`, `mask`, `type`, `subtype`. **No balances or values.** Exists only so the UI can show what's connected without a live call.
- **user_profile** — `user_id`, `annual_income_cents`, `target_annual_spend_cents`, `risk_tolerance`, `notes_json`. (User-provided, not Plaid-derived.)
- **goals** — `id`, `user_id`, `type`, `target_cents BIGINT`, `target_date`, `created_at`.
- **networth_snapshots** *(Tier-1 derived aggregate)* — `id`, `user_id`, `as_of_date`, `net_worth_cents BIGINT`, `assets_cents BIGINT`, `liabilities_cents BIGINT`. One row per period; a *computed number*, not raw Plaid data. Enables net-worth-over-time without the transaction ledger.
- **period_summaries** *(Tier-1 derived aggregate, optional)* — `id`, `user_id`, `period`, `metric` (e.g. spend-by-category, savings_rate), `value_json`. Computed rollups for trends.
- **insight_log** — `id`, `user_id`, `workflow`, `params_json`, `tool_calls_json` (tool names + params + **provenance references**, not raw values), `model`, `created_at`. Powers transparency + eval **without persisting financial figures**. Evidence is regenerated live on demand, not stored.

**Manual sources and their ledger (Phase 2).** This is the durable financial data §0.4's corollary permits, and it is the only durable financial data in the schema. Column-level detail is in `docs/PHASE-2-INGESTION.md`; what matters at spec level:

- **documents** — the uploaded artifact: filename, mime type, byte size, `sha256`, storage key, `kind` (`csv` | `pdf` | `manual_entry`), `status`, timestamps. The **bytes are encrypted at rest** under a key distinct from the Plaid token key, and live in a `DocumentStore` (not in Postgres). A bank statement PDF is the single most PII-dense object in the system — it carries the account number, the address, and every line item — so it gets stricter handling than anything derived from it.
- **manual_accounts** — the same shape `SnapshotAccount` needs: name, mask, type, subtype, institution name, currency. Optionally linked to the document it came from. Archivable rather than deletable, so a ledger row never dangles.
- **manual_balances** — a *series*, one row per `(account, as_of_date)`, not a mutable column. Statements arrive dated; the snapshot reads the latest row per account, and the history is then real rather than overwritten. This is also what makes `networth_snapshots` honest for manual users.
- **manual_transactions** — date, `amount_cents`, name, merchant, category, and a dedupe key. **Stored in Plaid's sign convention** (positive = money leaving the account), because §4's compute functions interpret that convention and there must be exactly one of them in the system. Converting from whatever a bank's CSV does is the importer's job, at the boundary.
- **manual_holdings** / **manual_securities** — what `assetAllocation` needs. `quantity` is the one legitimately-fractional non-money number in the schema (a share count), matching `SnapshotHolding.quantity`.

Every one of these is scoped by `user_id` like everything else, and all of it is **user-deletable** — deleting a document asks explicitly whether to drop the ledger rows derived from it or keep them as free-standing manual entries.

**Derived-aggregate sensitivity:** a net-worth time series is itself sensitive. Protect `networth_snapshots` / `period_summaries` with **DB encryption-at-rest + application-level `user_id` scoping** (§3 Isolation) for MVP, *not* field-level encryption (you need to compute and chart over these values). Row-level security is a Phase 2 addition on top of this, not an MVP requirement. Reserve field-level encryption for Plaid tokens.

**Two-tier persistence policy** — *applies to aggregator-sourced data only.* The manual ledger above is outside this policy by construction (§0.4: there is nothing to refetch it from).
- **Tier 1:** persist derived aggregates only. Raw Plaid data stays ephemeral. Net worth history is derived from balances + holdings at fetch time and appended — **no Plaid transaction ledger, no `/transactions/sync` cursor required.**
- **Tier 2 (deferred, feature-gated):** persisting Plaid's raw transaction ledger to enable `/transactions/sync` incremental deltas (lower payload, richer transaction search). This *is* the PII-heavy mirror — note that incremental sync only reduces payload *because* you keep the base set. Only adopt when a specific feature justifies the retention/breach tradeoff. **Storing a manual transaction ledger does not open this door**: that ledger exists because no aggregator holds it, and pointing at it to justify mirroring Plaid's would invert the reasoning.

**In-memory only (session snapshot — never persisted):** the merged snapshot as a whole, and specifically every Plaid-sourced row in it. Modeled as types in the `core` package, assembled per request from the live Plaid fetch plus a read of the manual ledger, discarded when the request ends. Manual rows appearing in a snapshot are a *read* of durable data; Plaid rows have no durable form at all.

**Isolation (MVP decision):** application-level scoping only — every `core` tool takes `ctx: { userId }` and every query includes `WHERE user_id = :ctx.userId`, enforced by convention in the `core` package (all DB access goes through it; no ad-hoc queries elsewhere). Postgres **Row-Level Security** is deferred to a Phase 2 hardening pass, not built into Phase 0/1 schema or Drizzle session-variable plumbing. Revisit before onboarding real (non-sandbox) users.

**Chat history caveat:** assistant turns containing figures ("net worth ~$X") are derived PII. Minimize what's retained, and make conversation history **user-deletable**.

---

## 4. Core Package — Tools & Compute

Every tool signature is `(ctx: { userId }, params) => { data, provenance }`.
`provenance = { source: 'plaid'|'db'|'compute'|'user', asOf, accountIds?, computation?, notes?, sources? }`.

`sources?: SourceKind[]` (Phase 2) names which data origins contributed to the figure. It exists because `source` is a single enum and a merged net worth genuinely draws on more than one origin — an enum cannot say "half of this came from a statement you uploaded in August." **A figure computed across sources with different as-of dates must say so in `notes`**, naming the stale source and its date. This is not cosmetic: a manual balance dated 31 August merged with a Plaid balance fetched this morning produces a net worth that is accurate as of no single moment, and presenting it with one timestamp would be the exact species of quiet wrongness §0.2 exists to prevent.

**Aggregation (read the snapshot):**
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

**Adding a compute field, or a field's speakable form.** Two constraints bind any new figure, both learned the hard way:

1. What Jolly is permitted to say is exactly what `humanize()` emits from the evidence bundle, and the attribution guard checks prose against that set. A new field holding a **signed** figure must *also* expose the form a person would actually speak — a liability of −$65,262 in the data must appear as $65,262 somewhere in the bundle, or the guard will reject the only natural phrasing of a correct sentence and the model will be pushed into writing minus signs into prose to get past it. `NetWorthLine` carries both `contributionCents` and `balanceCents` for exactly this reason.
2. Provenance note text must not hard-code an origin. `spendingByCategory` currently says *"Some transactions arrived from Plaid without a category"* — which becomes false the moment a CSV import produces uncategorised rows. Note text that names a source must be derived from the rows actually involved.

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

## 7. Data Access

Two source kinds feed one snapshot. They differ in where the authoritative copy lives, which determines whether we may store anything (§0.4) — and in nothing else. Downstream of the merge they are indistinguishable except by the `source` field they carry for provenance.

### 7a. Aggregator sources (Plaid) — live fetch, nothing at rest

1. **Link:** frontend Plaid Link → `public_token` → server exchanges for `access_token` → store **encrypted** on `plaid_items`. Optionally populate the minimal `linked_accounts` registry (nickname/mask/type only).
2. **Per request:** fetch live — balances (`/accounts/balance/get`), holdings (`/investments/holdings/get`), and a transaction window (`/transactions/get`, e.g. last 90 days).
3. **Compute + narrate** over the snapshot.
4. **Request end:** discard. Nothing financial is written to Postgres.

**Session snapshot on serverless (decided):** Vercel functions are stateless — an "in-memory snapshot" does **not** survive across the turns of a chat (each request may hit a fresh instance). So **refetch-per-turn**: each chat turn re-fetches live into a request-scoped snapshot, computes, narrates, and discards it. No Upstash/Vercel KV — simplest path, nothing cached, no PII briefly at rest in Redis, at the cost of per-turn Plaid latency. A TTL'd cache is a possible later optimization, not built now.

This refetch-per-turn constraint is specific to the **app path** (§1, Vercel serverless). The **MCP path** runs as a long-lived local process, so a true in-memory session snapshot across tool calls works there without this workaround.

### 7b. Manual sources (documents and typed entry) — parse once, store the ledger

There is no aggregator to refetch from, so the pipeline is the opposite shape: expensive work happens **once at import**, and the snapshot read is cheap.

```
upload ──▶ parse ──▶ review (human confirms) ──▶ commit ──▶ manual ledger
  │          │              │                                   │
  │          │              └── nothing reaches the ledger       └── read into every
  │          │                  without passing through here         later snapshot
  │          └── CSV: deterministic. PDF: text extract, then
  │              a model transcribes under §0.8's guard.
  └── bytes stored encrypted; sha256 dedupes re-uploads
```

**The four stages, and why the boundaries sit where they do:**

1. **Upload.** Bytes to the `DocumentStore`, encrypted; a `documents` row with `status: 'uploaded'`. `sha256` is unique per user, so re-uploading the same statement is recognised rather than silently double-counted — a duplicated statement is the most likely way a manual ledger gets a wrong net worth.
2. **Parse.** Produces a **draft**, never a ledger write. A draft is a structured proposal: candidate accounts, dated balances, transactions, holdings, plus every column or line the parser could not interpret. Parsing is re-runnable against the stored bytes, which is the reason the original is kept at all.
3. **Review.** The user confirms, edits, or discards, row by row, and maps columns. For CSV this catches the sign convention and the date format. For PDF it is the §0.8 human confirmation, and it is **mandatory** — a draft cannot be committed unreviewed, including by an admin path or a script.
4. **Commit.** One database transaction writes the `manual_*` rows and flips the document to `committed`. Partial commits are not a state the system has.

**The sign convention is the trap.** Plaid's convention — positive means money *leaving* the account — is the opposite of most people's intuition and the opposite of most bank CSV exports, which use negative for a debit. `cashFlow` and `savingsRate` interpret Plaid's convention, and there must be exactly one convention past the boundary. The importer therefore **detects the file's convention, shows the user its interpretation of a sample row in plain language** ("this row looks like $42.30 spent at Starbucks"), and converts on commit. Getting this backwards inverts savings rate without erroring, which is precisely the failure §0.2 is meant to make impossible.

**Reading the ledger into a snapshot:** latest `manual_balances` row per account, all holdings and securities, and transactions inside the requested window. Every row carries `source: 'manual'` and its own as-of date, so `netWorth` can note staleness (§4) rather than implying a manual balance is as fresh as a live one.

### 7c. Both kinds

**Append derived aggregates:** after computing `netWorth`, append a `networth_snapshots` row (and optionally `period_summaries`), regardless of which sources contributed.

**Network trace:** an import is network work like any other and is disclosed the same way (§0.2) — the upload, the parse, and for a PDF the Anthropic transcription call with its model name and duration.

Never store bank credentials — ever. Only the encrypted Plaid token, and the documents the user chose to hand over.

---

## 8. Phases & Checkpoints

Build strictly in order. **Phase N ends in Checkpoint N** — the numbers match by construction. The riskiest unknowns, each validated at a checkpoint: **can we get clean data in** (0), **does the whole loop work for a real user** (1/1.5), **can it run on the author's own data rather than a sandbox fiction** (2), **can every part be seen and tested on its own, and is the guidance good** (3, the playground, judged against that real data), and **does it all survive deployment** (4).

> **Renumbered.** Checkpoints were originally numbered one ahead of their phases (Phase 0 → Checkpoint 1, and so on), and Phase 3 had none. Older commits and notes use the old numbers: old Checkpoint 1 = **0**, 2 = **1**, 2.5 = **1.5**, 3 = **2**. Checkpoint 4 is unchanged. `npm run checkpoint1` is now `npm run checkpoint0`.

Deployment is **Phase 4, last** — see the note there for why it moved out of Checkpoint 1.

### Phase 0 — Foundations & the Data Pipe → **Checkpoint 0: Summary E2E**
Scope: monorepo + env; Postgres schema + migrations (tokens/context/audit only); Plaid sandbox Link + token exchange + encrypted storage; live-fetch layer that builds the in-memory session snapshot; core aggregation tools (reading the snapshot) + `netWorth`, `assetAllocation`, `fireProgress`; `summary_overview` workflow executor (tested directly, not via MCP — see §1 MCP path note); thin MCP wrapper exposing the atomic tools.

**Checkpoint 0 acceptance** (two parts, both required):
1. **Pipeline correctness:** a direct test/script invocation of the `summary_overview` workflow executor (not through MCP) returns a **correct, provenance-backed** evidence bundle computed from a live-fetched sandbox snapshot. This proves Plaid → live fetch → normalize → tools → fixed pipeline works end to end, with no financial data persisted.
2. **Tool correctness in situ:** in Claude Code, connected to the MCP server as a sandbox user, ask for a financial summary and get a correct answer built from the atomic tools (`listAccounts` → `getBalances` → `netWorth` → `assetAllocation` → `fireProgress`, called by Claude Code itself in that session). This validates the atomic tools work correctly when driven live, independent of the fixed-pipeline test in (1).

No UI, no auth yet.

### Phase 1 — Multi-user MVP → **Checkpoint 1: Demoable MVP**
Scope: Clerk auth + user store; per-user Plaid Link flow in the UI; app-side agent loop (intent router → workflow executor → synthesis via Messages API); web UI (connect accounts, summary dashboard, chat, evidence/"why" cards); remaining workflows (`spending_analysis`, `investment_review`, `goal_progress`, `transaction_lookup`); context tools (profile, goals, notes).

**Checkpoint 1 acceptance:** A new user can sign up, link a sandbox institution, see a transparent summary dashboard, and ask follow-up questions in chat — each answer showing traceable evidence. Deployed to Vercel + managed Postgres. **This is the demoable product.**

### Phase 1.5 — Surface Area & Network Transparency → **Checkpoint 1.5: Nothing Hidden**

The Checkpoint 1 UI is a readout of the backend, not a designed product: a single column of
equally-weighted cards, no navigation, and a large amount of computed and stored data that
never reaches the screen. This phase closes that gap. It is presentation-layer work — the
evidence bundle already carries almost everything a richer view needs — with one genuinely new
concept (the network trace, below).

**Sequencing:** independent of the Checkpoint 1 deploy; either can go first. Deploying first is
the lower-risk order, because a real end-to-end run tells you which of these surfaces actually
matter before you build them.

**A. Network transparency panels.** Every part of the UI whose render or action costs network
work exposes what that work was: our own API route, and each external service called behind it.
This is not a loading state — the point is not to soften the wait but to make the cost legible.
§7 accepted per-turn Plaid latency as the price of holding no financial PII at rest; a user who
pays that price should be able to see what they are paying for.

Shape: a `NetworkTrace` — an ordered list of `{ scope: 'internal' | 'plaid' | 'anthropic',
label, startedAt, durationMs, ok, count? }` — carried alongside the session snapshot and the
evidence bundle, and rendered next to the thing that caused it (the dashboard's own panel, a
chat turn's panel).

Rules, all of which follow from §9:
- **Names, counts, durations, and outcomes only.** Never payloads, never tokens, never account
  identifiers. The panel exists to expose *that* a call happened, not what was in it.
- **Recorded at the boundary that makes the call** — `packages/plaid`, the Anthropic client in
  the agent loop, the route handler — never inferred in the UI. A trace the UI guesses at is a
  claim about the system rather than a record of it, which is the failure mode §0.2 exists to
  prevent.
- **Never persisted.** Same lifecycle as the snapshot: request-scoped, discarded at the end,
  regenerated per turn like the evidence bundle. It does not go into `insight_log`.
- Model *names* and Plaid *endpoints* are disclosed; the fact that a retry happened is
  disclosed too, since §0.1's attribution guard can double the synthesis cost.

**B. Surface what is already computed.** A substantial amount of work is done on every request
and thrown away unseen. Nothing here needs new computation or new persistence:

| Already available | Where it lives | Shown today |
|---|---|---|
| Net worth over time | `networth_snapshots`, written every summary run since Phase 0 | No |
| Individual holdings and securities | fetched every request, feed `assetAllocation` only | No |
| Transactions + the fetched window dates | fetched on every chat turn (90 days) | No |
| Per-item fetch failures (`gaps`) | snapshot, surfaced only as provenance note prose | Barely |
| Goals | `goals` table; `setGoal`/`deleteGoal` exist in `core` | No |
| Profile notes | `user_profile.notes_json`; `addNote` exists in `core` | No |
| Cash flow, savings rate, spending by category | computed in workflows | Chat only |

`period_summaries` is the one table with neither a writer nor a reader; wiring it is optional
here and belongs with trend work rather than being built speculatively.

**C. Information architecture.** One page currently holds dashboard, chat, and settings, which
leaves no room for any of the above. Introduce real routes:
- `/` — the summary dashboard, with hierarchy: net worth is not the same weight as the account
  list.
- `/history` — net worth over time from `networth_snapshots`, with its own "why" card.
- `/accounts` and `/accounts/[id]` — per-account detail: balances, holdings, recent
  transactions, which institution and item, and any gap affecting it.
- `/goals` — goal setting and removal, the annual spend target, and profile notes. This is
  where the Checkpoint 1 spend-target form graduates to once it has company.

**D. Evidence rendering.** Provenance is this product's whole thesis and currently renders as a
collapsed `<details>` with unlabelled 12px gold text doing the most important work on the card.
Give caveats an explicit label and affordance, distinguish "method" from "gap" beyond colour
alone, and treat the "why" card as a feature rather than a debug toggle.

**Checkpoint 1.5 acceptance:** every network call the app makes on a user's behalf is visible
in the UI at the point it is incurred, with no payload data exposed; net worth history, holdings,
transactions, and goals are all reachable; and no new financial data is persisted to do any of it.

### Phase 2 — Real Data Without Plaid: Document Ingestion → **Checkpoint 2: My Own Data**

**Why this comes next, ahead of both deployment and the AI work.** What exists after Phase 1.5 is a demo dashboard driven by First Platypus Bank, a fictional institution with fictional balances. Every judgement about whether Jolly's guidance is any good has been made against invented numbers. The fastest route to a real product is not a nicer deployment of fake data — it is real data, and real data cannot come from Plaid yet, because §10 blocks live institutions until the security checklist and the employer check clear. Documents are the way in: they need no production Plaid access, no vendor review, and no non-sandbox credentials.

This phase is therefore the one that turns the demo into something its author can actually use, which is also the only honest way to find out what is missing.

**Scope:**
- **Source abstraction** in `core`: the snapshot becomes a merge of sources rather than a Plaid fetch result. `SourceKind`, `source` on every snapshot row, `Provenance.sources`, cross-source staleness notes (§4). Plaid becomes *a* source, not *the* source.
- **`packages/ingest`**: `DocumentStore` (encrypted local blobs), the CSV parser, the PDF text extractor, the model-driven field transcriber under §0.8's guard, the draft/review/commit state machine, and the manual-ledger reader that feeds the snapshot.
- **Schema**: `documents`, `manual_accounts`, `manual_balances`, `manual_transactions`, `manual_holdings`, `manual_securities` (§3).
- **The transcription guard** — `checkTranscription()`, the §0.8 analogue of `checkAttribution()`: every figure the model reports must be a verbatim substring of the extracted text, or the row is rejected. Tested with a deliberately hallucinating fixture, the same way the attribution guard is tested with prose that invents a figure.
- **UI**: `/import` and `/import/[documentId]` (the review screen — the most important new surface in the phase), `/accounts/new` for typed entry, `/sources` replacing the single "connect a bank" affordance, and manual balance history on `/accounts/[id]`.
- **Fix the Clerk cold-start redirect loop.** A drifted system clock made every first sign-in fail with `token-iat-in-the-future` while a manual reload succeeded; Clerk's own follow-up message blames mismatched keys and is a red herring. Widen `clockSkewInMs` in `proxy.ts` so ordinary drift degrades into a slightly stale token instead of an unrecoverable loop. *(Landed ahead of the rest of the phase.)*

**Checkpoint 2 acceptance:** with **every Plaid item disconnected**, the author uploads their own real CSV export and their own real PDF statement, reviews and commits both, and sees a correct dashboard, a correct net worth, and correct chat answers — each with evidence naming the document the figure came from. A figure the extractor invented is caught by `checkTranscription()` rather than reaching the ledger. Re-uploading the same statement is recognised as a duplicate. Then Plaid is reconnected and the merged snapshot is correct too, with any staleness stated.

The "every Plaid item disconnected" clause is the point of the checkpoint: a manual user must be a first-class user, not a degraded one.

### Phase 3 — The Playground, and the AI Work Done With It → **Checkpoint 3: Every Stage Visible, Every Stage Testable**

Buildable spec: **`docs/PHASE-3-PLAYGROUND.md`**.

**The playground is the centrepiece of this phase.** The app shows the trace *for the user's question*. The playground shows the trace *for the system itself*: a separate developer area at `/playground` where one question can be followed through every stage (snapshot → router → params → workflow → evidence → synthesis → guard → answer), and any stage can be lifted out, given hand-edited input, run with changed knobs, and run alone. It covers:
- **The lifecycle**, run all at once or stage by stage, with every intermediate inspectable, the exact prompts sent to each model, rejected drafts that production discards, and token usage per call.
- **Cross-cuts:** the router alone, the snapshot alone, any of the six workflows picked directly, and each step's params, data and provenance shown as it passes along.
- **Experimentation** on what is hard-coded today: router and Jolly prompts, models, token limits, history windows, the retry message, `now` for date resolution, the snapshot window, FIRE params, the transcription prompt and CSV conventions. Workflow pipelines, the router's enum and the guards are *shown* but not editable.
- **A notebook** in which every aggregation tool and compute function can be run individually with documentation and a schema-driven form, showing raw cents, provenance and the `humanize()`d form side by side.
- **The ingestion lane:** a document through sniff, hash, extraction, detection, transcription, `checkTranscription()` and draft. It ends with "how Jolly reads it": the draft is merged as a synthetic source and run through any workflow. It **never commits**.
- **A guard bench** and a **routing suite** that put numbers on the guard's and the router's behaviour.

Four rules keep it from undermining what it shows (spec §0): **overrides are per-run and never reach `/api/chat`**; **the server only trusts a snapshot it fetched in the same request**, and anything sent back by the browser is labelled synthetic; **playground runs never write** (no net-worth points, no ledger rows, no `insight_log`); and **no guard can be switched off**. It is gated by `PLAYGROUND_ENABLED`, off in production, and shows only the signed-in user's own data.

**The AI-sophistication work stays in this phase and is done *through* the playground:** formalized identity/system prompt, iterated as experiments and promoted by commit; a hardened router, measured by the routing suite; `insight_log` wired for production turns, with the playground as its first reader; proactive insights and goal tracking over time; model routing + cost controls, measured by per-stage token usage; **`riskTolerance` finally used** (allocation versus stated tolerance in `investment_review`, tone in the system prompt, and its UI input added at the same time); **SnapTrade adapter** behind the Phase 2 source interface (not a Checkpoint 3 prerequisite, and a candidate to move to its own phase).

Deliberately after Phase 2: tuning narration and adding proactive insights against sandbox numbers optimizes against fiction. Judgements about whether guidance is *good* want the author's own data underneath them, and the ingestion lane has nothing to show until ingestion exists.

**Checkpoint 3 acceptance** (full list in the spec, §11): with the gate off, every playground route 404s; a default-config run produces the same workflow and a deep-equal evidence bundle to `/api/chat`; every stage runs alone with only the network calls it should make; every catalog tool runs from the notebook and the MCP server derives its tools from the same catalog; a prompt edit changes routing but a prompt *instructing arithmetic* still ends in a visible rejected draft and a withheld answer; the fixture documents traverse the whole ingestion lane, including a scanned-PDF rejection and a planted figure dropped by `checkTranscription()`; and afterwards nothing new is at rest: no net-worth point, no ledger row, no stored file, nothing in browser storage. All of this is checked in `psql`, the store directory and devtools.

*Not in this phase, despite looking adjacent:* `annualIncomeCents` as a `savingsRate` fallback. That is deterministic compute with no model in it (§4), and belongs with the next change to `savingsRate` rather than in a phase about the model. See `docs/STATE.md` known gaps.

### Phase 4 — Deployment → **Checkpoint 4: Live**

Moved here deliberately, from its original place in Checkpoint 1. Deploying earlier would have been lower-risk in the narrow sense, but it buys nothing the local build does not already prove, and it front-loads infrastructure work ahead of the development that decides what the product is. Everything in Checkpoint 1's acceptance text *except the word "deployed"* has already passed locally.

Scope and prerequisites:
- **Neon** via the Vercel Marketplace so credentials are auto-injected. **Postgres 17**, matching `docker-compose.yml`, and the same region as the functions — §7's refetch-per-turn already pays one Plaid round trip per turn without adding a cross-region DB hop.
- **A real blob store** behind `DocumentStore`. Vercel's filesystem does not persist, so the local-directory implementation cannot be deployed. Named in §2 as a prerequisite so it is not discovered here.
- **A fresh `TOKEN_ENCRYPTION_KEY` and document key** for production rather than reusing dev keys. Neon starts empty, so nothing needs to decrypt across the boundary.
- **Confirm the plan honours `maxDuration = 120`.** A chat turn is a live Plaid fetch plus a Haiku call plus a Sonnet call, and an attribution retry adds a *second* Sonnet call. Hobby caps conventional functions at 60s.
- **Clerk production instance** only once a custom domain is attached; `pk_test_`/`sk_test_` work on localhost and preview URLs.
- **Migrate off `createRouteMatcher`** (deprecated in Clerk 7, warns on every boot) and **build or drop `/api/plaid/webhook`** — `proxy.ts` allowlists it as a public route and no handler exists, so §9's webhook-signature requirement is currently unmet rather than merely unverified.

**Checkpoint 4 acceptance:** the Checkpoint 1 and Checkpoint 2 acceptance runs both performed against the deployed app, by a brand-new user, with documents surviving a redeploy.

---

## 9. Security Checklist (multi-user financial data)

- Plaid access tokens encrypted at rest (AES-GCM; key in secret manager/env; KMS upgrade path).
- Every DB query scoped by `user_id`, enforced by the `core` package (§3 Isolation). Postgres RLS deferred to a later hardening pass, not MVP.
- Plaid webhook signature verification. **Currently unmet**, not merely unverified: `proxy.ts` allowlists `/api/plaid/webhook` as public but no handler was ever written. Build it or drop the allowlist entry (§8 Phase 4).
- No bank credentials stored — ever.
- **No raw Plaid financial data at rest** — Plaid's balances, holdings, and transactions live only in a request-scoped in-memory snapshot, refetched per chat turn (§7). No Redis/KV cache. Only *derived aggregates* persist from that source, protected by encryption-at-rest.

**Uploaded documents and the manual ledger (Phase 2).** This is the one place durable financial data exists, so it carries the strictest handling in the system:
- **Document bytes encrypted at rest** (AES-GCM) under a key **distinct from `TOKEN_ENCRYPTION_KEY`**. Separate keys because a document dump and a token dump are different blast radii, and one should be rotatable without re-encrypting the other.
- **Never in Postgres and never in the repo.** Bytes go to the `DocumentStore`; the dev directory is gitignored. A statement accidentally committed cannot be un-committed.
- **Never in a client bundle, a log line, a network trace entry, or `insight_log`.** The trace may say a PDF of *n* pages was parsed in *n*ms; it may not carry a page of it. Extracted text is request-scoped like a snapshot.
- **Extracted text is not sent anywhere except the Anthropic transcription call**, and only the pages needed. That call is disclosed in the network trace by model name and duration like any other (§0.2).
- **User-deletable**, bytes and derived ledger both, with the choice between them made explicit (§3).
- **Filename and mime type are attacker-controlled**: validate mime by content sniff rather than extension, cap byte size, and never use an uploaded filename as a storage path.
- Chat history minimized and user-deletable (assistant turns can contain derived financial figures).

**The playground (Phase 3)** exposes internals by design, so its limits are part of the checklist:
- **Off unless `PLAYGROUND_ENABLED=true`**, checked in every `/api/playground/*` handler and not only in the page. Off in production.
- **Own data only.** No impersonation or admin view; a client-supplied snapshot has its `userId` overwritten server-side.
- **Never persists a run.** No snapshot, bundle, draft or extracted text in `localStorage`, on the server, or in `insight_log`; no `networth_snapshots` write; no `DocumentStore` write for a dropped-in file. Only prompt/knob experiments may be saved, and they hold no financial data.
- **Cannot weaken production.** `/api/chat` ignores any config in its body; guards cannot be disabled in a lifecycle run; prompts reach production only by commit.
- **Spends money on request**, so model calls are rate-limited per user and every call is in the trace with its token counts.
- Secrets never in the repo; `.env` for dev, secret manager for deploy.
- (Developer action item) Confirm employer outside-activity/IP policy before real (non-sandbox) data. **Note that Phase 2 brings the author's real financial documents into the repo's local storage** — this item stops being hypothetical there, and is worth settling before that upload rather than after.

---

## 10. Explicit Non-Goals
- SnapTrade / any second aggregator (Phase 3).
- Writing edits back into external documents.
- Prescriptive trade recommendations.
- **Real (non-sandbox) financial *institutions*** until security checklist + employer check are cleared. Note what this does *not* block: the user's own documents, which is exactly why Phase 2 is the route to real data.
- Persisting the raw Plaid **transaction ledger** (Tier 2). Deferred until a feature justifies the retention tradeoff. *Note:* Tier-1 derived aggregates **are** in scope — those are computed numbers, not a raw-data mirror. The Phase 2 *manual* ledger is also in scope, for the different reason given in §0.4.

**Non-goals specific to ingestion (Phase 2)** — each one is a real temptation while building it:
- **OCR of scanned statements.** Text-layer PDFs only. A scan is rejected with that reason stated plainly; guessing at pixels is how a wrong balance gets into a ledger with nothing flagging it.
- **Unattended or bulk import.** Every document passes through human review (§0.8). No "import all", no folder watcher, no email ingestion, no API that commits a draft.
- **Model-authored *arithmetic* during extraction.** The extractor transcribes strings. If a statement's stated total disagrees with the sum of its parts, that is surfaced as a discrepancy for the user to resolve — never silently reconciled, and never fixed by asking the model which number it prefers.
- **A category mapping table.** §4 uses Plaid's `personal_finance_category` verbatim. Manual rows without a category stay `UNCATEGORIZED`; inventing a taxonomy for imports would create a second, divergent one.
- **OFX / QFX parsing.** Structured and tempting, but CSV plus PDF covers what institutions actually hand a person, and a third format is a third parser to keep correct.

**Non-goals specific to the playground (Phase 3):**
- **A user-facing feature.** It is a developer tool, gated and off in production.
- **A runtime prompt or config store.** Production behaviour changes only through a reviewed commit, so the playground offers "copy as patch", never "apply".
- **Editing workflow pipelines or the router's enum at runtime.** A pipeline is code; experiment by running tools individually.
- **Committing a draft from the ingestion lane.** §0.8's human review at `/import/[documentId]` stays the only path into the ledger.