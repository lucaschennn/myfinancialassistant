# Phase 2 — Document Ingestion: buildable spec

The *what and why* is [CLAUDE.md](../CLAUDE.md) §0.4, §0.8, §3, §7, §8 Phase 2. This file is the
*how*: concrete types, tables, file layout, sequencing, and the traps. It is written to be built
from by an agent that has read STATE.md and CLAUDE.md and nothing else.

**The one-sentence goal:** a user with zero Plaid connections can hand the app their own CSV
exports and PDF statements and get the entire existing product — dashboard, net worth, chat,
evidence cards — computed from them.

**The one-sentence design:** the session snapshot stops being "the result of a Plaid fetch" and
becomes "the merge of every source", where Plaid is one source that is fetched live and never
stored, and the manual ledger is another that is stored because nothing else holds it.

> **As built (2026-10-05).** Steps 1–7 of §8 are done; step 8, the Checkpoint 2 run on real
> documents, is not. STATE.md "Where Phase 2 landed" is the account of what was verified and how.
> Where the build deliberately differs from this spec:
>
> - **`fetchSnapshot` was renamed `fetchPlaidSource`** (§1.6). It no longer returns a snapshot;
>   keeping the name would have lied at every call site.
> - **Text amounts go through `parseAmount`, not `dollarsToCents`** (§4.3). It parses the string
>   straight into bigint cents with no float at all — stricter, not a second float boundary.
> - **The draft is derived, never stored** (§3.2, §5). `draft_json` holds the user's decisions
>   and, for a PDF, the model's verbatim transcription; the draft is rebuilt from the encrypted
>   bytes on every read and again at commit.
> - **Reject deletes** the document row and bytes, so the same file can be uploaded again;
>   `parsed` and `rejected` statuses are unused.
> - **Evidence names a document by kind and import date, never by filename** (§9, Checkpoint 2
>   step 4) — `balanceOriginNotes` in `snapshot.ts`.
> - **A quoted statement period resolves to its end date** (§3.5). The live model quoted "Aug 1,
>   2026 - Aug 31, 2026" for the statement date; the fixtures had not anticipated it.
> - **Plaid items can be disconnected** from `/sources` (`disconnectPlaidItem`), which Checkpoint 2
>   step 1 needed and nothing provided.

---

## 0. Read this first: what must not break

Phase 1.5 ended with 176 tests, a clean typecheck, a clean production build, and all six
workflows answering correctly against the live sandbox. That is the baseline. Specific things
that are load-bearing and easy to break from here:

| Invariant | Where it lives | How this phase threatens it |
|---|---|---|
| The AI never computes a number | `checkAttribution()` | The extractor is a model touching figures. §0.8 is the answer; see §4 below. |
| Money is integer cents, `dollarsToCents` is the only float boundary | `packages/core/src/money.ts` | CSV amounts and PDF strings are new float boundaries. They must route through `dollarsToCents` **on the server** and nowhere else. |
| A signed compute field must expose its speakable form | `NetWorthLine.balanceCents` | Manual liabilities must store positive amount owed, matching Plaid. |
| Client components take **type-only** imports from `@pfg/core` | `NetworkPanel.tsx`, `trace.ts` comments | The review screen is heavily interactive and will want `core` helpers. A runtime import drags `@pfg/db` → `postgres` → `node:net` into the bundle and fails the build with `Module not found: Can't resolve 'net'`. |
| Every query scoped by `ctx.userId` | convention in `core` | Six new tables, every one of them needs it, and `documents` needs it on the storage key too. |
| Nothing financial in `insight_log` | `redactParams()` | Params ending in `Cents` are redacted. A `documentId` is fine; a `filename` is not — see §6. |

---

## 1. The source abstraction

### 1.1 `SourceKind` and snapshot changes

In `packages/core/src/snapshot.ts`:

```ts
export type SourceKind = 'plaid' | 'manual';
```

Add to `SnapshotAccount`, `SnapshotHolding`, `SnapshotSecurity`, `SnapshotTransaction`:

```ts
  source: SourceKind;
```

Add to `SnapshotAccount` only:

