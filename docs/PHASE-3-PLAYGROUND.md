# Phase 3 — The Playground: buildable spec

The *what and why* is [CLAUDE.md](../CLAUDE.md) §8 Phase 3. This file is the *how*: the stages,
the knobs, the API, the core refactors, the traps, and the build order. It assumes Phase 2 is done
— the ingestion lane (§7) has nothing to show until `packages/ingest` exists.

**The one-sentence goal:** a developer can watch one question travel the whole system — snapshot,
router, workflow, evidence, synthesis, guard — and can also lift any single stage out, feed it
their own input, change what is currently hard-coded about it, and run it alone.

**The one-sentence design:** a separate area of `apps/web` at `/playground`, off by default,
driving the *same* `core` functions production uses through a thin set of `/api/playground/*`
routes. Overrides are passed in per run and never reach the production code path.

> **Why this is the crown jewel.** The product's thesis is that every figure is traceable. The
> app shows the trace *for the user's question*. The playground shows the trace *for the system
> itself*: what each stage received, what it did, what it handed on, and what it would have done
> with different instructions. It is also the instrument Phase 3's AI work (§9) is done with —
> tuning a prompt is not something to do by editing a constant and restarting the dev server.

---

## 0. Read this first: what must not break

| Invariant | Where it lives | How the playground threatens it |
|---|---|---|
| The AI never computes a number (§0.1) | `checkAttribution()` | The playground lets people rewrite Jolly's prompt — including into one that asks for arithmetic. **The guard cannot be switched off.** Its verdict is always computed and shown. A prompt that defeats the guard is a finding to fix in the guard, not a setting. |
| Nothing from Plaid at rest (§0.4) | request-scoped snapshot | A playground session wants the same snapshot across several stage runs. It is tempting to cache it server-side or in `localStorage`. Neither. See §3. |
| Derived aggregates are real (§3 Tier 1) | `appendNetWorthSnapshot()` in `summary_overview` | Running `summary_overview` on a fixture or hand-edited snapshot would write a fake point into the user's real net worth history. **Playground runs never write.** See §4.3. |
| No API commits a draft (§0.8, §10) | `/import/[documentId]` review | An ingestion lane with a "commit" button would be exactly that API. The lane stops at the draft. See §7. |
| Client components take type-only imports from `@pfg/core` | `NetworkPanel.tsx`, `trace.ts` | The playground is the most interactive UI in the repo and will want `humanize()`, `resolvePeriod()`, the guard, client-side. Every one of those goes through an API route. |
| Every query scoped by `ctx.userId` | `core` convention | A client-supplied snapshot carries a `userId` field. The server overwrites it with the signed-in user's id; it never trusts it. |
| Prompts are code, reviewed in git | `prompt.ts`, `router.ts` | A runtime prompt store would let production behaviour change with no diff. **There is no such store.** An experiment is promoted by turning it into a commit (§5.4). |

---

## 1. Where it lives, and who can reach it

**Route:** `/playground` in `apps/web`, with its own layout (no product nav, a dense
developer-tool look) and its own API namespace `/api/playground/*`. It is a separate *area* of
the same app, not a separate app: it needs the same Clerk session, the same database, the same
server-side Plaid client and the same `core`, and a second Next.js app would duplicate all four.

**Gate:** `PLAYGROUND_ENABLED=true` in the environment. When unset:
- the page returns `notFound()`,
- **every** `/api/playground/*` handler returns 404 *before* doing any work — checked in a shared
  `requirePlayground()` helper, not only in the page, because the API is the thing that spends
  money and reads data,
- the product nav shows no link to it.

Default: on in local `.env.example`, **off in production** (Phase 4 must not flip it without a
decision recorded in STATE.md).

**Whose data:** the signed-in user's, and only theirs. There is no "view as another user", no
admin mode. A playground is a developer looking at *their own* sandbox or real data; it is not a
support console.

---

## 2. The lifecycle, as stages

A chat turn today is one opaque call to `runAgentTurn()`. The playground splits it into the stages
it already has internally, each with a typed input and output, so any stage can run alone or as
part of the chain.

