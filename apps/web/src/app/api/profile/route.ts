/**
 * The user's own context (§4 "Context (write)"), currently just the annual
 * spend target that `fireProgress` needs.
 *
 * Until this route existed the only way to set one was `npm run set:profile`,
 * which meant a real signed-up user could never satisfy `fireProgress` at all —
 * their summary permanently showed the "needs a target" limitation with no way
 * to act on it. That gap sat directly inside Checkpoint 1's acceptance text.
 *
 * The amount arrives as a STRING, not a number. §0.3 makes `dollarsToCents` the
 * only function permitted to touch a float, so the digits the user typed are
 * carried verbatim to that one call rather than being parsed into a JS number by
 * `JSON.parse` on the way in and rounded before anyone owns the conversion.
 */

import { dollarsToCents, formatCents, setProfile } from '@pfg/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCtx } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

/** Up to 9 digits and at most 2 decimal places. No sign — a spend target is positive. */
const DOLLARS = /^\d{1,9}(\.\d{1,2})?$/;

const Body = z.object({
  targetAnnualSpendDollars: z.string().trim().regex(DOLLARS),
});

export async function POST(request: Request) {
  try {
    const ctx = await requireCtx();

    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Enter an amount in dollars, like 60000 or 60000.00.' },
        { status: 400 },
      );
    }

    const cents = dollarsToCents(Number(parsed.data.targetAnnualSpendDollars));
    if (cents <= 0n) {
      // fireProgress divides by this figure, and a zero target is not a
      // meaningful goal anyway. Rejecting here gives a better message than the
      // RangeError the compute function would otherwise throw.
      return NextResponse.json({ error: 'Your spend target needs to be above zero.' }, { status: 400 });
    }

    const profile = await setProfile(ctx, { targetAnnualSpendCents: cents });

    // A formatted string, not the bigint: bigint has no JSON representation, and
    // handing the client a raw figure to format invites it to do arithmetic on
    // the way (§0.1). The server formats; the browser displays.
    return NextResponse.json({
      targetAnnualSpend: profile.data.targetAnnualSpendCents
        ? formatCents(profile.data.targetAnnualSpendCents)
        : null,
    });
  } catch (error) {
    return errorResponse(error, 'Could not save your spend target.');
  }
}
