/**
 * §7.1 step 2: public_token → access_token → encrypted at rest.
 *
 * This route is what `scripts/link-sandbox-item.ts` was standing in for. The
 * public token is short-lived and useless on its own; the access token it
 * becomes never leaves the server, is never returned to the client, and is
 * never logged (§9).
 *
 * The user id comes from the session, not the body — the encrypted token must
 * land on the row of whoever actually completed the Link flow.
 */

import { exchangePublicToken } from '@pfg/plaid';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, getWebDb } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

const Body = z.object({
  publicToken: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const user = await requireUser();

    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'A public token is required.' }, { status: 400 });
    }

    const summary = await exchangePublicToken({
      userId: user.id,
      db: getWebDb(),
      publicToken: parsed.data.publicToken,
      registerAccounts: true,
    });

    // Deliberately narrow: institution and account count, nothing financial.
    return NextResponse.json({
      institutionName: summary.institutionName,
      accountCount: summary.accountCount,
    });
  } catch (error) {
    return errorResponse(error, 'Could not finish connecting that institution.');
  }
}