```
  ┌──────────┐  ┌────────┐  ┌────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────┐  ┌────────┐
  │ Snapshot │─▶│ Router │─▶│ Params │─▶│ Workflow │─▶│ Evidence │─▶│ Synthesis │─▶│ Guard │─▶│ Answer │
  └──────────┘  └────────┘  └────────┘  └──────────┘  └──────────┘  └───────────┘  └───────┘  └────────┘
   Plaid /        Haiku       resolve-    fixed tool    humanize()    Sonnet          check-      outcome:
   fixture /      + schema    Period()    sequence,     + allowed-    + system         Attri-     clean /
   edited                     + now       step by step  Figures()     prompt           bution()   retried /
                                                                                                   withheld
```

| Stage | Input | Output | Network | Exists today as |
|---|---|---|---|---|
| **Snapshot** | source mode + fetch options | `SessionSnapshot`, gaps, window | Plaid (live mode) | `fetchSnapshot()`; Phase 2's `mergeSources()` |
| **Router** | question, history, router config | `RouterDecision`, raw model text, `routedBy` | Anthropic | `route()` in `apps/web/src/server/agent.ts` |
| **Params** | decision, `now` | `WorkflowParams` with explicit `{from,to}` | none | `toWorkflowParams()`, `resolvePeriod()` |
| **Workflow** | workflow name, params, snapshot | ordered steps, `EvidenceBundle`, limitations | Postgres reads only | `runWorkflow()` |
| **Evidence** | bundle, limitations | humanized bundle, allowed-figure set, the exact payload text | none | `humanize()`, `allowedFigures()`, `evidencePayload()` |
| **Synthesis** | question, bundle, limitations, history, synthesis config | every draft, in order | Anthropic | `synthesise()` in `agent.ts` |
| **Guard** | draft text, bundle | `AttributionReport` | none | `checkAttribution()` |
| **Answer** | the above | answer, outcome, trace | none | `runAgentTurn()`'s return |

**Two ways to drive it, both required:**
- **Run all** — one question, every stage in order, every intermediate kept and inspectable. This
  is the lifecycle view, and with the default config it must produce the same workflow and the
  same evidence bundle as `/api/chat` for the same question and snapshot (§10 checkpoint item 2).
- **Run this stage** — any stage, with its input either carried from the previous stage's last
  output or **edited by hand**. Editing a stage's input marks everything downstream of it stale
  (greyed, with "re-run from here") rather than silently keeping outputs that no longer follow
  from their inputs.

The Router and Workflow stages also accept **overrides that bypass the stage before them**: pick
any of the six workflows directly instead of routing; type explicit dates instead of resolving a
relative period.

---

## 3. Snapshots in the playground

### 3.1 Three modes

| Mode | What it is | Labelled as |
|---|---|---|
| **Live** | `fetchSnapshot()` (and from Phase 2, the manual source) for the signed-in user, fetched by the server in *this* request | real data |
| **Fixture** | `typicalSnapshot()` from `packages/core/src/testing/fixtures.ts`, or another named fixture | synthetic |
| **Edited** | any snapshot the browser sends back — a fixture or a live one the developer changed in the JSON editor | synthetic |

### 3.2 The trust rule

> **The server only trusts a snapshot it fetched in the same request.**

A live snapshot shown in the browser and then posted back for the next stage is, from the
server's point of view, client-supplied data. It might have been edited. So:

- Live mode **refetches** on every stage run that needs a snapshot — the same refetch-per-turn
  rule §7 already applies to chat, with the same trace entries showing the cost.
- Anything posted from the client is **edited**, full stop, even if unchanged. The server
  overwrites its `userId` with the signed-in user's, marks it synthetic, and every provenance
  record computed over it carries a note saying so.

This keeps the one property that matters — a figure labelled as real was computed from data the
server fetched — without needing to detect edits.

**Implementation:** extend `SourceKind` (Phase 2: `'plaid' | 'manual'`) with `'synthetic'`. A
synthetic snapshot is one whose `sources` includes it. `humanize()` and the "why" card both show
it. `appendNetWorthSnapshot()` **throws** if handed a figure computed over a synthetic snapshot —
belt and braces with §4.3.

