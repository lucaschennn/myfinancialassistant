/**
 * §7.1 step 1: mint a Plaid Link token for the signed-in user.
 *
 * The `client_user_id` handed to Plaid is our UUID, resolved from the session —
 * never a value the client sent. A route that accepted a user id from the body
 * would let anyone mint a Link token against anyone else's Plaid user.
 */

import { createLinkToken } from '@pfg/plaid';
import { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

export async function POST() {
  try {
    const user = await requireUser();
    const linkToken = await createLinkToken({ userId: user.id });
    return NextResponse.json({ linkToken });
  } catch (error) {
    return errorResponse(error, 'Could not start the bank connection.');
  }
}
