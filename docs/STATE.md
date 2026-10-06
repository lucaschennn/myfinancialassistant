# Project state

Living handoff notes. [CLAUDE.md](../CLAUDE.md) is the spec (what we're building and why);
[README.md](../README.md) is how to run it. This file is where things stand and what's open.

Last updated at the **end of the Phase 2 build (document ingestion)**, before the Checkpoint 2
run. Phase 2 exists because every judgement about Jolly's guidance had been made against First
Platypus Bank's invented numbers, and §10 blocks live institutions until the security and
employer checks clear — so the author's own documents are the only route to real data. See
CLAUDE.md §8 Phase 2.

**Checkpoint status** (Checkpoint N closes Phase N; renumbered from the original one-ahead
scheme, see CLAUDE.md §8): 0 ✅ · 1 functionally ✅, formally ⬜ (deploy only, now Phase 4) ·
1.5 ✅ · 2 ⬜ (ingestion — **built and tested; the run on your own documents is next**) ·
3 ⬜ (the playground — specified, see
[PHASE-3-PLAYGROUND.md](PHASE-3-PLAYGROUND.md)) · 4 ⬜ (deploy).

## Where Phase 2 landed

**Built, tested, and run live against the sandbox and the real model.** Steps 1–7 of
PHASE-2-INGESTION §8 are done; step 8, the Checkpoint 2 run on the author's own documents, is
not — it needs real files and a person (see *What is next*). 250 tests (from 176), typecheck
clean, production build clean.

**What exists now:**

- **Sources and the merge** (`packages/core/src/sources.ts`). The snapshot is
  `mergeSources([plaid, manual])`. Every account, holding, security, transaction, and gap carries
  a required `source`; every account a required `balanceAsOf`; provenance carries `sources`.
  Window = intersection, ids asserted unique, empty sources do not narrow the window. Aggregation
  tools derive their wording from the rows involved — "from your own records" is never "from
  Plaid". `fetchSnapshot` became **`fetchPlaidSource`** (a rename the spec did not ask for: it no
  longer returns a snapshot, and the old name would have lied at every call site).
- **Staleness** in calendar days, 7-day threshold, as a dated note on `getBalances`, `netWorth`,
  and `fireProgress`. **Document naming**: every manual balance's evidence says where it came
  from — "from the PDF statement imported 2026-10-05", "entered by hand" — by kind and date,
  **never filename** (real filenames carry account numbers, and evidence goes to the model).
- **Schema**: the six tables, one additive migration (`0001_manual_ledger.sql`), checked in
  `psql`. No balance/amount column exists on any Plaid table.
- **`packages/ingest`**: encrypted `DocumentStore` (separate `DOCUMENT_ENCRYPTION_KEY`, refuses to
  equal the token key, keys `${userId}/${uuid}` asserted on every access); content-sniffed
  upload with a 10 MB cap; RFC 4180 reader; column, date-format and sign-convention inference;
  the CSV and PDF draft builders; `checkTranscription()`; the transcription call; commit; reject;
  delete (keep or drop the ledger rows); `readManualSource`.
- **`parseAmount`** in `core/money.ts`: the one text-to-cents parser, used by typed entry, CSV,
  and PDF. It goes string → bigint with **no float at all**, so it is stricter than routing
  through `dollarsToCents` as the spec sketched (§4.3), not a second float boundary. Handles
  `$1,234.56`, `(89.00)`, `4.85-`, `CR`/`DR`; rejects double signs, European formats, and more
  than two decimals rather than guessing.
- **UI**: `/sources` (banks with disconnect, your records, documents), `/import`,
  `/import/[documentId]` (the review screen), `/accounts/new`, manual balance history and
  archive on `/accounts/[id]`, source badges ("Live · Plaid" / "Your records") on every account
  everywhere, "Data from" on every evidence card. Nav gains Sources and Import.
- **MCP**: the harness reads the manual ledger too; `refreshSnapshot` reports `sources`;
  `deleteGoal` is exposed (the STATE.md omission).