### 3.3 Where it is held

In React state, for the life of the tab. **Never** `localStorage`, `sessionStorage`, IndexedDB,
the URL, or a server-side cache. Closing the tab is the "request end: discard" step. This is not
a new exposure — the dashboard already sends the same figures to the same browser — but persisting
it in the browser would be a durable copy of Plaid data, which §0.4 forbids regardless of where
the disk is.

Experiment *configs* (prompts, models, knobs) are not financial data and may be saved — see §5.4.

---

## 4. Core refactors the playground needs

None of these change production behaviour. Each one turns something hard-coded into something
passed in, with today's value as the default, so that production and playground run the same code
with different arguments.

### 4.1 `AgentConfig` — the knobs, in one place

New `packages/core/src/agent/config.ts`:

```ts
export interface RouterConfig {
  systemPrompt: string;      // default ROUTER_SYSTEM_PROMPT
  model: string;             // default 'claude-haiku-4-5'
  maxTokens: number;         // default 256
  historyTurns: number;      // default 4
}

export interface SynthesisConfig {
  systemPrompt: string;      // default JOLLY_SYSTEM_PROMPT
  model: string;             // default 'claude-sonnet-5'
  maxTokens: number;         // default 4096
  historyTurns: number;      // default 6
  retryTurnTemplate: string; // default: what attributionRetryTurn() writes, with a {figures} slot
  maxRetries: 0 | 1 | 2;     // default 1 — production is pinned to 1
}

export interface AgentConfig { router: RouterConfig; synthesis: SynthesisConfig; }
export const DEFAULT_AGENT_CONFIG: AgentConfig;
```

`route()` and `synthesise()` in `apps/web/src/server/agent.ts` take a config argument instead of
reading module constants. `runAgentTurn()` passes `DEFAULT_AGENT_CONFIG` and **does not accept a
config from its caller**. `/api/chat`'s zod body schema stays as it is, so a `config` field in a
chat request is stripped, not honoured. A test pins both facts (§10 item 8).

Model choice is a **closed list** (`ALLOWED_MODELS` in the same file), not free text: an
unrecognised model id is a 400 before any call is made.

### 4.2 The tool catalog — one definition, three consumers

Today the atomic tools' parameter schemas live in `apps/mcp/src/server.ts`, as zod, next to each
`registerTool` call. The playground's notebook needs the same names, descriptions and schemas.
Writing them a second time would break §0.5.

Move them to `packages/core/src/tools/catalog.ts`:

```ts
export interface CatalogEntry<P> {
  name: string;                         // 'netWorth'
  kind: 'aggregation' | 'compute' | 'context-read' | 'context-write';
  description: string;                  // what the MCP server shows today
  params: z.ZodType<P>;                 // single source of truth
  needs: { snapshot: boolean; db: boolean };
  run(ctx: Ctx, params: P): Promise<ToolResult<unknown>>;
}
export const TOOL_CATALOG: readonly CatalogEntry<any>[];
```

`apps/mcp` registers from the catalog; the playground lists and runs from it, rendering a form
from each schema's JSON Schema (`z.toJSONSchema`). A test asserts the MCP tool list and the
catalog match by name. This adds `zod` as a `core` dependency — acceptable, and it is already the
version both apps use.

`appendNetWorthSnapshot` and `getNetWorthHistory` are **not** in the catalog as runnable tools in
the playground: the first is a side effect of a workflow, not a question, and the second is already
shown on `/history`.

### 4.3 Workflows: step capture and dry run

Two additions to the workflow contract, both optional so existing callers are untouched:

- **Step capture.** `EvidenceBuilder.add()` records `startedAt` and `durationMs` per entry, and
  the playground route returns the builder's entries in order as `steps`. The bundle already
  carries `params`, `data`, `provenance` and `provenance.inputs` per step — that *is* "how data
  is passed along each tool", it has just never been drawn.
- **Dry run.** `ctx.persist?: boolean`, default `true`. When `false`, `summary_overview` skips
  `appendNetWorthSnapshot()` and records a limitation saying it did so. Every playground route
  sets it `false`, unconditionally. A workflow that gains a write later must honour the same flag,
  and the test for it is written now.

