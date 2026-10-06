/**
 * Commit (§7b stage 4). Rebuilt from the original bytes and the stored
 * decisions, every blocker re-checked, then one database transaction.
 */

import { TraceRecorder, toJson } from '@pfg/core';
import { commitDocument } from '@pfg/ingest';
import { NextResponse } from 'next/server';
import { requireCtx } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    const ctx = await requireCtx();
    const { documentId } = await params;
    const trace = new TraceRecorder();
    const summary = await commitDocument({ db: ctx.db, userId: ctx.userId, documentId, trace });
    return new NextResponse(toJson({ summary, trace: trace.build() }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return errorResponse(error, 'Could not import this document.');
  }
}
