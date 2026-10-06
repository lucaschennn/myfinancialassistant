/** Throw away a document that has not been imported: bytes and row both go. */

import { rejectDocument } from '@pfg/ingest';
import { NextResponse } from 'next/server';
import { requireCtx } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    const ctx = await requireCtx();
    const { documentId } = await params;
    await rejectDocument({ db: ctx.db, userId: ctx.userId, documentId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 'Could not remove this document.');
  }
}
