# Kickoff prompt for the next session

Paste the block below into a fresh Claude Code session in this repo.

Keep it current. This file has gone stale four times now — it described Phase 1 after Phase 1
was built, then Checkpoint 1 after Phase 1.5 was built, then the old AI-sophistication Phase 2
after the timeline was re-planned, then the start of Phase 2 after Phase 2 was built. Rewrite it
when the work it describes is done rather than leaving a confidently wrong prompt in place. It is
only ever harmless because its first instruction is "read STATE.md."

---

```
Phase 2 (document ingestion) is BUILT. This session picks up from the Checkpoint 2 run on my own
documents — fixing what it found — and then, only when I say so, starts Phase 3.

READ FIRST, BEFORE ANY CODE:
1. docs/STATE.md — start at "Where Phase 2 landed" and "What is next: the Checkpoint 2 run".
   It records what was verified by running, what was NOT (no page of the new UI had been opened
   in a browser when the build finished; no real bank file had been tried), and the gaps Phase 2
   added. Several things that look like oversights are recorded there as decisions.
2. docs/PHASE-2-INGESTION.md — the spec Phase 2 was built from. Its "As built" note lists where
   the build deliberately differs.
3. CLAUDE.md — the spec. §0.4, §0.8, §7b and §9 govern everything ingestion touches.

Then verify the environment rather than assuming it:
  npm run db:up && npm run db:migrate
  npm test          # expect 250 passing
  npm run typecheck
  npm run build

Environment notes specific to this machine:
- Docker Desktop is frequently not running; ECONNREFUSED on :5433 means Docker is down. It
  installs per-user under AppData\Local\Programs\DockerDesktop.
- Run npm scripts through PowerShell. Vitest under Git Bash has collected 0 tests before.
- Do NOT edit files through PowerShell 5.1 Get-Content/Set-Content: it re-encodes UTF-8 and
  corrupts characters like the ellipsis in provenance notes. Use the editor tools.
- The system clock drifts and W32Time is not reliably Automatic. If Clerk sign-in loops, it is
  the clock, not the keys — STATE.md has the elevated fix.
- The Plaid sandbox item can drop to ITEM_LOGIN_REQUIRED on its own. agent:smoke then shows 0
  accounts and 1 gap. STATE.md says how it was re-linked last time.

WHAT I EXPECT THIS SESSION TO BE:
I will tell you what happened in my Checkpoint 2 run — real CSV and PDF exports, the review
screen, the dashboard, chat. Expect UI and interaction bugs (the review screen is the largest
client component in the repo and was never opened in a browser by the agent that built it), and
expect real exports to have column names and layouts the fixtures did not. Fix those first, with
tests. Add a fixture for each real layout that broke — fictional values, real shape — never a
copy of my actual file.

NON-NEGOTIABLE, unchanged from Phase 2:
- The AI never computes a number. checkAttribution() for prose, checkTranscription() for
  statements. A figure either guard rejects is a bug to investigate, never a check to loosen.
- Extraction is transcription: the model quotes verbatim strings with page numbers; parseAmount
  turns text into cents with no float; anything not in the extracted text is DROPPED; a person
  reviews every draft. There is no API that commits a draft without review, and there must never
  be one.
- The sign convention: Plaid's positive = money OUT, everywhere past the draft. The importer
  converts once. If a real file reads backwards, fix detection or the review copy — never add a
  second convention downstream.
- No raw Plaid data at rest. The manual ledger is the deliberate exception for data nothing else
  holds; it is not a precedent.
- Evidence names a document by kind and import date, never by filename (filenames carry account
  numbers, and evidence goes to the model).
- Client components take TYPE-ONLY imports from @pfg/core and @pfg/ingest.

PHASE 3 (only when I say): docs/PHASE-3-PLAYGROUND.md, build order §10. Phase 2 already left the
two seams it needs: pure ingest stages on in-memory bytes, and createTranscriber taking its prompt
and model as config. scripts/transcribe-smoke.ts is a small preview of the ingestion lane.

WORKING AGREEMENT:
- Add tests as you go, asserting specific values. A passing suite is not proof of a correct
  assertion.
- Verify claims by running things; say plainly what you did not verify.
- I handle all git commits myself. Do not commit, and do not offer to.
- Update docs/STATE.md as you go, and rewrite this file when the work it describes is done.
```