### 4.4 Everything else that is hard-coded

What the playground exposes, and how. "Editable" means per-run, playground-only. "Shown" means
displayed read-only with a pointer to where it lives in code.

| Knob | Today | Playground |
|---|---|---|
| Router system prompt | `ROUTER_SYSTEM_PROMPT` | editable, with diff against default |
| Router model, max tokens, history window | `agent.ts` constants | editable (closed model list) |
| Router schema (the six-workflow enum, the period enum) | `ROUTER_SCHEMA` | **shown.** Editing the enum would let the router name pipelines that do not exist |
| Fallback decision on routing failure | `FALLBACK_DECISION` | shown; a "simulate routing failure" toggle exercises it |
| `now` for period resolution | `new Date()` | editable — this is how the 31st-of-the-month bug would have been found |
| Snapshot transaction window | 90 days | editable (Plaid live mode only) |
| Include holdings / transactions | both on | editable |
| FIRE `multiple`, `withdrawalRate`, spend override | 25 / none / profile | editable as workflow params |
| Workflow pipelines | `workflows/*.ts` | **shown.** A pipeline is code; to try a different sequence, run tools individually in the notebook |
| Jolly system prompt | `JOLLY_SYSTEM_PROMPT` | editable, with diff against default |
| Evidence payload format | `evidencePayload()`, `synthesisUserTurn()` | **shown exactly as sent**; not editable in v1 — it is the constraint on the model, not a request to it |
| Synthesis model, max tokens, history window | `agent.ts` constants | editable |
| Retry message | `attributionRetryTurn()` | editable template |
| Number of retries | 1 | editable 0–2 in the playground only |
| Guard rules (currency/percent patterns, rounding tolerance) | `attribution.ts` | shown; the guard bench (§6) has what-if toggles that are labelled as such and never alter a lifecycle run |
| Investable account types, housing-debt subtypes, transfer categories | `snapshot.ts`, `period.ts` | shown, in the notebook beside the tools that use them |
| Transcription prompt, model, pages sent | Phase 2 `pdf/transcribe.ts` | editable |
| CSV sign convention, date format | Phase 2 detector | editable override on the parse stage |

---

## 5. The UI

### 5.1 Layout

```
┌ Playground ─────────────────────────── snapshot: (•) live ( ) fixture ( ) edited ─ config: 2 changes ▾ ┐
│ [ Lifecycle ]  [ Notebook ]  [ Ingestion ]  [ Guard bench ]  [ Routing suite ]                        │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Question: [ how much did I spend on food last month?                              ]  [ Run all ]      │
│                                                                                                        │
│  ● Snapshot ── ● Router ── ● Params ── ● Workflow ── ● Evidence ── ● Synthesis ── ● Guard ── ● Answer │
│    2.9s          0.6s        0ms         4ms           0ms           6.1s           1ms                │
├──────────────────┬─────────────────────────────────────────────────────────────────────────────────────┤
│ Router           │  Input    Config*   Output    Raw    Trace                     [ Run this stage ]  │
│ ─ question       │  ┌───────────────────────────────────────────────────────────────────────────────┐ │
│ ─ history (0)    │  │ { "workflow": "spending_analysis", "period": "last_month",                    │ │
│                  │  │   "reasoning": "asks about spend in a named period" }                         │ │
│                  │  └───────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────┴─────────────────────────────────────────────────────────────────────────────────────┘
```

Every stage panel has the same five tabs, always in the same place: **Input** (editable),
**Config** (the knobs for that stage, starred when changed), **Output**, **Raw** (exactly what
was sent to and received from an external service, minus credentials), and **Trace** (the
`NetworkTrace` entries that stage caused, from the existing `TraceRecorder`).

### 5.2 The five views

