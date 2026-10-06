/**
 * Archive one of your own accounts (§3): it leaves every future snapshot and
 * its balance history is kept, so no ledger row is left dangling.
 */

import { archiveManualAccount } from '@pfg/core';
import { NextResponse } from 'next/server';
import { requireCtx } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(_request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  try {
    const ctx = await requireCtx();
    const { accountId } = await params;
    const result = await archiveManualAccount(ctx, accountId);
    if (!result.data.archived) return NextResponse.json({ error: 'No such account.' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 'Could not archive that account.');
  }
}
