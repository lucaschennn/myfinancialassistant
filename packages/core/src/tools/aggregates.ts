/**
 * Tier-1 derived aggregates (§3, §7). The ONLY financial values that persist,
 * and they are computed numbers rather than a copy of anything Plaid sent.
 */

import { type Ctx, requireDb } from '../context.js';
import type { Cents } from '../money.js';
import { type ToolResult, result } from '../provenance.js';
import type { NetWorthData } from '../compute/netWorth.js';
import { networthSnapshots } from '@pfg/db';
import { desc, eq } from 'drizzle-orm';

export interface NetWorthSnapshotRow {
  asOfDate: string;
  netWorthCents: Cents;
  assetsCents: Cents;
  liabilitiesCents: Cents;
}

/**
 * Append (or replace) today's net worth point. Upsert on (user, date) so
 * running several sessions in one day moves the point rather than stacking
 * duplicates on the chart.
 */
export async function appendNetWorthSnapshot(
  ctx: Ctx,
  netWorthData: NetWorthData,
  asOfDate = new Date().toISOString().slice(0, 10),
): Promise<NetWorthSnapshotRow> {
  const db = requireDb(ctx, 'appendNetWorthSnapshot');
  const values = {
    userId: ctx.userId,
    asOfDate,
    netWorthCents: netWorthData.netWorthCents,
    assetsCents: netWorthData.assetsCents,
    liabilitiesCents: netWorthData.liabilitiesCents,
  };

  await db
    .insert(networthSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: [networthSnapshots.userId, networthSnapshots.asOfDate],
      set: {
        netWorthCents: values.netWorthCents,
        assetsCents: values.assetsCents,
        liabilitiesCents: values.liabilitiesCents,
      },
    });

  return {
    asOfDate,
    netWorthCents: values.netWorthCents,
    assetsCents: values.assetsCents,
    liabilitiesCents: values.liabilitiesCents,
  };
}

export interface NetWorthHistoryData {
  points: NetWorthSnapshotRow[];
}

/** The one financial time series we can offer without a transaction ledger. */
export async function getNetWorthHistory(
  ctx: Ctx,
  params: { limit?: number } = {},
): Promise<ToolResult<NetWorthHistoryData>> {
  const db = requireDb(ctx, 'getNetWorthHistory');
  const rows = await db
    .select()
    .from(networthSnapshots)
    .where(eq(networthSnapshots.userId, ctx.userId))
    .orderBy(desc(networthSnapshots.asOfDate))
    .limit(params.limit ?? 90);

  const points = rows
    .map((r) => ({
      asOfDate: r.asOfDate,
      netWorthCents: r.netWorthCents,
      assetsCents: r.assetsCents,
      liabilitiesCents: r.liabilitiesCents,
    }))
    .reverse();

  return result(
    { points },
    {
      source: 'db',
      asOf: new Date().toISOString(),
      computation:
        'Stored net worth snapshots, one per day, each computed at the time of a session ' +
        'from live balances.',
      ...(points.length < 2
        ? { notes: ['Not enough history yet to show a trend — snapshots accumulate one per day.'] }
        : {}),
    },
  );
}
