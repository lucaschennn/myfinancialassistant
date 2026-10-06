/**
 * Upload (§7b stage 1). The file's kind is decided from its bytes, its size is
 * capped, and its name is kept for display only (§9). A PDF is transcribed
 * here by one disclosed model call; a CSV is parsed with no model at all.
 * Nothing reaches your records until the review screen's commit.
 */

import { TraceRecorder } from '@pfg/core';
import { MAX_UPLOAD_BYTES, createTranscriber, uploadDocument } from '@pfg/ingest';
import { NextResponse } from 'next/server';
import { requireCtx } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';
// A PDF statement means one transcription call, which can take a while.
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const ctx = await requireCtx();
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Choose a file to upload.' }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: 'That file is larger than 10 MB.' }, { status: 400 });
    }

    const trace = new TraceRecorder();
    const started = Date.now();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const outcome = await uploadDocument({
      db: ctx.db,
      userId: ctx.userId,
      bytes,
      filename: file.name || null,
      trace,
      transcribe: createTranscriber({ trace }),
    });
    // Names, counts and durations only — never the filename or any content (§9).
    trace.add({
      scope: 'internal',
      label: 'POST /api/documents',
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      ok: true,
      detail: outcome.outcome === 'duplicate' ? 'already uploaded' : outcome.status,
    });
    return NextResponse.json({ ...outcome, trace: trace.build() });
  } catch (error) {
    return errorResponse(error, 'Could not upload that file.');
  }
}