**How the draft works, since it is the design decision most worth knowing.** A draft is never
stored or edited. What is stored is the user's *decisions* (column roles, date format, sign
convention, which account, per-row edits) and — for a PDF only — the model's verbatim
transcription, which cannot be re-derived without another model call. Every read rebuilds the
draft from the encrypted original bytes plus the decisions; commit rebuilds it again and
re-checks every blocker and re-runs the transcription guard rather than trusting either. The
browser only ever sees a strings-only view: what the document said beside what the server made of
it. There is no path by which a hand-patched draft reaches the ledger.

**Verified by running, not by reading:**

- Both sign conventions committed through Postgres and read back through `cashFlow` with inflow
  and outflow the right way round (`documents.test.ts`) — §3.4.4.
- A hallucinated PDF closing balance ($50,000 against a printed $5,000) is dropped before review
  and never reaches the ledger; a tampered draft is refused at commit.
- A scanned (text-less) PDF is rejected with the reason, with no model call made.
- Re-uploading identical bytes is recognised; an overlapping export adds only new rows and
  reports the rest as skipped duplicates.
- **Live transcription** (`npm run transcribe:smoke`, one Sonnet call on a fictional statement
  generated in memory): structured output accepted, every figure quoted verbatim, guard dropped
  nothing, signs and totals correct.
- **Live merged snapshot**: a stale manual account added to the sandbox user beside 14 Plaid
  accounts; `agent:smoke` answered clean, net worth moved by exactly the manual balance, and
  Jolly said unprompted that the figure came from the user's own records and was dated
  31 August. The temporary account was removed afterwards and today's history point restored.

**Found by running it, fixed:**