1. **Lifecycle** — §2 above. The default view.
2. **Notebook** — every `TOOL_CATALOG` entry as a documentation cell: its description, its
   parameter form, the snapshot it runs on, and a Run button. Output shows `data`, `provenance`,
   and the `humanize()`d form side by side, because the gap between the raw cents and what Jolly
   is allowed to say is the most instructive thing in the system. Cells stack in run order like a
   notebook; a cell can take another cell's output as a param (an `accountIds` list from a
   `listAccounts` cell). `context-write` tools are runnable but carry a "writes to your profile"
   tag and an in-page confirm step. They are real writes to the developer's own profile, and
   pretending otherwise would make the notebook lie.
3. **Ingestion** — §7.
4. **Guard bench** — §6.
5. **Routing suite** — a table of questions with expected workflows, loaded from
   `fixtures/playground/router-cases.json` (checked in, no financial data). Run it against the
   current router config and see a pass/fail table plus a confusion grid of expected against
   actual workflow. This is how "harden the router" (§9) gets a number instead of an impression.
   It costs one Haiku call per case. The trace shows the total before and after, and the run asks
   for in-page confirmation over 25 cases.

### 5.3 Showing what production hides

The playground deliberately shows three things the product never does:
- **Rejected drafts.** Production discards a draft that fails the guard. The playground shows it,
  labelled *rejected draft — never shown to a user*, with the offending figures highlighted.
- **The assembled prompt.** The exact `messages` array sent to each model call, system prompt
  included.
- **Token usage.** `usage.input_tokens` / `output_tokens` from each Anthropic response, added to
  the trace entry's detail. Counts only; still never payloads in the trace itself (§8 Phase 1.5).

### 5.4 Experiments: saving and promoting

A config with changes is an **experiment**. It can be:
- **autosaved** to `localStorage` under a playground key. Prompts and knobs only, never a
  snapshot, bundle, draft or answer (§3.3),
- **exported / imported** as a JSON file. The page shows the JSON as selectable text with a copy
  button, because artifact-style download links are not something to rely on,
- **promoted** by copying a generated patch: the diff between the experiment and
  `DEFAULT_AGENT_CONFIG`, written against `prompt.ts` / `router.ts` / `config.ts`. The only route
  into production is a reviewed commit. There is no "apply to production" button and there will
  not be one.

---

## 6. The guard bench

No model calls, no network, instant. Two inputs: a **bundle** (from the current lifecycle run, a
fixture, or pasted JSON) and **prose** (typed, or taken from any draft). Output: the full
`AttributionReport` — every figure found, matched or not, and what it matched against — with the
allowed set listed alongside.

What-if toggles (rounding tolerance on/off, percent matching on/off) exist **only here**, are
labelled *experimental — production guard unchanged*, and exist so someone can see why a rule is
there by turning it off and watching a bad sentence get through. They are never readable by
`checkAttribution()` as called from the lifecycle or from `/api/chat`.

---

## 7. The ingestion lane (needs Phase 2)

The same stage model, applied to the import pipeline in CLAUDE.md §7b:

```
 file ─▶ Sniff + hash ─▶ Extract / Read ─▶ Detect ─▶ Transcribe ─▶ checkTranscription ─▶ Draft ─▶ Preview as snapshot ─▶ (lifecycle)
         mime from bytes   PDF: text layer   CSV: columns,   PDF only:     every string must    rows the     merge the draft into a
         sha256, dup?      CSV: rows         sign, dates     model emits   occur in the text,   review       SYNTHETIC snapshot and
                                                             verbatim      or it is dropped     screen       hand it to any workflow
                                                             strings                                         or the full lifecycle
```

**What it shows** at each stage: the detected mime and why; the hash and whether it matches an
existing document; for a PDF the page count and the extracted text; for a CSV the inferred column
roles and the plain-language sample sentence ("$4.85 spent at Starbucks on 3 April"); the
transcription prompt, the model's raw output, and `checkTranscription()`'s verdict per string;
the draft rows with their `dollarsToCents` conversions shown beside the source strings.

**"How Jolly reads it"** is the last step: the draft is merged, as a synthetic source, into either
a fixture or the live snapshot, and then any workflow or the whole lifecycle runs over it. That
shows the full path a statement figure takes to a sentence, with provenance naming the document
and the evidence card marking it synthetic.

