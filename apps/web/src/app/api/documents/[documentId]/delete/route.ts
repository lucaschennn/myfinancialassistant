/**
 * Delete an imported document (§3). The choice is explicit: keep the rows it
 * added as free-standing entries, or drop them. The original bytes go either way.
 */

import { deleteDocument } from '@pfg/ingest';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCtx } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

const Body = z.object({ ledger: z.enum(['keep', 'drop']) });

export async function POST(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    const ctx = await requireCtx();
    const { documentId } = await params;
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Say whether to keep or drop the rows this document added.' }, { status: 400 });
    }
    const result = await deleteDocument({ db: ctx.db, userId: ctx.userId, documentId, ledger: parsed.data.ledger });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 'Could not delete this document.');
  }
}