```ts
  /**
   * When this account's balance was true. For Plaid this is the snapshot fetch
   * time; for a manual account it is the statement date, which may be months
   * old. Required, not optional, so that no caller can forget to consider it.
   */
  balanceAsOf: string;   // ISO 8601
```

Add to `SessionSnapshot`:

```ts
  /** Which sources contributed. Empty means the user has connected nothing. */
  sources: SourceKind[];
```

`SnapshotGap` gains `source: SourceKind` and its `dataset` union gains `'documents'`, so a
document that failed to parse surfaces the same way a bank that was down does. Gap text is
already free-form prose rendered in "why" cards; keep it that way.

> **Do not make `source` optional with a `'plaid'` default.** A required field forces every
> construction site to state the answer, and the compiler then finds every place this phase
> forgot. An optional one makes a manual row silently claim to be a Plaid row.

### 1.2 Account id collisions

`accountId` is currently a Plaid account id, assumed globally unique. Manual accounts need ids
that cannot collide with Plaid's, because a collision would merge or drop an account with
nothing erroring — a silently wrong net worth, which is the worst failure mode this codebase
has.

Manual account ids are the DB uuid prefixed `manual_`:

```ts
export function manualAccountId(uuid: string): string { return `manual_${uuid}`; }
export function isManualAccountId(id: string): boolean { return id.startsWith('manual_'); }
```

Belt and braces with the `source` field, deliberately: the prefix makes collision structurally
impossible, the field makes origin legible without string inspection. Assert on merge that no id
appears twice across sources and throw if one does — a loud failure beats a quiet double-count.

The prefix is URL-safe, which matters because `/accounts/[accountId]` already exists.

### 1.3 The merge

New file `packages/core/src/sources.ts`. The merge is a function, not a class, and it is pure:

```ts
export interface SourceResult {
  kind: SourceKind;
  accounts: SnapshotAccount[];
  holdings: SnapshotHolding[];
  securities: SnapshotSecurity[];
  transactions: SnapshotTransaction[];
  transactionWindow: { from: string; to: string } | null;
  gaps: SnapshotGap[];
}

export function mergeSources(userId: string, results: SourceResult[], now?: Date): SessionSnapshot;
```

Merge rules, each of which needs a test:

1. **Ids are asserted unique** across results (§1.2). Throw, do not dedupe.
2. **`transactionWindow` is the intersection**, not the union. Plaid was asked for 90 days; a CSV
   might hold 3 years. Reporting the union would let `cashFlow` describe a period for which one
   source has no data as if it were fully covered. The intersection is the range every
   contributing source can speak to — and the wider ranges are then reported as a note naming
   what else is available. Getting this backwards produces a cash-flow figure that is wrong by
   however much data one source lacks, with nothing saying so.
3. **`securities` dedupe by `securityId`** as the Plaid fetch already does within itself. Manual
   security ids get the same `manual_` prefix treatment.
4. **`sources`** lists kinds that returned at least one account.
5. **Gaps concatenate**, preserving source.

`emptySnapshot()` stays and gains `sources: []`.

### 1.4 Provenance

In `packages/core/src/provenance.ts`, add to `Provenance`:

```ts
  /** Data origins behind this figure. A single `source` enum cannot say "both". */
  sources?: SourceKind[];
```

`ProvenanceSource` (the existing `source` field) is unchanged — it describes *how* the figure was
obtained (`plaid` | `db` | `compute` | `user`), which is a different axis from *where the
underlying data came from*. Resist collapsing them; a `netWorth` result is `source: 'compute'`
and `sources: ['plaid', 'manual']`, and both facts are worth stating.

### 1.5 Staleness — the correctness issue in this phase

A manual balance dated 2026-08-31 merged with a Plaid balance fetched this morning produces a
net worth that is accurate as of no single moment. CLAUDE.md §4 requires this be stated.

Add to `packages/core/src/snapshot.ts`:

```ts
/**
 * Accounts whose balance is older than `staleAfterDays` relative to the
 * snapshot's fetch time, for provenance notes.
 */
export function staleAccounts(
  snapshot: SessionSnapshot,
  staleAfterDays?: number,
): SnapshotAccount[];
```

Default threshold **7 days**: short enough that a month-old statement is always flagged, long
enough that a Plaid fetch and a statement uploaded the same week do not generate noise on every
figure.

