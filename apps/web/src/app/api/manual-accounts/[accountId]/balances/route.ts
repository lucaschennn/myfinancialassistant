/** Record (or correct) a dated balance on one of your own accounts. */

import { recordManualBalance } from '@pfg/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { centsFromField } from '@/server/amount';
import { requireCtx } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

const Body = z.object({ balance: z.string().trim().min(1).max(32), asOfDate: z.string().trim() });

export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  try {
    const ctx = await requireCtx();
    const { accountId } = await params;
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Enter a balance and the date it was true on.' }, { status: 400 });
    }
    await recordManualBalance(ctx, {
      accountId,
      asOfDate: parsed.data.asOfDate,
      currentCents: centsFromField(parsed.data.balance, 'Balance'),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 'Could not save that balance.');
  }
}