**Inputs:** sample documents checked into `fixtures/playground/documents/`, which are fictional
statements in both sign conventions plus one scanned (image-only) PDF to show the rejection path;
a file the developer drops in; or one of their already-uploaded documents, read from the
`DocumentStore`.

**What it never does:**
- **Commit.** There is no commit stage and no route that reaches `commit.ts`. To put a draft in
  the ledger, use `/import/[documentId]`. That is §0.8's mandatory human review, and the
  playground is not an alternative path around it.
- **Persist a dropped-in file.** A file dropped into the lane is processed in memory for that
  request and discarded. It is not written to the `DocumentStore` and gets no `documents` row.
- **Log or trace extracted text.** It is returned in the response to the user who supplied it,
  shown, and gone. The trace says "PDF, 3 pages, extracted in 41 ms", as §9 requires.
- **Hallucination stub.** A toggle on the transcribe stage swaps the model's output for one with a
  planted figure that is not in the text, so `checkTranscription()` dropping it can be watched on
  demand rather than waited for.

**Phase 2 seam this depends on:** each ingest stage must be callable on its own, on bytes in
memory, with no persistence. `upload.ts` as sketched in the Phase 2 spec does sniff, hash, dedupe
*and* persist in one call. Split it so sniff/hash/dedupe-check are pure and persistence is a
separate step. That is a small change during Phase 2 and an awkward one afterwards.
PHASE-2-INGESTION.md §3 carries a note to this effect.

---

## 8. API

All under `/api/playground/`, all `runtime = 'nodejs'`, all gated by `requirePlayground()` then
`requireUser()`, all returning `{ ..., trace }` and serialised with `toJson` (bigint cents).
Request bodies validated with zod; snapshot-bearing bodies accept
`{ mode: 'live', options } | { mode: 'fixture', name } | { mode: 'edited', snapshot }`.

| Route | Does | Calls out to |
|---|---|---|
| `POST snapshot` | build a snapshot in the given mode | Plaid (live) |
| `POST route` | router alone with `RouterConfig` | Anthropic |
| `POST params` | `toWorkflowParams` with an explicit `now` | — |
| `POST workflow` | one workflow, dry run, with `steps` | Plaid (live), Postgres reads |
| `GET tools` | the catalog: names, kinds, descriptions, JSON Schemas | — |
| `POST tools/[name]` | one catalog entry; `context-write` requires `confirm: true` | Plaid (live), Postgres |
| `POST evidence` | humanized bundle, allowed set, the exact payload text | — |
| `POST synthesize` | synthesis with `SynthesisConfig`; every draft, every guard report | Anthropic |
| `POST guard` | guard bench | — |
| `POST run` | the full lifecycle, every intermediate returned | Plaid, Anthropic |
| `POST router-suite` | the routing suite against a `RouterConfig` | Anthropic × n |
| `POST ingest/inspect` | sniff, hash, dedupe check, extract or read, detect | — |
| `POST ingest/transcribe` | transcription with config, plus the guard verdict | Anthropic |
| `POST ingest/preview` | draft → synthetic source → merged snapshot | Plaid (live base) |

**Cost guard:** a per-user, in-memory budget of model calls per minute
(`PLAYGROUND_MODEL_CALLS_PER_MIN`, default 30). Exceeding it is a 429 with a plain message. In
memory means per server instance, which is enough for a dev tool and adds nothing at rest.

---

## 9. The rest of Phase 3: the AI work, done with the playground

The AI-sophistication scope that has always been Phase 3 stays in Phase 3. The playground is the
instrument for it, and each item is done *through* it:

- **Formalised identity / system prompt.** Iterate on `JOLLY_SYSTEM_PROMPT` as an experiment
  against the author's real data (Phase 2), compare answers side by side, promote by commit.
- **Hardened router.** The routing suite gives it a measured pass rate. Grow the case file from
  real questions that routed badly.
- **`insight_log` writer.** Production chat turns write their reasoning trace. Playground runs do
  **not**: they are experiments, and an audit log mixed with them is an audit log of nothing. The
  playground gets a read-only view of the user's own recent `insight_log` rows, which is also the
  first reader that table has ever had.