Every compute function that reads balances (`netWorth`, `fireProgress`) attaches a note naming
each stale account and its date. Write the note so it reads as information rather than a warning
— "Plaid Checking's balance is from the statement dated 2026-08-31" — because §6's persona is
proactive but not alarmist, and a user who is *deliberately* tracking an account by statement
should not be nagged about it.

**Test this with a fixture mixing a fresh and a stale account**, and assert the note names the
date. A test that only checks the note exists would pass with the date wrong.

### 1.6 Plaid becomes a source

`fetchSnapshot()` in `packages/plaid` currently returns a `SessionSnapshot`. Change it to return
a `SourceResult` with `kind: 'plaid'`, setting `source: 'plaid'` and `balanceAsOf` in
`normalize.ts`. Every call site then goes through `mergeSources`.

This is a breaking change to a function with several callers (`apps/web/src/server/session.ts`,
`apps/mcp`, scripts, tests). That is intentional and good: the compiler enumerates everywhere
that needs to learn about sources. Do not add a compatibility wrapper that returns the old shape.

---

## 2. Schema

New migration. Drizzle definitions in `packages/db/src/schema.ts`, following the conventions
already there: `uuid` primary keys with `defaultRandom()`, `bigint(..., { mode: 'bigint' })` for
every money column, `user_id` FK with `onDelete: 'cascade'` and an index, and a doc comment
explaining *why* each table exists rather than restating its columns.

### `documents`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid fk → users, cascade | indexed |
| `kind` | text | `csv` \| `pdf` \| `manual_entry` |
| `original_filename` | text | display only — **never** a storage path (§9) |
| `mime_type` | text | from content sniff, not the extension |
| `byte_size` | integer | |
| `sha256` | text | **unique on `(user_id, sha256)`** — the duplicate guard |
| `storage_key` | text | opaque, server-generated; see §3.1 |
| `status` | text | `uploaded` \| `parsed` \| `needs_review` \| `committed` \| `failed` \| `rejected` |
| `page_count` | integer nullable | PDFs; feeds the network trace count |
| `failure_reason` | text nullable | human-readable, e.g. "no text layer — scanned image" |
| `draft_json` | jsonb nullable | the parse draft awaiting review; **cleared on commit** |
| `uploaded_at`, `committed_at` | timestamptz | |

`draft_json` holds financial figures, so it is deliberately transient: cleared the moment the
draft is committed or rejected, because past that point it is a duplicate of the ledger with no
reader. A `documents` row for `kind: 'manual_entry'` has no bytes and no `storage_key` — it exists
so a typed-in account has a provenance target like every other row.

### `manual_accounts`

`id`, `user_id`, `document_id` (nullable fk → documents, `onDelete: 'set null'`), `name`,
`official_name`, `mask`, `type`, `subtype`, `institution_name`, `iso_currency_code`,
`archived_at` (nullable), `created_at`, `updated_at`.

`type` must be one of `AccountType`. Validate in `core` on write — the DB column is text, so the
type safety has to come from the tool.

**Archive, do not delete.** A deleted account with surviving balance rows is a dangling ledger;
archiving keeps history intact and drops the account out of new snapshots. `archived_at IS NULL`
is the snapshot's filter.

### `manual_balances`

`id`, `user_id`, `account_id` (fk → manual_accounts, cascade), `document_id` (nullable),
`as_of_date` (date), `current_cents`, `available_cents` (nullable), `limit_cents` (nullable),
`created_at`. **Unique on `(account_id, as_of_date)`** — re-importing a statement updates that
date's balance rather than adding a second one.

A series, not a column, for three reasons: statements are dated, `networth_snapshots` needs
something honest to chart for a manual user, and correcting a typo should not destroy the
previous value.

**Liability balances are stored positive** — the amount owed, exactly as Plaid reports it. The
sign flip into a negative net-worth contribution happens in `netWorth` and nowhere else, which is
already true and must stay true (§0 table above).

### `manual_transactions`

`id`, `user_id`, `account_id` (fk, cascade), `document_id` (nullable), `date` (date),
`amount_cents`, `name`, `merchant_name` (nullable), `category_primary` (nullable),
`category_detailed` (nullable), `external_id` (nullable), `iso_currency_code`, `created_at`.