1. **The live model quoted the statement date as the whole period** ("Aug 1, 2026 - Aug 31,
   2026"). The guard rightly accepted it — it is printed — but it did not parse, so there was no
   statement date, so year-less row dates ("08/03") could not be dated, and every transaction
   and the balance fell out of the draft. Nothing wrong reached it; it was just empty. Fixed
   twice over: a quoted period now resolves deterministically to its end date
   (`parseStatementEndDate`), and the prompt asks for the single date. The fixture tests could
   not have found this — they were written with the date the way I expected a model to quote it.
2. **Staleness compared instants, not dates.** A statement dated 28 September against a fetch at
   noon on 5 October is 7.5 days, so "a week old" tipped into "stale" depending on the time of
   day. Now whole calendar days.
3. **The sandbox item had gone `ITEM_LOGIN_REQUIRED`** before any of this ran (`agent:smoke`
   showed 0 accounts, 1 gap — and Jolly correctly explained the disconnection). The old item is
   kept with status `login_required`; a fresh First Platypus item was linked for the sandbox user.
   It has 14 accounts rather than 12, so net worth is now **−$77,164.15**, not −$40,452.32.

**Not verified — treat as likely to have bugs:**

- **No page of this UI has been opened in a browser.** Every new screen is verified by
  typecheck, a production build, and the API/library tests underneath it. The review screen is
  the largest client component in the repo; expect interaction bugs.
- **No real bank CSV or PDF has been tried.** The fixtures are fictional and shaped like the
  common exports; real ones will find column names and layouts the inference does not know.
- **Disconnect** (`/item/remove`) has not been run against Plaid.

## Known gaps added by Phase 2

- **Date arithmetic in prose is not guarded.** Jolly said a balance was "about five weeks older"
  — a duration it computed. `checkAttribution()` checks money and percentages only. Harmless
  here, but it is arithmetic, and a Phase 3 item (the guard bench is the place to decide).
- **One account per PDF.** A combined statement transcribes the first account and says how many
  more there are. Import the others separately or by hand.
- **Security types are not read from statements**, so PDF holdings count as `other` in asset
  allocation, with a note saying so.
- **A CSV with no balance column produces an account with no balance**, which `netWorth` leaves
  out (and says so). The review screen lets you enter the balance; it is easy to miss.
- **Bank category names are not mapped** (§10), so CSV rows are `UNCATEGORIZED` and transfers
  between your own accounts are not recognised as transfers — they count as in and out.
- **`documents.status` values `parsed` and `rejected` are unused.** Reject deletes the row and
  the bytes outright, so the same file can be uploaded again.

## Where Phase 1.5 left things

Checkpoint 1.5 passed on a real run: a brand-new Clerk user signed up locally, linked a sandbox
institution through the UI, set a spend target, walked every route, and read the network panels.
That run also covers every clause of Checkpoint 1's acceptance except the word *deployed*.

At that point: 176 tests, typecheck clean, production build clean, and all six workflows
answering clean against the live Plaid sandbox. Three defects were found by using the §0.1 guard in anger —
see *The guard's first findings* below.

### The Clerk cold-start redirect loop (fixed in the app, and it will recur in the OS)

First sign-in failed with a wall of `token-iat-in-the-future` followed by *"Refreshing the
session token resulted in an infinite redirect loop… your Clerk instance keys do not match"*.
A manual reload always worked. **The keys are fine — that second message is generic and a red
herring.** The cause is clock drift: this machine was **6.1s behind** real time, Clerk's default
tolerance is **5s**, so every token it issued was rejected as future-dated, and the rejection
triggered a refresh that issued another equally-future token. A reload works because by then
enough wall-clock time has passed for the cookie's `iat` to no longer be ahead of us.

Two fixes, and the second one is the one that matters:

1. **App-side, landed:** `proxy.ts` now passes `clockSkewInMs: 30_000` to `clerkMiddleware`.
   Ordinary drift degrades into a slightly stale token instead of an unrecoverable loop. 30s is
   far short of the session token's own lifetime, so the extra grace it grants an *expired*
   token is immaterial. Confirmed the option is forwarded: `clerkMiddleware`'s options spread
   into `authenticateRequest`, and `clockSkewInMs` is on `VerifyJwtOptions` (default 5000).
2. **OS-side, needs an elevated shell:** this is the *second* time this has bitten, because the
   first fix never persisted — `W32Time` was still `StartType: Manual` with `Last Successful
   Sync Time: unspecified`. Setting the service to Automatic is the part that makes it stick:
   ```powershell
   Set-Service W32Time -StartupType Automatic
   Start-Service W32Time
   w32tm /resync /force
   ```
   Check drift with `w32tm /stripchart /computer:time.windows.com /samples:3 /dataonly`.

---

## The pre-deploy review pass

Three fixes landed, in ascending order of how long they had been wrong.

**1. Rolling windows silently lost days.** `resolvePeriod` built `last_3/6/12_months` with
`Date.UTC(year, month - n, now.getUTCDate())`. Asking for six months on 31 August requests
31 February, which `Date.UTC` does not reject — it rolls forward to 3 March. The window came
back four days short, still labelled six months, and with **nothing in the provenance saying
so**: `period.ts`'s truncation notes only fire when a range exceeds the *fetched* snapshot
window, never when the range handed to them was wrong to begin with. That is a §0.2 violation
producing quietly wrong spending and cash-flow figures on roughly a tenth of all days.

`last_month` right below it was always correct, because its day-0 trick sidesteps the problem
entirely. The rolling cases just never reused it. Now factored into `monthsBack()`, which
clamps to the target month's last valid day.

The existing test suite could not have caught this: it asserted only that ranges never run
backwards, and a rolled-forward date still satisfies `from <= to`. Its own comment even said
"the 31st is where naive date math breaks" — it checked the right dates for the wrong
property. The new tests assert the boundary date itself.

**2. Migrations had no way to reach an unpooled connection.** This file previously said
migrations "should run against `DATABASE_URL_UNPOOLED`" — but the string appeared nowhere in
the repo, so the instruction was unfollowable. Neon's Vercel integration injects a pgbouncer
URL as `DATABASE_URL`; the postgres-js migrator takes a session-level advisory lock and issues
multi-statement DDL, neither of which survives transaction pooling. `directConnectionString()`
now prefers the unpooled variable and falls back, so local dev is untouched and the first Neon
migration cannot silently go through the pooler. `db:migrate` prints which variable it used —
the name, never the value.

**3. There was no way for a real user to set a spend target.** `setProfile` was reachable only
from `npm run set:profile` and the MCP harness, so every Clerk signup saw a permanently broken
FIRE card. This was not a cosmetic gap: Checkpoint 1's acceptance text is *"a new user can sign
up, link a sandbox institution, see a transparent summary dashboard"*, and that was false for
anyone without `psql` access. `/api/profile` plus `SpendTarget.tsx` closes it, rendered inside
the FIRE card itself so the fix appears where the limitation is explained rather than behind a
settings page a new user would have to go find.

The amount stays a **string** from the input through the request body to `dollarsToCents`.
Parsing it into a number in the browser would put a float conversion outside the one function
§0.3 permits to perform it.

---

## Where Phases 1 and 1.5 landed

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

**Not yet done:** deployment (Neon + Vercel — now Phase 4), the `insight_log` writer (Phase 3),
and any data that is not First Platypus Bank's fiction (Phase 2 — the point of it).

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

Net worth still reads **−$40,452.32**, matching Checkpoint 0.

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
> prose. Worth remembering when a later phase adds compute functions — and note that Phase 2's
> manual ledger satisfies it by construction, because manual liabilities are stored as the
> positive amount owed exactly as Plaid reports them. That is the *reason* to store them that
> way, not merely consistency.

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

**Phase 0 complete. Checkpoint 0 passed — both parts.**

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
| `insight_log` stores the reasoning trace | Transform + table + test exist; **still nothing writes** (§8 → Phase 3) |
| Values regenerated live on revisit | True — every turn refetches and recomputes |

The one row still outstanding is the `insight_log` writer, which §8 defers to Phase 3 on
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

- **~~`deleteGoal` is not exposed over MCP~~ — fixed in Phase 2.** It is registered now. It
  still has no test at any layer.
- **`annualIncomeCents` and `riskTolerance` are stored but drive nothing.** CLAUDE.md §4 lists
  them as profile fields, and `setProfile` writes them, but no compute function reads either —
  `savingsRate` takes income from `cashFlow`'s measured transaction inflow, not the profile.
  They do reach the evidence bundle through `getUserContext` (in `goal_progress` and
  `general_qa` only) and `humanize()` formats them, so Jolly may narrate them as context.

  **There is deliberately no UI to set either one.** `/goals` displays them read-only with a
  caveat saying so; `npm run set:profile -- --income 120000 --risk moderate` and the MCP
  `setProfile` tool are the only ways to write them. That asymmetry is a decision, not an
  oversight: adding inputs for two fields that feed no calculation would dress up decoration as
  settings. **Add the input for each one only when it starts doing work** — which is the whole
  point of the two items below.

  > If you are here because `/goals` looks half-finished: it is not. Do not "fix" it by adding
  > the two inputs. Do one of the following first, then add the matching input with it.

  **Income → a §4 compute gap, not an AI-phase item.** Wire it as the `savingsRate` fallback:
  when a period records zero inflow, fall back to the stored annual figure prorated to the
  period, flagged in provenance as profile-stated rather than measured. `savingsRate`'s own gap
  note already says a zero-income period usually means the paycheck lands in an unlinked
  account, so the fallback is answering a question the tool is already asking. This is
  deterministic compute with no model involved — filing it under Phase 3's "AI Sophistication"
  would bury a small compute fix in a phase about the model. Do it the next time `savingsRate`
  is open. **Phase 2 opens `savingsRate`'s neighbourhood but not `savingsRate` itself**, so this
  is still not the moment unless the sign-convention work ends up inside it.

  **Risk tolerance → Phase 3, with the identity work.** Its use is narration: allocation versus
  stated tolerance in `investment_review`, and tone in the system prompt. That belongs with the
  formalized identity and deepened evidence rendering, not on its own.
- **`insight_log` has no writer.** Deliberate: §8 puts the wiring in Phase 3. `toReasoningTrace()`
  is built and tested against the invariant that matters (no financial values survive). When the
  writer lands, `original_filename` needs adding to the redaction rules alongside the `Cents`
  suffix — a real statement filename carries an account number.
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

## What is next: the Checkpoint 2 run

The checklist is PHASE-2-INGESTION.md §9; it needs the author's own files, so it is a person's
job, not an agent's. In order:

1. **Settle the §9 employer outside-activity/IP item first.** The moment a real statement is
   uploaded it lands — encrypted — in `.documents/` on this machine. That is the point this stops
   being hypothetical.
2. Sign in, open **/sources**, disconnect every Plaid item. The dashboard must still work with
   nothing but your own records — add one account by hand first to see it.
3. **/import** a real CSV export. Check the column roles, the date format if asked, and — the one
   that matters — whether the two example sentences read the right way round. Commit.
4. **/import** a real PDF statement. Compare every "Read by AI" figure with the paper. Commit.
5. Dashboard, /history, /accounts, /accounts/[id], /goals, and chat: every figure right, every
   evidence card naming the document, staleness stated where a balance is old.
6. Upload the same statement again → "already imported". Then reconnect Plaid → both sources
   visible, no id collisions, staleness stated. Delete a document both ways.
7. `npm test`, `npm run typecheck`, `npm run build`; and in `npm run db:psql`, confirm the
   `manual_*` tables hold only your documents' rows and nothing from Plaid.

Write what happened here — especially what did not work. Real exports will find layouts the
fixtures did not.

### Background that still holds

Three things worth knowing about Phase 2's design, kept from when it was specified:

- **§0.4 changed, and it was the biggest spec decision in this re-plan.** "Plaid is the system of
  record; we never mirror its financial data" became "never mirror a system of record we do not
  own", with a corollary: a dataset with no external system of record has to be stored by us or it
  does not exist. Uploaded documents are authoritative *because* the user handed them over — there
  is nothing to refetch them from. The test for which regime applies is mechanical: *can we get
  this back from somewhere else on demand?* Plaid data, still no. Manual data, no — so it persists.
  The two regimes stay visibly distinct via `source` on every row.
- **§0.8 is new:** extraction is transcription, not computation. The model may emit only the
  verbatim string it read; a deterministic function converts it to cents; the string must be found
  in the document's own text or the row is dropped; a human confirms before commit.
  `checkTranscription()` is the §0.1-style guard, built as a sibling of `checkAttribution()`.
- **The likeliest way this phase ships something quietly wrong is the transaction sign
  convention.** Plaid uses positive = money *out*; most bank CSVs use the opposite. Getting it
  backwards inverts savings rate and swaps income with spending with **no error**, every figure
  still plausible. PHASE-2-INGESTION.md §3.4 is a numbered list for that reason.

## After that: Phase 3, the playground (specified, not started)

Phase 3 was redefined on 2026-10-05. Its centrepiece is a developer playground at `/playground`:
the prompt-to-answer lifecycle shown stage by stage, every stage runnable alone with hand-edited
input and changed prompts/models, a notebook for every tool and compute function, the ingestion
lane, a guard bench and a routing suite. The older AI-sophistication items stay in the phase and
are done *through* the playground. The spec is **[PHASE-3-PLAYGROUND.md](PHASE-3-PLAYGROUND.md)**;
Checkpoint 3 is defined there in §11.

Phase 2 kept both seams the playground needs: `inspectUpload`, `findDuplicate`, the CSV and
PDF draft builders, and `checkTranscription` are all pure and run on bytes in memory, with
`storeUpload` the only write; and `createTranscriber` takes the prompt, model, and token limit
as config with today's values as `DEFAULT_TRANSCRIPTION_CONFIG`. `scripts/transcribe-smoke.ts`
is a small preview of the playground's ingestion lane.

Three things discovered while specifying it, recorded so they are not rediscovered:
- **The atomic tools' parameter schemas live in `apps/mcp/src/server.ts`**, not in `core`. The
  playground's notebook needs the same schemas, so Phase 3 moves them to a `core` tool catalog
  that both consume (spec §4.2) rather than writing them twice.
- **`summary_overview` writes.** It appends a `networth_snapshots` row on every run. Run on a
  fixture or edited snapshot, that would put a fake point in the user's real history, so the
  workflow contract gains a dry-run flag (spec §4.3).
- **Model ids and token limits are module constants in `apps/web/src/server/agent.ts`.** They
  become an `AgentConfig` in `core` with today's values as defaults (spec §4.1). `/api/chat`
  must keep ignoring any config sent to it.

## Deployment (now Phase 4, deliberately last)

Moved out of Checkpoint 1. Deploying earlier is lower-risk in the narrow sense but buys nothing
the local build does not already prove, and it front-loads infrastructure ahead of the work that
decides what the product is. Everything in Checkpoint 1's acceptance text *except the word
"deployed"* has already passed locally.

Prerequisites, carried forward intact:

1. **Neon** — the one account still missing. Create it through the Vercel Marketplace so
   credentials are auto-injected. Pick **Postgres 17** (matching `docker-compose.yml`) and the
   same region as the functions, since §7's refetch-per-turn already pays one Plaid round trip
   per turn without adding a cross-region DB hop.
2. **Deploy to Vercel.** Migrations prefer `DATABASE_URL_UNPOOLED` automatically and fall back to
   `DATABASE_URL` (`packages/db/src/env.ts`), so that is no longer a step anyone has to remember.
   Generate a **fresh** `TOKEN_ENCRYPTION_KEY` for production rather than reusing the dev one —
   Neon starts empty, so no token needs to decrypt across the boundary.
3. **A real blob store behind `DocumentStore`.** New, and a hard blocker: Vercel's filesystem does
   not persist, so Phase 2's `LocalFileStore` cannot be deployed. Named in CLAUDE.md §2 and §8 so
   it is not discovered here. A separate production `DOCUMENT_ENCRYPTION_KEY` too.
4. **Confirm the Vercel plan honours `maxDuration = 120`** (`apps/web/src/app/api/chat/route.ts`).
   A chat turn is a live Plaid fetch plus a Haiku call plus a Sonnet call, and an attribution
   retry adds a *second* Sonnet call. Hobby caps conventional functions at 60s. Unverified.
5. **End-to-end runs as a brand-new user** — both the Checkpoint 1 flow and the Checkpoint 2
   document flow, against the deployed app, with documents surviving a redeploy.

Clerk is **done** (development instance; `pk_test_`/`sk_test_` work on localhost and on Vercel
preview URLs, so a production instance is only needed once a custom domain is attached).

### Phase 1.5 is built

All four workstreams landed. 176 tests, typecheck clean, production build clean.

**A. Network trace.** `TraceRecorder` in `packages/core/src/trace.ts`, threaded through
`Ctx.trace` (optional everywhere, so tests and the MCP harness need no plumbing). Instrumented
at the boundaries that make the calls: the Plaid client, the Anthropic router and synthesis
calls, the `plaid_items` read, and the net-worth-snapshot write. Rendered by `NetworkPanel` on
the dashboard, both accounts pages, and each chat answer.

Verified against the live sandbox rather than assumed — one dashboard render:

```
total wall-clock: 2911ms across 6 calls
  [db      ] read linked items                3ms  ok  1
  [internal] GET / (summary dashboard)     2911ms  ok     server render
  [plaid   ] /accounts/balance/get         1821ms  ok  12  First Platypus Bank
  [plaid   ] /investments/holdings/get      439ms  ok  13  First Platypus Bank
  [plaid   ] /transactions/get              640ms  ok  49  First Platypus Bank
  [db      ] append net worth snapshot         4ms  ok
```

Leak checks on the serialised trace all came back false: no `access-` token, no account id, no
`Cents` figure. A test pins that an error message never reaches the trace — Plaid errors can
quote the request that produced them, so a failed call reports `failed` and the human reason
travels as a snapshot gap instead.

`totalMs` is **wall-clock, not a sum of durations.** Overlapping calls summed would overstate
what the user actually waited for, and a transparency panel that inflates the number it exists
to disclose is worse than no panel.

> **Constraint worth remembering:** `NetworkPanel` is rendered by `Chat.tsx`, a client
> component, so it may only take **type** imports from `@pfg/core`. A runtime import there is
> followed into the browser bundle, and `@pfg/core`'s entry reaches `@pfg/db` → `postgres` →
> `net`. The build fails with `Module not found: Can't resolve 'net'`, which reads like a
> bundler problem and is actually this. Display labels therefore live in the component, not in
> `core`. This cost one build failure to discover; there is a comment at both ends.

**B/C. Surface area and routes.** `/history` (net worth chart + full table from
`networth_snapshots`), `/accounts` (balances by institution, with `snapshot.gaps` promoted from
prose-in-a-note to its own card), `/accounts/[id]` (holdings, securities, and the transaction
window — the three datasets that were fetched and discarded unseen on every request), and
`/goals` (goals, notes, and the spend target). `deleteGoal` and `addNote` have callers for the
first time since Phase 0.

The `/history` chart is hand-rolled inline SVG, one series, no charting library and no client
JS: point tooltips are native SVG `<title>` on generous invisible hit circles. The y-range
always includes zero — with a negative net worth, an axis that floated would hide whether the
user is above water at all.

**D. Evidence rendering.** Caveats and gaps now carry explicit `CAVEAT` / `GAP` tags instead of
relying on 12px gold text to be self-evident. Colour was doing all the work on the most
important sentence on the card.

### Phase 1.5 as originally specified

CLAUDE.md §8 gained a **Phase 1.5 — Surface Area & Network Transparency**, covering the four
gaps in the Checkpoint 1 UI: no disclosure of network cost, a large amount of computed and
stored data that never reaches the screen (net worth history most notably — it has been
accumulating since Phase 0), no information architecture beyond a single page, and evidence
rendering that buries the product's own thesis in a collapsed `<details>`.

The one new concept is the **network trace**: a request-scoped record of which of our routes ran
and which external services were called, rendered next to the thing that caused it. It carries
names, counts, durations, and outcomes — never payloads — and is never persisted, on the same
lifecycle as the session snapshot. §0.2 was widened to cover it: transparency applies to the
work performed, not only to the figures.

Sequencing is deliberately left open. Deploying first is lower risk, because the acceptance run
will show which surfaces actually matter before any of them get built.

### Before deploy, worth doing

- **Migrate off `createRouteMatcher`** — Clerk 7 deprecates it and warns on every boot. Its
  reasoning applies here: middleware auth relies on path matching, which can diverge from how
  Next actually routes. Not urgent, because `proxy.ts` was never the isolation boundary —
  `requireUser()` throws on every data path, so a routing gap yields a 401 rather than someone
  else's balances (§3) — but resource-based checks are the right shape before real users.
- **Decide on provenance notes containing account names and masks.** They already reach the
  browser in "why" cards. Harmless today; it should be a deliberate call before `insight_log`
  starts persisting traces, not something inherited by accident. **Phase 2 raises the stakes:** a
  real statement filename reads `chase_statement_4412_aug2026.pdf` and carries an account number,
  so filenames join masks in this decision.
- **`/api/plaid/webhook` does not exist.** `proxy.ts` allowlists it as a public route and explains
  that it authenticates by signature — but no handler was ever written. §9's "Plaid webhook
  signature verification" is therefore **not met**, not merely unverified: there is nothing to
  verify. The practical consequence is that the app only learns an item has entered
  `login_required` or `revoked` when the next live fetch fails and surfaces it as a snapshot
  `gap`, which is acceptable for a sandbox demo but should be a stated deferral rather than an
  accident. Either build the handler or drop the allowlist entry so the route table stops
  implying one exists.
- **Settle the §9 employer action item before Phase 2's first real upload.** It has been
  hypothetical while everything was sandbox fiction. The moment the author's own bank statements
  land in local storage it is not, and that is a better time to have thought about it than
  afterwards.

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

**Phase 2 environment:** `DOCUMENT_ENCRYPTION_KEY` (distinct from `TOKEN_ENCRYPTION_KEY` —
CLAUDE.md §9; the loader refuses an identical value) was generated into the local `.env` during
the build. `DOCUMENT_STORE_DIR` is optional and defaults to `.documents/` at the repo root,
which is **already gitignored** — check that before the first real upload anyway.
`npm run transcribe:smoke` makes one live model call on a fictional, in-memory statement and
prints what was quoted, what the guard dropped, and the draft.
