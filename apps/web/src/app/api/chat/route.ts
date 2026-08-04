/**
 * The chat endpoint — one agent turn per request (§7 refetch-per-turn).
 *
 * The response carries the evidence bundle alongside the answer so the UI can
 * render "why" cards without a second round trip. That bundle is regenerated
 * live on every turn and never persisted (§5).
 */

import { type EvidenceBundle, toJson } from '@pfg/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { type ChatTurn, runAgentTurn } from '@/server/agent';
import { errorResponse } from '@/server/http';
import { requireSnapshotCtx } from '@/server/session';

export const runtime = 'nodejs';

// A live Plaid fetch plus two model calls. §2 asks for maxDuration to be set
// explicitly, since the default would cut a slow turn off mid-answer.
export const maxDuration = 120;

const Body = z.object({
  question: z.string().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(10_000),
      }),
    )
    .max(20)
    .optional(),
});

export async function POST(request: Request) {
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Ask a question first.' }, { status: 400 });
    }

    const { question, history = [] } = parsed.data;

    // Transactions are only needed by the spending and lookup workflows, but
    // the router has not run yet — and a second Plaid round trip would cost
    // more than the transactions call itself. Fetch once, fully.
    const ctx = await requireSnapshotCtx({ transactionDays: 90 });

    const result = await runAgentTurn(ctx, question, history as ChatTurn[]);

    // toJson handles the bigint cents the bundle carries (§0.3).
    return new NextResponse(
      toJson({
        answer: result.answer,
        workflow: result.workflow,
        bundle: result.bundle satisfies EvidenceBundle,
        limitations: result.limitations,
        attributionWarnings: result.attributionWarnings,
        attributionOutcome: result.attributionOutcome,
        routedBy: result.routedBy,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    return errorResponse(error, 'I could not work through that question just now.');
  }
}