**Unique on `(account_id, date, amount_cents, name)`** as the practical dedupe key when
`external_id` is absent, which it usually is. This is imperfect — two identical coffees on the
same day at the same price are a real event and one will be dropped. That tradeoff is chosen
deliberately over the alternative, because overlapping statement windows are far more common than
true duplicate transactions, and a double-counted month of spending is a worse and less visible
error than one missing $4 row. **Surface it:** the commit step reports how many rows were skipped
as duplicates, so the user can see when the count looks wrong.

`amount_cents` is in **Plaid's sign convention** (positive = money out). See §3.4 — this is the
single most important line in this document.

Index `(user_id, date)` — the snapshot reads by window.

### `manual_holdings` / `manual_securities`

`manual_securities`: `id`, `user_id`, `name`, `ticker_symbol`, `type`, `close_price_cents`,
`is_cash_equivalent`, `created_at`. `type` uses Plaid's security taxonomy verbatim (`equity`,
`etf`, `mutual fund`, `fixed income`, `cash`, `cryptocurrency`, `derivative`, `loan`, `other`) —
no new taxonomy (§10).

`manual_holdings`: `id`, `user_id`, `account_id` (fk, cascade), `security_id` (fk →
manual_securities), `document_id` (nullable), `quantity` (`numeric`), `cost_basis_cents`
(nullable), `value_cents`, `as_of_date`, `created_at`.

`quantity` is the one non-cents number in the schema — a share count, genuinely fractional, and
not money. It matches `SnapshotHolding.quantity: number`. Read it as a JS number; do not route it
through `dollarsToCents`.

`value_cents` is the institution-reported value, matching `SnapshotHolding.valueCents`. **Do not
compute it as `quantity × close_price`** even when both are present — that is arithmetic on
imported data, and if the statement states a value, the statement's value is the fact. If the
statement states only quantity and price, the *review screen* asks the user to confirm, and the
multiplication happens in a deterministic `core` function with a provenance note saying so.

---

## 3. `packages/ingest`

New workspace package. Depends on `@pfg/core` and `@pfg/db`. Server-only: nothing here may be
imported from a client component.

```
packages/ingest/src/
  index.ts          → public surface
  store.ts          → DocumentStore interface + LocalFileStore
  upload.ts         → sniff, hash, dedupe, persist bytes, create the row
  csv/parse.ts      → RFC 4180 reader
  csv/columns.ts    → column role inference + the sign-convention detector
  pdf/extract.ts    → text-layer extraction (server-only)
  pdf/transcribe.ts → the Anthropic call
  pdf/guard.ts      → checkTranscription()
  draft.ts          → the Draft type + validation
  commit.ts         → draft → manual_* rows, one transaction
  read.ts           → manual ledger → SourceResult
```

> **Phase 3 seam, worth respecting now.** The Phase 3 playground
> ([PHASE-3-PLAYGROUND.md](PHASE-3-PLAYGROUND.md) §7) runs every ingest stage up to the draft on
> bytes held in memory, and must never persist. So keep **sniff, hash and the dedupe *check***
> pure and separate from **persisting** the bytes and the `documents` row, even though
> `upload.ts` calls them in sequence. Likewise make the transcription prompt and model
> parameters of `pdf/transcribe.ts` with today's values as defaults. Both are small now and
> awkward to retrofit. Building the playground itself is not Phase 2 work.

### 3.1 `DocumentStore`

```ts
export interface DocumentStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}
```

Keys are **server-generated and opaque**: `${userId}/${uuid}`. Never derived from the uploaded
filename — a filename is attacker-controlled and `../` is a path (§9). Assert the key starts with
the requesting `userId` on every `get`, so a mixed-up id is a thrown error rather than another
user's statement.

`LocalFileStore` writes to `process.env.DOCUMENT_STORE_DIR` (default `.documents/` at the repo
root, **gitignored — add this in the same commit as the store**, before any real file exists).
Bytes are AES-GCM encrypted via a new `encryptBytes`/`decryptBytes` in `packages/db/src/crypto.ts`,
keyed by a **new `DOCUMENT_ENCRYPTION_KEY`** — separate from `TOKEN_ENCRYPTION_KEY` per §9. Follow
`loadKey()`'s existing shape and error type so a missing key fails with the same clear message.

