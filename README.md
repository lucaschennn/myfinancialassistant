# Personal Finance Guru

An AI financial coach that narrates **only** figures produced by deterministic tools, each
carrying its own provenance.

- [CLAUDE.md](CLAUDE.md) — the build spec: what we're building and why
- [docs/STATE.md](docs/STATE.md) — where things stand, what's open, what's next
- this README — how to run it

**Status: Phase 0 complete. Checkpoint 1 passed — both parts, against the Plaid sandbox.**

## The one idea worth internalising

The model never computes a number. Tools compute; the model narrates. Every tool returns
`{ data, provenance }`, and the workflow pipeline is fixed in code rather than chosen by the
model. Transparency is structural — a figure without a source cannot be constructed.

## Layout

```
packages/core    tools, compute, workflows, provenance types — pure, no I/O
packages/db      Drizzle schema, migrations, token encryption
packages/plaid   Plaid client, live fetch, dollars→cents normalisation
apps/mcp         thin MCP server (local dev harness — never deployed)
scripts/         sandbox linking, profile seeding, Checkpoint 1 runner
```

`core` depends only on `db`. `plaid` depends on `core` for types and builds the snapshot that
gets passed *into* core — that direction is what keeps `core` pure and testable.

## What persists, and what does not

Postgres holds tokens, user-entered context, a PII-free audit trail, and derived aggregates.
It holds **no balances, holdings, securities, or transactions** — those are fetched live from
Plaid into a request-scoped in-memory snapshot and discarded (§0.4, §7).

The only financial values that persist are `networth_snapshots`: computed numbers, not a
mirror of Plaid data.

## Setup

Prerequisite: Docker must be running. On **Windows Home** that means WSL2 — there is no
Hyper-V fallback, so without it the CLI works while the engine returns 500 on every call:

```powershell
wsl --install     # admin PowerShell, then reboot
```

```bash
npm install
cp .env.example .env      # then fill .env in — never put real values in .env.example
npm run db:up             # docker compose postgres on :5433
npm run db:migrate
npm run link:sandbox      # creates a sandbox user + links a bank; prints the user UUID
npm run set:profile -- --spend 60000 --income 120000 --risk moderate
```

Put the printed UUID in `.env` as `MCP_DEV_USER_ID`, and set `MCP_DEV_TOKEN` to any non-empty
value (it is an "I meant to run this" switch, not a security boundary — stdio transport is
already local).

`set:profile` is not optional if you want the full pipeline: `fireProgress` needs an annual
spend target, and without one the summary runs four tools instead of five and reports the
omission as a limitation.

Generate the token-encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Re-running `link:sandbox`

Safe to re-run — it finds the existing user by email and prints the same UUID. To see the
user id and linked items without touching Plaid at all:

```bash
npm run link:sandbox -- --show
```

It will **not** link a bank you already have. Plaid's sandbox mints a new item on every
`sandboxPublicTokenCreate` call, so nothing ever conflicts on insert — a second item for the
same bank would duplicate all its accounts and roughly double your computed net worth.
`--force` overrides this when a second item is genuinely what you want; `--institution ins_X`
links a different bank, which is the normal multi-item case.

## Verify

```bash
npm test          # compute suite — the correctness backbone
npm run typecheck
```

## Inspecting the database

```bash
npm run db:studio    # Drizzle Studio — schema-aware browser UI
npm run db:psql      # psql inside the container
```

Or connect any client to `localhost:5433`, database `pfg_dev`, user/password `pfg`/`pfg`.

Money columns are `BIGINT` cents, so a raw client shows `-4045232`, not `-$40,452.32`. Cast
for reading only — never let that conversion back into application code:

```sql
select as_of_date, (net_worth_cents / 100.0)::money as net_worth from networth_snapshots;
```

You will not find balances, holdings, or transactions in there. That is the design (§0.4),
not a missing feature — use the MCP tools or `npm run checkpoint1` to see live figures.

## Checkpoint 1 — passed

Two independent parts, both required (§8). Both verified against a live First Platypus Bank
sandbox item (12 accounts, 13 holdings, 48 transactions).

**Part 1 — pipeline correctness.** Calls the `summary_overview` workflow executor directly
against a live sandbox fetch:

```bash
npm run checkpoint1 -- --verbose
```

Expect the fixed pipeline `listAccounts → getBalances → netWorth → assetAllocation →
fireProgress`, every entry provenance-backed, and a trace audit reporting
`✓ no financial figures present`.

That audit walks the structure for bigints and `*Cents` keys rather than grepping text — an
earlier digit-matching version flagged an account mask in a provenance note and proved
nothing. `summaryOverview.test.ts` asserts the same properties against fixtures on every
`npm test`.

**Part 2 — tool correctness in situ.** Restart Claude Code in this directory (`.mcp.json` is
already configured), approve the `pfg` server, then ask for a financial summary. Claude Code
picks the tool order itself here — that is the point of this half: it validates the atomic
tools when driven live, independent of the fixed pipeline in Part 1.

Both paths agree on the figures, which is the result that matters: net worth −$40,452.32
computed identically whether the pipeline or the model chose the call order.

## Running a workflow

Three ways, and they prove different things.

**The executor directly** — a live fetch through the real pipeline:

```bash
npm run checkpoint1 -- --verbose
```

**On fixtures** — no Plaid, no database, runs in milliseconds:

```bash
npx vitest run packages/core/src/workflows/summaryOverview.test.ts
```

**Through MCP**, via the `runWorkflow` tool:

```
runWorkflow(workflow: "summary_overview")
```

That last one is the only non-atomic tool on the harness. Everything else exposes one `core`
function; `runWorkflow` runs a whole pipeline and hands back the evidence bundle. It takes a
workflow *name* rather than there being one tool per workflow, so the set of pipelines stays
defined in `core` and cannot drift.

Worth keeping straight: calling `listAccounts`, `getBalances`, `netWorth`, `assetAllocation`,
`fireProgress` yourself in that order is **not** a workflow run. The output looks the same,
but you chose the order — which is exactly the freedom a workflow exists to remove. That is
why Checkpoint 1 has two parts, and why `runWorkflow` does not substitute for either.

## Notes on the money rules

- Money is `bigint` cents everywhere. `dollarsToCents` is the only function permitted to touch
  a float, and it lives at the Plaid boundary.
- Ratios are integer basis points, for the same reason.
- `JSON.stringify` throws on bigint — use `toJson` from `@pfg/core`.
- Plaid reports **outflows as positive** amounts. That convention is preserved through the
  snapshot and inverted exactly once, in `cashFlow`.
- `netWorth` and `fireProgress` deliberately cover different money. Net worth counts the house
  and the mortgage. FIRE progress counts neither — excluding the property but still subtracting
  its mortgage would charge for the same house twice, since the payment is already inside the
  spending figure that sets the target. Other debts are still subtracted.

## Not yet built

Phase 1 (Clerk auth, Next.js UI, agent loop, remaining workflows) and Phase 2. `summary_overview`
is the only registered workflow; the router will only ever route to something that exists.
