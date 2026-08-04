# Project state

Living handoff notes. [CLAUDE.md](../CLAUDE.md) is the spec (what we're building and why);
[README.md](../README.md) is how to run it. This file is where things stand and what's open.

Last updated at the end of the Phase 1 build (auth, Plaid Link UI, agent loop, all six
workflows, and the dashboard/chat UI landed). **Not deployed, and not yet run end to end as a
real signed-up user** — those two are what stand between here and Checkpoint 2.

166 tests, typecheck clean, production build clean, and all six workflows answering clean
against the live Plaid sandbox. Three defects were found by using the §0.1 guard in anger —
see *The guard's first findings* below.

---

## Where we are now (Phase 1, in progress)

**Built and verified against the live Plaid sandbox:**

- **Clerk auth + user store** — JIT provisioning on first authenticated request
  (`packages/core/src/tools/users.ts`). No webhook needed in dev. `claimSeededUser()` adopts
  an unclaimed Phase 0 row so its linked item is not orphaned.
- **Next.js app** (`apps/web`) — route-protected by default, Plaid Link flow replacing
  `scripts/link-sandbox-item.ts`, summary dashboard, chat, and evidence "why" cards.
- **Agent loop** — Haiku router (structured outputs) → fixed workflow → Sonnet synthesis.
- **All six §5 workflows registered.** The Phase 0 gap is closed; the router can no longer
  name a pipeline that does not exist.
- **The §0.1 guard is now enforced, not requested** — see below.

**Not yet done:** deployment (Neon + Vercel), `insight_log` writer, any run against a real
Clerk session (keys not yet created).

### §0.1 stopped being an assumption

Phase 0's invariant held structurally: no model was in the loop, so nothing *could* compute.
Synthesis changes that, so it is now checked. `checkAttribution()` extracts every currency
figure and percentage from the model's prose and verifies each against the figures
`humanize()` put in the bundle. A violation triggers one targeted retry; a second failure
withholds the answer rather than showing untraceable numbers.

Live against the sandbox, all six workflows answered clean. The question designed to bait
arithmetic — *"what is my net worth minus my mortgage?"* — got the right refusal:

> "I can't give you that figure — it would require subtracting the mortgage balance from
> net worth, and that's a calculation I'm not able to do on the fly."

Net worth still reads **−$40,452.32**, matching Checkpoint 1.

### A real leak found and fixed

`toReasoningTrace()` was copying tool **params** verbatim, and `fireProgress` takes
`annualSpendCents` — the user's own spending target. That figure would have landed in
`insight_log`, making the audit log the PII store §3 says it must not become. The Phase 0
test missed it because it only checked result *values*, not params. Params ending in `Cents`
are now redacted to `'[redacted]'`, keeping the shape ("a target was supplied") without the
figure. Pinned by two tests.

### The guard's first findings in real use

One `goal_progress` turn ("what is my FIRE progress and what spending has happened
recently?") surfaced three defects. The guard itself worked; two of the three were in how it
reported what it did.

**1. Sign-aware matching produced false positives on debts.** `netWorth` carried liabilities
only as a negative `contributionCents`, so *"your student loan is $65,262"* — the only way
anyone would phrase it — read as an unattributable figure, and the model had to write minus
signs into prose to get past the check. Fixed by widening the bundle rather than loosening
the matcher: `NetWorthLine` now also carries `balanceCents`, the balance as the institution
reports it. A sign flip on a *total* is still caught.

Worth knowing why this only ever bit `goal_progress`: its pipeline is getUserContext →
netWorth → fireProgress, with no `getBalances` step, and `getBalances` already emits Plaid's
positive owed-amount. Every other workflow authorised both forms by accident. The regression
test runs against a `goal_progress` bundle for that reason — against `summary_overview` it
passes with or without the fix.

> **The general rule this exposes:** what Jolly is permitted to say is exactly what
> `humanize()` emits from the bundle. Any new compute field holding a signed figure must
> also expose the form a person would actually speak, or the guard will reject correct
> prose. Worth remembering when Phase 2 adds compute functions.

**2. The retry turn leaked into the answer.** The correction is delivered as a `user`
message, so the model read it as the person speaking and replied conversationally — *"You're
right to flag that, let me restate…"* — to someone who never saw the rejected draft and said
no such thing. `attributionRetryTurn` now states outright that the correction is internal and
the rewrite must stand alone. This is a prompt change, so the test pins the instruction text,
not the behaviour; it wants a live `agent:smoke` run to confirm.

**3. A rewritten answer was labelled "figures held back."** The UI could not tell a retry from
a refusal, so it described the text the user was successfully reading as withheld. `AgentResult`
now carries `attributionOutcome: 'clean' | 'retried' | 'withheld'`; the card distinguishes
"draft discarded, answer rewritten" from "answer held back", and `agent:smoke` counts them
separately — only `withheld` is a failure, a retry is the guard working at the cost of a
second synthesis call.

---

## Where Phase 0 landed

**Phase 0 complete. Checkpoint 1 passed — both parts.**

Verified against a live Plaid sandbox item (First Platypus Bank: 12 accounts, 13 holdings,
48 transactions):

- **Part 1** — `summary_overview` executor invoked directly, full five-tool pipeline,
  every entry provenance-backed.
- **Part 2** — atomic tools driven by Claude Code over MCP, tool order chosen by the model.
- Both agree: net worth **−$40,452.32**. Agreement across independent entry points is the
  actual evidence, not either run alone.

86 tests passing, typecheck clean.

### The §0.4 invariant was checked in the database, not just asserted

```
linked_accounts columns:  id, user_id, item_id, plaid_account_id, name, nickname, mask, type, subtype
                          ↑ no balance column exists
plaid_items token:        108-char ciphertext, does not match 'access-%'
networth_snapshots:       one row, derived, matching the computed figure
```

Re-running a session the same day updates that row rather than appending — the
`(user_id, as_of_date)` upsert is working.

---

## The §5 evidence bundle — every consumer now exists

Phase 0's honest caveat was that the data structure existed and none of its consumers did.
That is no longer true:

| §5 claim | Status |
|---|---|
| Ordered list of `{ tool, params, data, provenance }` | Built and exercised |
| Synthesis prompt requires attribution to a bundle entry | Built — and **verified**, not just requested (`checkAttribution`) |
| UI renders expandable "why" cards | Built — dashboard and chat, both from the same bundle |
| Bundle is not persisted | True, and now non-trivially: it is regenerated per turn (§7) |
| `insight_log` stores the reasoning trace | Transform + table + test exist; **still nothing writes** (§8 → Phase 2) |
| Values regenerated live on revisit | True — every turn refetches and recomputes |

The one row still outstanding is the `insight_log` writer, which §8 defers to Phase 2 on
purpose.

---

## Open decisions

**~~Rename the `pfg` namespace?~~ Decided: keep.** Neither Neon nor Vercel ever references
it — Neon issues its own connection string, Vercel keys off project name and workspace
paths, and all four packages are `private: true` so `@pfg/*` never reaches the npm registry.
The "cheapest now" window was not actually closing.

**Bundler pinned to webpack.** `apps/web` runs `next dev --webpack` / `next build --webpack`.
The workspace packages are NodeNext, so their relative imports carry `.js` extensions
pointing at `.ts` files; `tsc`, `tsx`, and Vitest do that substitution natively, bundlers do
not. `experimental.extensionAlias` fixes it — but as of Next 16.2 that option is webpack-only
and Turbopack ignores it, failing on every such import. Cost is build speed only. The durable
fix is a real build step emitting `dist/*.js` from the packages, which would drop both the
config and the flag; that is a deliberate change to the repo's no-build-step design, so it is
left as a decision rather than made silently.

**Env loading is not Next's default, and cannot be.** `apps/web/next.config.ts` loads the
monorepo root `.env` itself, walking upward like `packages/db/src/env.ts`. Next only reads
`.env` from its own project root (`apps/web/`), so the root file the rest of the repo uses is
invisible to it. This has to happen in the config rather than a runtime helper: `NEXT_PUBLIC_*`
is inlined at compile time, so a loader that runs when a request arrives would bake the
publishable key in as `undefined`. **Do not "fix" this by adding a second `.env` under
`apps/web/`** — two files holding the same keys drift, and one of them eventually gets
committed.

**Model output is rendered through a hand-written Markdown subset**
(`apps/web/src/app/markdown.ts` → `RichText.tsx`), not a library. Answer text is not purely
model-authored: merchant names travel Plaid → snapshot → evidence → answer and can be quoted
verbatim. The parser therefore produces a data tree that React renders as text nodes, never an
HTML string — injection is impossible by construction rather than by sanitising carefully.
There is a test asserting an `<img onerror=…>` payload stays literal text.

**Limitations are structured, not strings.** `Limitation = { tool?, reason }`. A bare string
could not tell a "why" card *which* step was missing, so the card said "not available" with no
subject. `reason` is written for a person; the thrown error goes to the server log via
`limitationFrom()`. Two tests enforce this: every limitation names its tool or is explicitly
about the answer as a whole, and no reason may contain a parameter name, a backticked
identifier, or its own tool name repeated.

---

## Known gaps (deliberate or small)

- **A compound question gets one workflow.** §5 maps an intent to exactly one pipeline, so
  *"what is my FIRE progress and what spending has happened recently?"* routes to
  `summary_overview` and the model correctly reports that it has no transaction data rather
  than inventing any. Honest, and the right failure mode — but it is a real characteristic of
  the design, not a bug to hunt.
- **Windows: a rename that only changes capitalisation needs `rm -rf apps/web/.next`.**
  Webpack's persistent cache keys on the old name, and a case-insensitive filesystem happily
  matches it, producing an "X is not exported" error for a file that no longer exists.

- **`deleteGoal` is not exposed over MCP** though it exists in `core`. An omission, not a
  decision — the setters got wired and the deleter didn't.
- **`insight_log` has no writer.** Deliberate: §8 puts the wiring in Phase 2. `toReasoningTrace()`
  is built and tested against the invariant that matters (no financial values survive).
- **Provenance notes are free text and contain account names and masks** (e.g. "Plaid Mortgage
  (…8888)"). Not a financial figure, and `linked_accounts` already stores masks by design — but
  it should be a deliberate call when `insight_log` starts persisting traces, not something
  inherited by accident.
- **Rental property is misread as a residence.** Plaid types both as `other`, so `fireProgress`
  excludes a rental that genuinely produces withdrawable income. Needs a user-context flag.
  Documented in CLAUDE.md §4 and surfaced as a provenance note.
- **`assetAllocation` buckets ETFs and mutual funds as `other`.** Without fund lookthrough the
  internal mix is unknowable, so true equity exposure is understated. Stated in a note rather
  than guessed at.

---

## What is left for Checkpoint 2

Checkpoint 2 is *"sign up, link a sandbox institution, see a transparent summary, ask
follow-ups with traceable evidence, **deployed**."* Everything but the last word is built.

1. **Neon** — the one account still missing. Create it through the Vercel Marketplace so
   credentials are auto-injected. Pick **Postgres 17** (matching `docker-compose.yml`) and the
   same region as the functions, since §7's refetch-per-turn already pays one Plaid round trip
   per turn without adding a cross-region DB hop.
2. **Deploy to Vercel.** Migrations should run against `DATABASE_URL_UNPOOLED`; the app reads
   the pooled `DATABASE_URL`. Generate a **fresh** `TOKEN_ENCRYPTION_KEY` for production rather
   than reusing the dev one — Neon starts empty, so no token needs to decrypt across the
   boundary.
3. **End-to-end run as a brand-new user** — sign up, link First Platypus through the UI, set a
   spend target, ask follow-ups. This is the acceptance test, and it has not been done yet.

Clerk is **done** (development instance; `pk_test_`/`sk_test_` work on localhost and on Vercel
preview URLs, so a production instance is only needed once a custom domain is attached).

### Before deploy, worth doing

- **Migrate off `createRouteMatcher`** — Clerk 7 deprecates it and warns on every boot. Its
  reasoning applies here: middleware auth relies on path matching, which can diverge from how
  Next actually routes. Not urgent, because `proxy.ts` was never the isolation boundary —
  `requireUser()` throws on every data path, so a routing gap yields a 401 rather than someone
  else's balances (§3) — but resource-based checks are the right shape before real users.
- **Decide on provenance notes containing account names and masks.** They already reach the
  browser in "why" cards. Harmless today; it should be a deliberate call before `insight_log`
  starts persisting traces, not something inherited by accident.

---

## Cold start

```bash
npm install
npm run db:up && npm run db:migrate
npm run link:sandbox -- --show    # prints the existing user UUID; links nothing
npm test
npm run agent:smoke               # drives the full agent loop against the sandbox
npm run dev                       # needs the two Clerk keys in .env
```

`npm run agent:smoke` is the fastest way to see the whole Phase 1 path working: it bypasses
Clerk, fetches a live snapshot for the sandbox user, and runs route → pipeline → synthesise →
attribution-check, printing for each answer whether it was clean, rewritten after a rejected
draft, or withheld. Pass questions as arguments to test specific routes.

`.env` is gitignored and already populated locally. If the sandbox user is missing, drop
`--show` to create it, then `npm run set:profile -- --spend 60000 --income 120000 --risk moderate` —
without a spend target `fireProgress` cannot run and the summary degrades to four tools.