Vercel's filesystem does not persist; a real blob store behind this interface is a Phase 4
prerequisite, already named in CLAUDE.md §2 and §8.

### 3.2 The `Draft`

The central type. A draft is a **proposal**, and the only thing `commit.ts` accepts.

```ts
export interface DraftField<T> {
  value: T;
  /** Exactly what the source said, before interpretation. */
  raw: string;
  /** How this value was arrived at — drives the review UI's emphasis. */
  origin: 'parsed' | 'transcribed' | 'user';
  /** Only for 'transcribed': where in the document, for the guard and the UI. */
  page?: number;
  confidence?: 'high' | 'low';
}

export interface DraftAccount {
  /** Set when the user maps this to an account that already exists. */
  existingAccountId?: string;
  name: DraftField<string>;
  type: DraftField<AccountType>;
  subtype: DraftField<string | null>;
  mask: DraftField<string | null>;
  institutionName: DraftField<string | null>;
  balance?: { asOfDate: DraftField<string>; currentCents: DraftField<Cents>; /* … */ };
  transactions: DraftTransaction[];
  holdings: DraftHolding[];
}

export interface Draft {
  documentId: string;
  kind: 'csv' | 'pdf' | 'manual_entry';
  accounts: DraftAccount[];
  /** Columns, lines, or pages the parser could not interpret. Shown, not hidden. */
  unparsed: Array<{ where: string; text: string; reason: string }>;
  /** Stated totals that disagree with the sum of parts (§4.4). Never auto-resolved. */
  discrepancies: Array<{ label: string; statedRaw: string; computedCents: Cents; page?: number }>;
  /** Detected sign convention, for the review screen to confirm (§3.4). */
  signConvention?: { detected: 'plaid' | 'inverted'; evidence: string };
}
```

`raw` on every field is not redundancy. It is what makes the review screen able to show the user
what the document actually said next to what we made of it, and it is what `checkTranscription()`
verifies against the extracted text. Dropping it would make both impossible.

`Cents` in a draft means `dollarsToCents` has already run — on the server, in the parser. See
§3.4.

### 3.3 CSV

`csv/parse.ts` is a plain RFC 4180 reader: quoted fields, escaped quotes, CRLF. Nothing more.
Return `string[][]` and a header row; interpretation belongs in `columns.ts`.

`csv/columns.ts` infers column roles (date, amount, description, merchant, category, balance,
debit/credit pair) from header names **and** from the shape of the values, because bank CSV
headers are wildly inconsistent. Inference produces a *proposal the user confirms*; it is never
final. Support the common two-column debit/credit layout, not just a single signed amount column.

Date parsing: infer the format from the column as a whole, not row by row — `03/04/2026` is
ambiguous alone and usually unambiguous once you have thirty of them. If the whole column stays
ambiguous, **ask**; do not assume a locale. Silently reading US dates as UK ones shifts a
transaction by months and nothing errors.

### 3.4 The sign convention — read this twice

`SnapshotTransaction.amountCents` uses **Plaid's convention: positive means money leaving the
account.** `cashFlow` and `savingsRate` interpret exactly that. Most bank CSV exports use the
opposite (negative = debit).

Requirements:

1. **Detect** the file's convention. Strong signals: an explicit debit/credit column pair; a
   header naming one direction; the distribution of signs (most people have far more outflows than
   inflows); rows whose description is recognisably income.
2. **Confirm in plain language, never in jargon.** The review screen shows a real sampled row as
   a sentence: *"`STARBUCKS #4412  -4.85` → $4.85 **spent** at Starbucks on 3 April"*, with a
   control to flip it. A user cannot verify "sign convention: inverted" but can instantly verify
   "spent" versus "received".
3. **Convert at the boundary** — in the parser, producing Plaid-convention cents in the draft.
   Nothing downstream of the draft knows a convention existed.
4. **Test both directions** with a fixture per convention, asserting `cashFlow` over the committed
   ledger produces inflow and outflow the right way round.

Getting this backwards inverts savings rate and swaps income with spending **without raising an
error**. Every figure stays plausible. This is the single most likely way this phase ships
something quietly wrong, which is why it gets a numbered list and a paragraph rather than a
sentence.

