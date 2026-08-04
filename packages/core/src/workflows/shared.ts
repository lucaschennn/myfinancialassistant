/**
 * Helpers shared by the period-scoped workflows.
 */

import { type Ctx, requireSnapshot } from '../context.js';
import type { Period } from '../compute/period.js';
import type { Limitation } from './types.js';

/**
 * Turn a thrown error into a limitation a person can read.
 *
 * The thrown message is deliberately NOT used as the reason. Compute functions
 * throw for developers — they name parameters and suggest API calls — and that
 * text has no business on a "why" card. It goes to the log so a real bug is
 * still diagnosable; the user gets `reason`.
 */
export function limitationFrom(
  tool: string,
  reason: string,
  error: unknown,
): Limitation {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[workflow] ${tool} did not run: ${detail}`);
  return { tool, reason };
}

/**
 * The spend-target gap, which three workflows can hit. Worth writing once:
 * it is the most common limitation a new user will see, and it should read as
 * a next step rather than a failure.
 */
export const NO_SPEND_TARGET =
  'This needs a target for your annual spending before it can be worked out. ' +
  'Set one on your profile and it will appear here.';

/**
 * The period a workflow should use when the router did not name one.
 *
 * Defaults to the snapshot's own transaction window rather than an arbitrary
 * "last 30 days". Two reasons: it is the widest range that is actually
 * complete, and it guarantees the figure carries no "we only fetched back
 * to X" caveat — an unasked-for default should not silently produce a
 * partial answer.
 */
export function defaultPeriod(ctx: Ctx, tool: string): Period {
  const snapshot = requireSnapshot(ctx, tool);
  if (snapshot.transactionWindow) return snapshot.transactionWindow;

  // No window fetched — hand back a same-day range so the compute functions
  // still validate, and let their own gap notes explain the emptiness.
  const today = snapshot.fetchedAt.slice(0, 10);
  return { from: today, to: today };
}
