/**
 * Typed entry (Phase 2, §7b): create an account from your own records, with an
 * optional opening balance. The always-works path into the manual ledger, and
 * the fallback when a document will not parse.
 */

import { createManualAccount } from '@pfg/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { centsFromField } from '@/server/amount';
import { requireCtx } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.string(),
  subtype: z.string().trim().max(60).optional(),
  mask: z.string().trim().max(4).optional(),
  institutionName: z.string().trim().max(120).optional(),
  // A string all the way to the server (§0.3).
  balance: z.string().trim().max(32).optional(),
  asOfDate: z.string().trim().optional(),
});

export async function POST(request: Request) {
  try {
    const ctx = await requireCtx();
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Give the account a name and a type.' }, { status: 400 });
    }
    const body = parsed.data;
    const hasBalance = Boolean(body.balance);
    if (hasBalance && !body.asOfDate) {
      return NextResponse.json({ error: 'A balance needs the date it was true on.' }, { status: 400 });
    }

    const created = await createManualAccount(ctx, {
      name: body.name,
      type: body.type,
      subtype: body.subtype ?? null,
      mask: body.mask ?? null,
      institutionName: body.institutionName ?? null,
      ...(hasBalance
        ? { balance: { asOfDate: body.asOfDate!, currentCents: centsFromField(body.balance!, 'Balance') } }
        : {}),
    });
    return NextResponse.json({ accountId: created.data.accountId });
  } catch (error) {
    return errorResponse(error, 'Could not save that account.');
  }
}