### 3.5 PDF

`pdf/extract.ts` pulls the text layer, per page, server-side. No text layer → `documents.status =
'failed'`, `failure_reason = 'no text layer — this looks like a scanned image'`. **Do not OCR**
(§10) and do not hand a page image to a model as a fallback: that abandons the guard in §4, since
there is no extracted text to check a quoted string against.

Keep extracted text request-scoped, exactly like a snapshot. It is the most PII-dense string the
process will ever hold.

---

## 4. The transcription guard

This is §0.8 made real, and it is the part of the phase that has to be right. Model it directly on
`checkAttribution()` in `packages/core/src/agent/attribution.ts` — read that file before writing
this one; the shape, the report type, and the tests should feel like siblings.

### 4.1 The contract with the model

The extraction call is given the extracted page text and asked for structure. It returns, for
every figure, **the verbatim string as it appears in the document** — never a number, never a cents
integer:

```jsonc
{ "label": "ending balance", "raw": "$4,182.09", "page": 1 }
```

The system prompt states the rule plainly: *quote, never compute, never tidy.* No summing, no
currency normalising, no fixing an obvious typo, no inferring a missing value. A field it cannot
find is reported absent, which is a legitimate and expected answer.

Use structured outputs, as the router already does, so the shape is enforced rather than hoped for.
Record the call in the network trace by model name and duration like every other Anthropic call
(§0.2) — and **never put extracted text or a quoted figure in a trace entry** (§9).

### 4.2 `checkTranscription()`

```ts
export interface TranscriptionViolation {
  label: string;
  raw: string;
  page?: number;
  reason: 'not-found-in-text' | 'not-on-claimed-page' | 'unparseable-amount';
}

export function checkTranscription(
  pages: string[],
  claims: Array<{ label: string; raw: string; page?: number }>,
): { ok: boolean; violations: TranscriptionViolation[] };
```

Every `raw` must occur in the extracted text, and on the page claimed if one was. Normalise only
what is genuinely presentational — collapse runs of whitespace, since PDF extraction inserts them
unpredictably. Do **not** normalise currency symbols, thousands separators, or parenthesised
negatives away before comparing: those are exactly the details a hallucination gets subtly wrong,
and a matcher loose enough to forgive them is a matcher that passes invented figures.

A violation does not mean "warn the user". It means **that field is dropped from the draft** and
the drop is shown on the review screen with its reason. The failure is visible, and the ledger
never sees it.

### 4.3 Then `dollarsToCents`, on the server

`raw` → strip currency symbol and thousands separators → interpret `(1,234.56)` and a trailing
`CR`/`DR` as the accounting negatives they are → `dollarsToCents`. One function, in `ingest`,
server-side, tested against the ugly cases. The model never emits cents and the browser never
parses an amount (§0.3).

### 4.4 Arithmetic discrepancies

If a statement states a total and the sum of its parts disagrees, that is a `Draft.discrepancy`.
Show both figures and let the user decide. **Never** reconcile silently, and never ask the model
which is right — that is derivation, which §0.1 forbids outright.

### 4.5 Tests that actually prove it

- A fixture where the model returns a figure **absent from the page text** → violation, field
  dropped. This is the hallucination test and it is the reason the guard exists.
- A figure present in the document but on a **different page** than claimed → violation.
- `$1,234.56`, `(89.00)`, `1.234,56` if a European format is in scope, `4,182.09 CR` → correct
  cents or an explicit `unparseable-amount`.
- A stated total that disagrees with its parts → a discrepancy, and **no** silent fix.
- A draft containing a violated field → `commit.ts` **refuses**. Belt and braces: the guard runs
  at parse, and commit re-checks rather than trusting that it did.

> STATE.md's standing warning applies with full force here: *a passing suite is not proof of a
> correct assertion.* The rolling-window date bug survived a test that checked those exact dates
> for the wrong property. Assert the specific cents value and the specific violated field, not
> merely that a violation array is non-empty.

---

## 5. Review and commit

### 5.1 `/import/[documentId]` — the review screen

The most important new surface in the phase. It is the §0.8 human confirmation, it is where the
sign convention gets caught, and it is the only thing standing between a hallucinated figure and
the ledger. Build it as a product surface, not a JSON dump with a submit button.

