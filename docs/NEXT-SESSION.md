# Kickoff prompt for the next session

Paste the block below into a fresh Claude Code session in this repo.

Keep it current. This file has gone stale three times now — it described Phase 1 after Phase 1
was built, then Checkpoint 1 after Phase 1.5 was built, then the old AI-sophistication Phase 2
after the timeline was re-planned. Rewrite it when the work it describes is done rather than
leaving a confidently wrong prompt in place. It is only ever harmless because its first
instruction is "read STATE.md."

---

```
Start Phase 2 of this build — Real Data Without Plaid: document ingestion (CLAUDE.md §8 Phase 2).

READ FIRST, BEFORE ANY CODE:
1. docs/STATE.md — where things stand, what is deliberately NOT built, known gaps, and
   decisions already made with their reasoning. Several things that look like oversights are
   recorded there as decisions; do not "fix" them without reading why.
2. docs/PHASE-2-INGESTION.md — the buildable spec for this phase: types, tables, build order,
   and the traps. This is the document to work from.
3. CLAUDE.md — the spec. §0.4, §0.8, §3, §7b and §8 Phase 2 are the ones that changed.

Then verify the environment rather than assuming it, and tell me if anything is off before
building on it:
  npm run db:up && npm run db:migrate
  npm test          # expect 176 passing
  npm run typecheck
  npm run build
  npm run link:sandbox -- --show   # prints the sandbox user UUID; links nothing

Environment notes specific to this machine:
- Docker Desktop is frequently not running. 7 tests in packages/core/src/tools/users.test.ts
  need Postgres on :5433; ECONNREFUSED there means Docker is down, not a regression. The
  skipIf guard does not catch it because DATABASE_URL is set even when nothing is listening.
- Run npm scripts through PowerShell. Vitest's thread pool misbehaves under Git Bash on this
  machine and collects 0 tests across all files.
- The system clock drifts and W32Time is not reliably set to Automatic. If Clerk sign-in loops,
  it is the clock, not the keys — STATE.md has the elevated fix. proxy.ts now tolerates 30s of
  skew so this should degrade rather than loop.

WHY THIS PHASE, SINCE THE ORDER CHANGED:
Deployment moved out of Checkpoint 1 to Phase 4, and document ingestion took the Phase 2 slot
ahead of the AI-sophistication work. The reason is in CLAUDE.md §8 Phase 2: every judgement
about whether Jolly's guidance is any good has so far been made against First Platypus Bank's
invented numbers. A nicer deployment of fiction is not a product, and §10 blocks live
institutions until the security and employer checks clear — so the user's own documents are the
only available route to real data. Do not silently reorder this back.

STATE OF THE BUILD — do not rebuild any of this:
Phase 0, Phase 1, and Phase 1.5 are complete. Clerk auth, Plaid Link, the agent loop (Haiku
router → fixed workflow → Sonnet synthesis → attribution guard), all six §5 workflows, the
§4 compute layer, the dashboard, chat, evidence cards, the network trace, and the routes
/history, /accounts, /accounts/[id], /goals all exist and are tested.

NOT DONE, and deliberately out of this phase's scope unless I say otherwise:
- Not deployed. No Neon project, no Vercel project. That is Phase 4 now. Flag anything in this
  phase that genuinely needs a deploy first — I expect nothing does, but the DocumentStore has
  a named Phase 4 prerequisite (Vercel's filesystem does not persist) and I want that written
  down rather than discovered.
- insight_log still has no writer. Phase 3.
- riskTolerance and annualIncomeCents still drive nothing, and there is deliberately no UI to
  set either. That is a recorded decision in STATE.md. Do not add the inputs.
- The Phase 3 developer playground (docs/PHASE-3-PLAYGROUND.md). Do not build it now. But do
  respect its two Phase 2 seams, noted in PHASE-2-INGESTION.md §3: ingest stages callable alone
  on in-memory bytes with persistence split out, and the transcription prompt/model passed in
  as parameters with defaults.

THE SHAPE OF PHASE 2, in one paragraph:
The session snapshot stops being "the result of a Plaid fetch" and becomes "the merge of every
source." Plaid is one source, fetched live and never stored. The manual ledger — built from
CSV exports, PDF statements, and typed entry — is another source, and it IS stored, because
nothing else holds it. §4's compute functions and §5's workflows read the merged snapshot and
do not care which source a row came from, except to report it in provenance.

THE THREE THINGS MOST LIKELY TO GO WRONG, all detailed in PHASE-2-INGESTION.md:
1. The transaction sign convention. Plaid uses positive = money OUT; most bank CSVs use the
   opposite. Getting it backwards inverts savings rate and swaps income with spending with NO
   error raised — every figure stays plausible. §3.4 of the spec is a numbered list for this
   reason. Test both directions.
2. Cross-source staleness. A manual balance dated 31 August merged with a Plaid balance fetched
   this morning is a net worth accurate as of no single moment. §4 requires it be stated in
   provenance notes. Test with a fixture mixing fresh and stale, and assert the DATE in the
   note, not just that a note exists.
3. The transaction window on merge is the INTERSECTION of the sources' windows, not the union.
   A union would let cashFlow describe a period one source cannot speak to as if fully covered.

NON-NEGOTIABLE CONSTRAINTS — flag it if something forces a tradeoff rather than working
around it quietly:
- The AI never computes a number. Tools compute; the model narrates and attributes.
  checkAttribution() enforces this. A figure it rejects is a bug to investigate, never a
  check to loosen.
- NEW in §0.8: extraction is transcription, not computation. The PDF extractor may emit only
  the VERBATIM STRING it read, never a number and never cents. A deterministic function
  converts the string. checkTranscription() verifies the string occurs in the document's own
  extracted text, and a violated field is DROPPED, not warned about. A human confirms every
  draft before commit — no unattended import path, not even for scripts or admin.
- Any NEW compute field holding a signed figure must also expose the form a person would
  actually speak, or the guard will reject correct prose. Manual liabilities are therefore
  stored as the POSITIVE amount owed, matching Plaid. This bit once already — see
  "sign-aware matching" in STATE.md.
- Money is integer cents as bigint. dollarsToCents is the only function allowed to touch a
  float, and it belongs on the server — never parse an amount into a number in the browser.
  This now applies to CSV cells and PDF strings too.
- No raw PLAID financial data at rest, ever. The manual ledger is a deliberate exception with
  its own reasoning (§0.4) — it is not a precedent for mirroring Plaid's data, and if you find
  yourself reasoning from one to the other, stop and flag it.
- Uploaded bytes: encrypted at rest under a key SEPARATE from TOKEN_ENCRYPTION_KEY, gitignored
  directory created in the same commit as the store, storage keys server-generated and never
  derived from an uploaded filename, mime type sniffed from content not extension. Never in a
  log line, a network trace entry, insight_log, or a client bundle.
- Every DB query is scoped by ctx.userId, enforced in the core package. Six new tables.
- Educational coach, not advisor.
- Client components may take TYPE-ONLY imports from @pfg/core. A runtime import is followed
  into the browser bundle and drags in @pfg/db → postgres → node:net, failing the build with
  "Module not found: Can't resolve 'net'". This phase is UI-heavy, so expect to meet it; there
  are comments at both ends in NetworkPanel.tsx and trace.ts.

BUILD ORDER — PHASE-2-INGESTION.md §8 has this in full. Propose it back to me and check before
starting. The one part I care about most: do the source abstraction ALONE first, with Plaid as
the only source, and get the full suite plus agent:smoke green before any ingestion code exists.
It adds no features and is the step most likely to break something quietly. And do typed manual
entry BEFORE any parser, so the merge, the ledger, and the UI are all real with nothing in the
way when a CSV first produces a wrong figure.

WORKING AGREEMENT:
- Add tests as you go. A passing suite is not proof of a correct assertion: the rolling-window
  date bug survived a test that checked those exact dates for the wrong property. Assert
  specific values, not that an array is non-empty.
- Verify claims by running things, not by reading code and asserting. Say plainly what you
  did not verify. Note that no page of this UI has ever been opened in a browser — Phase 1.5
  was verified by typecheck, build, unit tests, and one live trace check. Treat visual and
  interaction bugs as likely, not surprising.
- I handle all git commits myself. Do not commit, and do not offer to.
- Update docs/STATE.md as you go, and rewrite this file when Phase 2 is done.

BEFORE I UPLOAD ANYTHING REAL: remind me about the §9 employer outside-activity/IP action item.
It has been hypothetical while everything was sandbox fiction. It stops being hypothetical the
moment my own bank statements land in local storage.
```
