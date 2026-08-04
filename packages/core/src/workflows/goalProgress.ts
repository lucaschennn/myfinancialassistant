/**
 * `goal_progress` (§5): getUserContext → (relevant compute) → fireProgress.
 *
 * The "relevant compute" the spec leaves open is `netWorth`: progress is
 * meaningless without the position it is progress *from*, and stating a FIRE
 * percentage without the underlying figure is exactly the kind of unanchored
 * number §0.2 exists to prevent.
 *
 * This is the one workflow that starts from Postgres rather than Plaid — the
 * user's own targets and goals are the subject, and the live data is context.
 */

import { EvidenceBuilder } from '../provenance.js';
import { fireProgress } from '../compute/fireProgress.js';
import { netWorth } from '../compute/netWorth.js';
import { getUserContext } from '../tools/userContext.js';
import { NO_SPEND_TARGET, limitationFrom } from './shared.js';
import type { Ctx } from '../context.js';
import type { Limitation, WorkflowParams, WorkflowRun } from './types.js';

export async function goalProgress(ctx: Ctx, params: WorkflowParams = {}): Promise<WorkflowRun> {
  const evidence = new EvidenceBuilder('goal_progress', ctx.userId);
  const limitations: Limitation[] = [];

  // Goals and targets live in Postgres, so this step needs a db but no snapshot.
  let context;
  try {
    context = evidence.add('getUserContext', {}, await getUserContext(ctx));
  } catch (error) {
    limitations.push(
      limitationFrom(
        'getUserContext',
        'Your saved profile and goals could not be read, so this answer does not take ' +
          'your own targets into account.',
        error,
      ),
    );
  }

  evidence.add('netWorth', {}, netWorth(ctx));

  const fireParams = {
    ...(params.annualSpendCents !== undefined ? { annualSpendCents: params.annualSpendCents } : {}),
    ...(params.multiple !== undefined ? { multiple: params.multiple } : {}),
    ...(params.withdrawalRate !== undefined ? { withdrawalRate: params.withdrawalRate } : {}),
  };

  try {
    evidence.add('fireProgress', fireParams, await fireProgress(ctx, fireParams));
  } catch (error) {
    limitations.push(limitationFrom('fireProgress', NO_SPEND_TARGET, error));
  }

  // Not a failed step — a fact about the account. No `tool`, because naming one
  // would imply something broke when nothing did.
  if (context && context.goals.length === 0 && context.targetAnnualSpendCents === null) {
    limitations.push({
      reason:
        'No goals or spending target have been set yet, so there is nothing specific to ' +
        'measure progress against beyond the general FIRE calculation.',
    });
  }

  return { bundle: evidence.build(), limitations };
}