Requirements:

- **Every figure shows its `raw` next to its interpretation.** This is the whole point.
- **`origin` drives emphasis.** `transcribed` fields — a model read these — are visually distinct
  from `parsed` ones and from anything the user typed. `confidence: 'low'` and any dropped field
  are surfaced, not buried.
- **The sign-convention confirmation is a first-class step**, phrased as §3.4.2 requires, not a
  checkbox in a corner.
- **`unparsed` is shown.** A column we ignored is information the user needs; hiding it is the
  §0.2 failure mode in a new costume.
- **`discrepancies` block commit** until acknowledged.
- **Editing is allowed**, and an edited field becomes `origin: 'user'`.
- **Amounts stay strings** from input to request body to `dollarsToCents` on the server. Parsing an
  amount into a number in the browser puts a float conversion outside the one function §0.3 permits
  to perform it — the same reasoning that made `SpendTarget.tsx` keep its value as a string.
- Reject is as prominent as commit. A misparsed document should be easy to throw away.

### 5.2 `commit.ts`

One DB transaction: upsert accounts, insert balances/transactions/holdings/securities, clear
`draft_json`, set `status: 'committed'` and `committed_at`. Partial commits are not a state the
system has.

Returns a summary the UI shows: accounts created versus matched, rows inserted, **rows skipped as
duplicates** (§2, and the reason that count matters), and discrepancies acknowledged.

Re-checks the transcription guard before writing (§4.5).

### 5.3 `read.ts`

Manual ledger → `SourceResult`. Latest `manual_balances` per non-archived account; holdings and
securities; transactions inside the requested window. Scoped by `ctx.userId`. Sets `source:
'manual'`, `balanceAsOf` from `as_of_date`, and the `manual_` id prefix.

One query per dataset, not per account — a user with thirty manual accounts should not produce
thirty round trips on every dashboard render, and the network trace will make it obvious if they
do.

---

## 6. Wiring into the existing system

### 6.1 Snapshot assembly

`apps/web/src/server/session.ts`'s `requireSnapshotCtx()` becomes: run the Plaid source (if the
user has active items) and the manual source (if the user has non-archived manual accounts) →
`mergeSources`. Both are traced. A user with neither gets an empty snapshot and the existing
empty-state UI.

`hasLinkedItems()` currently gates the dashboard on `plaid_items`. It must become
`hasAnySource()`, or a manual-only user is shown "connect a bank" forever — the exact failure
Checkpoint 2 exists to catch.

Same wiring in `apps/mcp` (`session.ts`, and expose the manual source in `refreshSnapshot`) and in
`scripts/`. **Also expose `deleteGoal` over MCP while in there** — STATE.md records it as an
omission, it costs one line, and this is the session that touches that file.

### 6.2 Compute functions

Ideally untouched. In practice:

- `netWorth`, `fireProgress` — attach staleness notes (§1.5) and `provenance.sources`.
- `spendingByCategory` — its uncategorised note currently hard-codes *"arrived from Plaid without
  a category"*, which is false for CSV rows. Derive the wording from the sources actually present
  (CLAUDE.md §4).
- `assetAllocation` — no change beyond `sources`.
- `cashFlow`, `savingsRate` — no change, **provided §3.4 is right**. Their correctness is now a
  function of the importer's sign handling, which is why that gets its own test.

### 6.3 Attribution

Manual figures reach `humanize()` through the same bundle, so they are permitted automatically.
The constraint from STATE.md still binds: any **new** signed field must expose its speakable
form. Manual liabilities stored positive (§2) satisfies this by construction — which is the reason
to store them that way, not merely consistency with Plaid.

### 6.4 `insight_log`

Still has no writer; that stays a Phase 3 item. When it gets one, note that a `documentId` is a
safe reference but `original_filename` is not — real filenames read
`chase_statement_4412_aug2026.pdf` and carry an account number. Add the filename to the redaction
rules at the same time as the writer, and leave a comment in `redactParams()` now saying so.

### 6.5 Network trace

New traced spans: the upload, the parse, the PDF extraction (count = pages), the Anthropic
transcription call (by model name), and the commit. The manual-ledger read is a `db` span like the
`plaid_items` read already is. Names, counts, durations, outcomes — never a filename, never a page
of text, never a figure.

