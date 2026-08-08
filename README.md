# Personal Finance Guru

An AI financial coach that narrates **only** figures produced by deterministic tools, each
carrying its own provenance.

- [CLAUDE.md](CLAUDE.md) — the build spec: what we're building and why
- [docs/STATE.md](docs/STATE.md) — where things stand, what's open, what's next
- this README — how to run it

**Status: Phase 1 built and verified against the Plaid sandbox — not yet deployed.** Auth, the
web app, the agent loop, and all six workflows are in. Checkpoint 2 additionally requires a
deploy and one end-to-end run as a real signed-up user; neither has happened yet.

## The one idea worth internalising

The model never computes a number. Tools compute; the model narrates. Every tool returns
`{ data, provenance }`, and the workflow pipeline is fixed in code rather than chosen by the
model. Transparency is structural — a figure without a source cannot be constructed.

## Layout

```
packages/core    tools, compute, workflows, provenance, agent prompts + §0.1 guard
packages/db      Drizzle schema, migrations, token encryption
packages/plaid   Plaid client, live fetch, dollars→cents normalisation
apps/web         Next.js app — auth, Plaid Link, dashboard, chat, agent loop
apps/mcp         thin MCP server (local dev harness — never deployed)
scripts/         sandbox linking, profile seeding, checkpoint + agent smoke runners
```

`core` depends only on `db`. `plaid` depends on `core` for types and builds the snapshot that
gets passed *into* core — that direction is what keeps `core` pure and testable.

`apps/web` holds the two things that genuinely need a running app: the Anthropic calls and
React. Everything testable about the agent — the Jolly system prompt, the router's schema and
date resolution, and the attribution guard — lives in `packages/core/src/agent/` so it runs in
the normal test suite rather than only against a live model.

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

### Clerk (needed for the web app, not for the MCP harness)

Create an application at [clerk.com](https://clerk.com) and copy two keys from **API Keys →
Next.js** into `.env`:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…
CLERK_SECRET_KEY=sk_test_…
```

The development instance is the right one — its `pk_test_`/`sk_test_` keys work on localhost
*and* on Vercel preview URLs, so a production instance is only needed once a custom domain is
attached.

No webhook is required. User rows are provisioned just-in-time on the first authenticated
request, which avoids needing a public tunnel in development. A webhook only becomes worth
adding for `user.deleted` cascade, which JIT provisioning genuinely cannot express.

For sign-up, any address containing `+clerk_test` skips email delivery entirely and verifies
with code `424242`.

> **Env lives at the repo root, and Next needs help finding it.** `apps/web/next.config.ts`
> loads the root `.env` itself by walking upward. Next only reads `.env` from its own project
> directory, so the root file everything else uses is otherwise invisible to it — and
> `NEXT_PUBLIC_*` is inlined at compile time, so a runtime loader would be too late. **Do not
> add a second `.env` under `apps/web/`**: two files with the same keys drift, and one of them
> eventually gets committed.

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

## Run the app

```bash
npm run dev       # http://localhost:3000 — needs the two Clerk keys
```

Sign up, connect a bank (First Platypus is the sandbox default), then set your annual spend
target in the FIRE card on the dashboard. That card is the only thing on the page that needs
it; everything else renders without one.

Your Clerk signup is a **different `users` row** from the sandbox user that `link:sandbox`
creates, unless the email happens to match an unclaimed seeded row (`claimSeededUser`). So a
profile set through `npm run set:profile` without `--user` lands on the sandbox user and does
nothing for the account you are signed in as — the script reports success while the dashboard
keeps saying FIRE progress is unavailable. Setting it in the UI cannot make that mistake,
which is why it is the documented path. The script remains useful for seeding the sandbox user
that `agent:smoke` and the MCP harness run as.

## Verify

```bash
npm test          # compute suite + agent guard + workflows — the correctness backbone
npm run typecheck # root packages and the web app
npm run build     # production build of apps/web
npm run agent:smoke
```

`agent:smoke` is the fastest end-to-end check: it bypasses Clerk, fetches a live snapshot for
the sandbox user, and runs route → fixed pipeline → synthesise → attribution-check, reporting
for each answer whether it was clean, rewritten after a rejected draft, or withheld. Pass
questions as arguments to exercise specific routes:

```bash
npm run agent:smoke -- "what do I own?" "where did my money go last month?"
```

Only **withheld** is a failure. A rewrite means the §0.1 guard caught a bad draft and the
second attempt passed — the system working, at the cost of one extra synthesis call.

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

You will not find balances, holdings, or transactions in there. That is the design (§0.4), not
a missing feature — use the app, the MCP tools, `npm run agent:smoke`, or
`npm run checkpoint1` to see live figures.

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

Four ways, and they prove different things.

**Through the app** — the real path a user takes: router chooses the workflow, synthesis
narrates it, the guard checks the result.

**The executor directly** — a live fetch through the real pipeline, no model involved:

```bash
npm run checkpoint1 -- --verbose
```

**On fixtures** — no Plaid, no database, runs in milliseconds:

```bash
npx vitest run packages/core/src/workflows/
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

## The agent loop, and the one rule it has to obey

A chat turn is: **Haiku router → fixed workflow → Sonnet synthesis → attribution check.**

The router picks one of the six §5 workflows and nothing else. It uses structured outputs, so
an unknown workflow is a schema violation rather than a runtime surprise — and because a
workflow's tool sequence is fixed in `core`, the worst a routing mistake can do is answer the
wrong question. It can never compute a figure the wrong way.

Synthesis is where §0.1 stops being structural. Through Phase 0 the rule held because no model
was in the loop — nothing *could* compute. So it is now checked rather than requested:
`checkAttribution()` pulls every currency figure and percentage out of the model's prose and
verifies each against the pre-formatted figures the bundle carries. A violation triggers one
correction naming the offending numbers; a second failure **withholds the answer** rather than
showing figures that cannot be traced.

Asked *"what is my net worth minus my mortgage?"* — both figures present, the difference not —
the model declines instead of subtracting. That refusal is the feature.

> **If you add a compute function, remember:** what Jolly may say is exactly what `humanize()`
> emits from the bundle. A new field holding a *signed* figure must also expose the form a
> person would speak aloud, or the guard will reject correct prose. This already bit once —
> liabilities were stored only as negative contributions, so "your student loan is $65,262"
> read as unattributable. See docs/STATE.md.

## Not yet built

- **Deployment.** Neon + Vercel, and one end-to-end run as a genuinely new signed-up user.
  That is what stands between here and Checkpoint 2.
- **`insight_log` has no writer.** The transform, table, and tests exist; §8 puts the wiring in
  Phase 2.
- **Phase 2** generally: proactive insights, model routing and cost controls, and the SnapTrade
  adapter.
