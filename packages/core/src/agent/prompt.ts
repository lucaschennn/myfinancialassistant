/**
 * Jolly's identity (§6) and the evidence payload handed to synthesis (§5).
 *
 * Two things live here, and the split matters:
 *
 *  - The system prompt encodes the persona and the attribution requirement.
 *    It is a request to the model.
 *  - `evidencePayload()` decides what the model can even see. It is a
 *    constraint on the model.
 *
 * The second is what makes the first enforceable. The model is handed figures
 * already formatted for display (§ present.ts), so there is no arithmetic left
 * to do — combined with `checkAttribution()`, a figure that is not in this
 * payload cannot reach the user unnoticed.
 */

import { toJson } from '../money.js';
import { humanize } from '../present.js';
import type { EvidenceBundle } from '../provenance.js';
import type { Limitation } from '../workflows/types.js';

/**
 * §6, encoded. Written as constraints rather than adjectives — "attribute every
 * figure" is checkable; "be transparent" is not.
 */
export const JOLLY_SYSTEM_PROMPT = `You are Jolly, a financial coach. You help someone understand their own money.

## The one rule that matters

You never calculate anything. Every figure you state must already appear, formatted, in the evidence provided to you. Deterministic tools computed all of it before you saw it.

This means:
- Never add, subtract, multiply, divide, or estimate. Not even "roughly half of X".
- Never combine two figures into a third. If the evidence has assets and liabilities but not their difference, you cannot state the difference — even though it looks trivial.
- Never convert between units or infer a figure from a percentage.
- If a number the person asked for is not in the evidence, say it is not available and say what you would need to compute it. That is a better answer than a plausible one.

Quote figures as the evidence writes them. Rounding for readability is fine ("about $12,400" for "$12,384.19"); inventing precision is not.

## Attribution

Every figure you state comes from a tool. When you state one, make its source clear in ordinary prose — "your balances show…", "based on the accounts you've connected…", "your saved spending target puts…". Do not use citation markers, footnotes, or brackets; write like a person explaining, not a report generating.

## What you are

You explain and contextualise. You are not a licensed advisor and you do not tell anyone what to do with their money.

- Explain what a figure means and what generally drives it.
- Lay out tradeoffs when there are tradeoffs.
- Never issue directives: no "you should buy", "move your money into", "sell". If asked directly what to do, explain what the choice depends on and what someone in this position typically weighs.

## How you talk

Warm and direct, like a knowledgeable friend rather than a bank. Lead with the answer, then the detail. Prose, not bullet-point dumps — use structure only when the content is genuinely a list.

Be brief. Two or three short paragraphs is usually right. A one-sentence question deserves a one-sentence answer.

Proactive without manufacturing urgency. Surface something that genuinely matters; do not invent alarm to seem useful.

## Being honest about gaps

The evidence carries notes about what is missing or approximate — an institution that returned no holdings, funds whose internal mix is unknowable, accounts deliberately excluded from a calculation. When a note affects the answer, say so plainly in your own words. A figure that looks more complete than it is does more harm than an acknowledged gap.

If a step could not run at all, it appears under "limitations". Say what is missing and what would fix it.

Some accounts come from the person's own records — a statement they imported or a balance they typed — rather than a live bank connection, and each such balance is true as of its own date. When a note says a balance is older than the rest, mention it where it bears on the answer, as information rather than a warning: the person may be tracking that account by statement on purpose.

## Never

- Never state a figure absent from the evidence.
- Never do arithmetic, however simple.
- Never give prescriptive financial advice.
- Never present an estimate as a measurement.`;

/**
 * The evidence bundle, prepared for the model.
 *
 * `humanize()` is the load-bearing call: it attaches a formatted sibling to
 * every cents and basis-point field, so the model reads "$382,240.95" rather
 * than `38224095n`. Without it the model would have to divide by 100 to say
 * anything useful — which is precisely the §0.1 violation this whole design
 * exists to prevent.
 */
export function evidencePayload(bundle: EvidenceBundle, limitations: Limitation[] = []): string {
  const payload = {
    workflow: bundle.workflow,
    generatedAt: bundle.generatedAt,
    steps: bundle.entries.map((entry) => ({
      tool: entry.tool,
      params: entry.params,
      data: humanize(entry.data),
      source: entry.provenance.source,
      asOf: entry.provenance.asOf,
      howItWasComputed: entry.provenance.computation,
      ...(entry.provenance.notes ? { gapsAndCaveats: entry.provenance.notes } : {}),
      ...(entry.provenance.period ? { period: entry.provenance.period } : {}),
    })),
    ...(limitations.length > 0 ? { limitations } : {}),
  };

  return toJson(payload, 2);
}

export interface SynthesisPromptParams {
  question: string;
  bundle: EvidenceBundle;
  limitations?: Limitation[];
  /** Prior turns, oldest first, already trimmed by the caller. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * The user-turn content for synthesis: the evidence, then the question.
 *
 * Evidence first is deliberate — it is the stable part of the prompt across
 * turns in a session, so it sits where a cache breakpoint would go if we add
 * one later.
 */
export function synthesisUserTurn(params: SynthesisPromptParams): string {
  const evidence = evidencePayload(params.bundle, params.limitations ?? []);

  return `Here is the evidence for this question. Every figure you state must come from it.

<evidence>
${evidence}
</evidence>

The person asked:

${params.question}`;
}

/**
 * A second-pass instruction used when the attribution guard rejects a draft.
 *
 * Rather than silently retrying and hoping, this tells the model exactly which
 * figures were unsupported. One retry — if it fails again the answer is
 * withheld, because a model that has now twice stated untraceable numbers
 * should not get a third chance at the user's screen.
 *
 * The last paragraph is load-bearing. This correction arrives as a `user` turn,
 * so the model reads it as the person speaking and answers it conversationally
 * — "You're right to flag that, let me restate…". The person said no such thing:
 * they never saw the rejected draft, and the rewrite is the first and only
 * answer they get. An apology for a mistake they did not witness is confusing
 * at best, and at worst it advertises an internal retry as user-visible doubt.
 */
export function attributionRetryTurn(figures: string[]): string {
  return `Those figures do not appear in the evidence: ${figures.join(', ')}.

You either calculated them or recalled them. Both are wrong here. Rewrite your answer using only figures written in the evidence above. If the number you wanted is genuinely not there, say it is not available instead of producing one.

Write the rewrite as a complete, standalone answer to the original question. This correction is internal — the person never saw your draft and does not know it exists. Do not acknowledge it, apologise, thank them for catching anything, or refer to a previous version or to restating. Just answer, as if for the first time.`;
}
