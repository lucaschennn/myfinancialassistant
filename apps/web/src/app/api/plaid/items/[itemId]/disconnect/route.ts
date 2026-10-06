/**
 * Disconnect a bank (Phase 2 /sources). Plaid is told to revoke the item and
 * our encrypted token is deleted. There is no financial data to delete with it:
 * none of the bank's data was ever stored (§0.4).
 */

import { TraceRecorder } from '@pfg/core';
import { PlaidItemNotFoundError, disconnectPlaidItem } from '@pfg/plaid';
import { NextResponse } from 'next/server';
import { requireCtx } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(_request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const ctx = await requireCtx();
    const { itemId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(itemId)) return NextResponse.json({ error: 'No such connection.' }, { status: 404 });
    const trace = new TraceRecorder();
    const result = await disconnectPlaidItem({ db: ctx.db, userId: ctx.userId, itemRowId: itemId, trace });
    return NextResponse.json({ ...result, trace: trace.build() });
  } catch (error) {
    if (error instanceof PlaidItemNotFoundError) return NextResponse.json({ error: 'No such connection.' }, { status: 404 });
    return errorResponse(error, 'Could not disconnect that bank.');
  }
}
