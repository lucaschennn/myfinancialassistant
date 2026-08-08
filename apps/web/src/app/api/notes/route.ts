/**
 * Profile notes (§4 "Context (write)").
 *
 * `addNote` has existed in `core` since Phase 0 with no caller outside the MCP
 * harness. Notes are the user's own words about their situation — the context
 * a coach would otherwise have to guess at — and they belong to the user, not
 * to Plaid, so they are the one free-text field the app stores.
 */

import { addNote } from '@pfg/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCtx } from '@/server/auth';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';

const Body = z.object({ note: z.string().trim().min(1).max(1000) });

export async function POST(request: Request) {
  try {
    const ctx = await requireCtx();

    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Write something first.' }, { status: 400 });
    }

    await addNote(ctx, parsed.data.note);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 'Could not save that note.');
  }
}
