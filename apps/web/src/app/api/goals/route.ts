/**
 * Goals (§4 "Context (write)").
 *
 * `setGoal` and `deleteGoal` have existed in `core` since Phase 0 with no
 * caller — `deleteGoal` was not even exposed over MCP, so a goal could be
 * created and never removed. This route is the first surface for either.
 *
 * Amounts arrive as strings for the same reason as the spend target:
 * `dollarsToCents` is the only function permitted to touch a float (§0.3), and
 * it should be the thing that parses the digits, not `JSON.parse` upstream.
 */

import { deleteGoal, dollarsToCents, setGoal } from '@pfg/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCtx } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

const DOLLARS = /^\d{1,9}(\.\d{1,2})?$/;

const CreateBody = z.object({
  type: z.enum(['fire', 'emergency_fund', 'debt_payoff', 'savings_target', 'custom']),
  label: z.string().trim().max(120).optional(),
  targetDollars: z.string().trim().regex(DOLLARS).optional(),
  /** YYYY-MM-DD */
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function POST(request: Request) {
  try {
    const ctx = await requireCtx();

    const parsed = CreateBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'A goal needs a type, and any amount must be in dollars.' },
        { status: 400 },
      );
    }

    const { type, label, targetDollars, targetDate } = parsed.data;
    await setGoal(ctx, {
      type,
      ...(label ? { label } : {}),
      ...(targetDollars ? { targetCents: dollarsToCents(Number(targetDollars)) } : {}),
      ...(targetDate ? { targetDate } : {}),
    });

    // No figures in the response: the page re-renders from the server and reads
    // them back through `getUserContext`, so nothing needs to round-trip here.
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 'Could not save that goal.');
  }
}

const DeleteBody = z.object({ goalId: z.string().uuid() });

export async function DELETE(request: Request) {
  try {
    const ctx = await requireCtx();

    const parsed = DeleteBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Which goal?' }, { status: 400 });
    }

    // `deleteGoal` scopes on user_id as well as id, so a guessed id belonging to
    // someone else deletes nothing rather than 403-ing informatively (§3).
    const removed = await deleteGoal(ctx, parsed.data.goalId);
    if (!removed.data.deleted) {
      return NextResponse.json({ error: 'That goal no longer exists.' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 'Could not remove that goal.');
  }
}