- **`riskTolerance` used**, with its UI input added at the same time (STATE.md known gaps). The
  playground shows its effect by running `investment_review` at each tolerance.
- **Proactive insights, model routing and cost controls.** Token usage per stage (§5.3) is the
  measurement this needs.
- **SnapTrade adapter** behind Phase 2's source interface. It is a source rather than AI work, and
  could equally move to its own phase. That is the owner's call, and it is not a prerequisite for
  Checkpoint 3.

---

## 10. Build order

1. **`requirePlayground()`, the empty `/playground` layout, the gate tests.** Prove the 404s
   first, before there is anything behind them worth protecting.
2. **`AgentConfig` refactor** (§4.1). `runAgentTurn()` behaviour unchanged; `npm test` and
   `npm run agent:smoke` green; the test that `/api/chat` ignores `config` written now.
3. **Tool catalog** (§4.2). Move the MCP schemas, register MCP from it, assert names match. MCP
   driven by Claude Code still works: run Checkpoint 0 part 2 again.
4. **Step capture + dry run** (§4.3), with the test that a playground workflow run writes no
   `networth_snapshots` row.
5. **Synthetic source + trust rule** (§3), including `appendNetWorthSnapshot()` refusing it.
6. **Lifecycle view, Run all**, then per-stage runs, then input editing with downstream staleness.
7. **Notebook.**
8. **Guard bench**, then **routing suite**.
9. **Ingestion lane**, against the fixture documents first, then a real one.
10. **Experiments**: autosave, export/import, promote-as-patch.
11. **The §9 AI items**, each through the playground.
12. **Checkpoint 3 run** (§11).

---

## 11. Checkpoint 3 acceptance

Perform it, then write what happened into STATE.md, including anything that did not work.

1. **Gate.** With `PLAYGROUND_ENABLED` unset, `/playground` and every `/api/playground/*` route
   return 404. Check with `curl` against each route, not by reading the code.
2. **Equivalence.** For the same question and the same snapshot, a default-config **Run all**
   produces the same workflow and a deep-equal evidence bundle to `/api/chat`. Automated on a
   fixture snapshot; done once by hand on the live sandbox.
3. **Every stage alone.** Router alone shows an Anthropic entry and **no** Plaid entry in its
   trace. Workflow on a fixture shows **no** network at all. The guard bench shows no network at
   all. Params with `now` set to 31 August 2026 resolves `last_6_months` to start on 28 February
   2026, not 3 March.
4. **Every tool.** Every catalog entry runs from the notebook. The MCP server's tool list is
   derived from the same catalog; the test passes.
5. **Experiments change behaviour, guards do not move.** Editing the router prompt changes at
   least one routing-suite result. Editing Jolly's prompt to *instruct* arithmetic produces a
   rejected draft, visible and highlighted, and a `withheld` outcome. The guard cannot be prompted
   away.
6. **Ingestion, end to end.** The fixture CSV in each sign convention and the fixture PDF each go
   through every lane stage visibly. The scanned PDF is rejected with its reason. The
   hallucination stub's planted figure is dropped by `checkTranscription()`. Preview-as-snapshot
   runs a workflow whose evidence names the document and is marked synthetic.
7. **Nothing at rest.** After the run: no new `networth_snapshots` row from any playground run,
   no `documents` or `manual_*` row and no `DocumentStore` file from the lane, and no snapshot,
   bundle or draft in the browser's storage. Check `psql`, the store directory and devtools; do
   not assert it.
8. **Production untouched.** `/api/chat` with a `config` field in its body behaves exactly as
   without one, and a test pins it. `insight_log` has no rows from playground runs.
9. **`npm test`, `npm run typecheck`, `npm run build`** all clean.

---

## 12. Non-goals

- **A production feature.** End users never see the playground.
- **A runtime configuration store.** Prompts and models change only by commit.
- **Editing workflow pipelines** at runtime. Run tools individually instead.
- **Disabling a guard** in a lifecycle run, by any setting.
- **Committing a draft**, or persisting a dropped-in file, from the ingestion lane.
- **Multi-user or admin views.** Your own data only.
- **Saving runs.** A run's outputs are financial; they live in the tab and die with it.