---

## 7. UI

| Route | Purpose |
|---|---|
| `/sources` | Every source in one place: Plaid items with status, manual accounts, documents. Replaces the bare "connect a bank" affordance. Disconnect and delete live here. |
| `/import` | Upload, plus every document with status and a link to its review. |
| `/import/[documentId]` | The review screen (§5.1). |
| `/accounts/new` | Typed entry — name, type, subtype, balance, as-of date. The always-works path, and the fallback when a parse fails. |
| `/accounts/[accountId]` | Gains manual balance history, the source of each figure, and edit affordances for manual accounts. |

Every account, everywhere it appears, shows its source. A user must never have to guess whether a
number came from their bank or from a statement they uploaded in August.

`Nav.tsx` gains `/sources` and `/import`. Follow the existing route conventions and the Phase 1.5
evidence-rendering decisions (explicit `CAVEAT`/`GAP` tags, not colour alone).

**Reminder, since this phase is UI-heavy:** client components may take **type-only** imports from
`@pfg/core`. There are comments at both ends in `NetworkPanel.tsx` and `trace.ts` explaining what
breaks and why the error message is misleading.

---

## 8. Build order

Each step ends somewhere the suite is green and `npm run build` passes. Do not run ahead into the
UI with the merge untested.

1. **Source abstraction, Plaid only.** `SourceKind`, the snapshot fields, `mergeSources`,
   `fetchSnapshot` → `SourceResult`, all call sites, staleness helper. **The full suite must still
   pass and `agent:smoke` must still answer clean against the sandbox.** This step adds no
   features and is the one most likely to break something quietly — finish it first, alone.
2. **Schema + migration.** Tables, no readers or writers yet. Verify in `psql` that the columns
   are as intended, the way §0.4's invariant was checked in the database rather than asserted.
3. **`DocumentStore` + `encryptBytes`.** Gitignore `.documents/` in the same commit. Round-trip
   test, and a test that a key outside the user's prefix throws.
4. **Manual ledger read + typed entry.** `read.ts`, `/accounts/new`, the `core` write tools. **This
   is the first point where the whole thesis is testable**: create an account by hand, see it in
   net worth, with a Plaid item and without one. Do this before any parsing exists.
5. **CSV: parse → draft → review → commit.** Including the sign convention and its tests.
6. **PDF: extract → transcribe → guard → the same review and commit.**
7. **`/sources`, `/import`, account detail, nav, network trace spans.**
8. **Checkpoint 2 run** (§9).

Step 4 before step 5 is deliberate. It makes the merge, the ledger, the snapshot read, and the UI
all real with no parser in the way, so when a CSV first produces a wrong figure there is only one
new thing it can be.

---

## 9. Checkpoint 2 acceptance

Perform it, then write what happened into STATE.md — including anything that did not work.

1. **Disconnect every Plaid item.** A manual-only user is the primary case, not a degraded one.
2. Upload a **real CSV export**. Confirm the column mapping and the sign convention. Commit.
3. Upload a **real PDF statement**. Review the transcribed figures against the document. Commit.
4. **Dashboard, `/history`, `/accounts`, `/accounts/[id]`, `/goals` all correct**, every figure
   naming its document in its "why" card.
5. **Chat answers correct** across all six workflows, attribution clean, staleness stated where a
   balance is old.
6. **Re-upload the same statement** → recognised as a duplicate, nothing double-counted.
7. **Feed the extractor a document it will get wrong** (or stub a hallucinated claim) → caught by
   `checkTranscription()`, dropped, shown.
8. **Reconnect Plaid** → merged snapshot correct, both sources visible, staleness stated, ids not
   colliding.
9. **Delete a document** → both the keep-ledger and drop-ledger paths behave as §3 says.
10. **`npm test`, `npm run typecheck`, `npm run build`** all clean. **No Plaid balance, holding, or
    transaction anywhere in Postgres** — check it in `psql`, do not assert it.

**Before step 2**, settle the §9 developer action item. Step 2 is the moment the author's real
financial documents enter local storage, and that is a better time to have thought about the
employer policy than afterwards.
