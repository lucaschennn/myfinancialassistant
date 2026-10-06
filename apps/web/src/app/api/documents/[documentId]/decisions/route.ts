/** Replace the review decisions and get the re-derived draft back. Never writes the ledger. */

import { TraceRecorder, toJson } from '@pfg/core';
import { updateDecisions } from '@pfg/ingest';
import { NextResponse } from 'next/server';
import { requireCtx } from '@/server/auth';
import { parseDecisions } from '@/server/decisions';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    const ctx = await requireCtx();
    const { documentId } = await params;
    const decisions = parseDecisions(await request.json().catch(() => null));
    if (!decisions) return NextResponse.json({ error: 'That change could not be read.' }, { status: 400 });
    const trace = new TraceRecorder();
    const review = await updateDecisions({ db: ctx.db, userId: ctx.userId, documentId, decisions, trace });
    return new NextResponse(toJson({ review, trace: trace.build() }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return errorResponse(error, 'Could not update this import.');
  }
}
