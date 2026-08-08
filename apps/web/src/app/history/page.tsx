/**
 * Net worth over time (§8 Phase 1.5-B).
 *
 * `networth_snapshots` has been written on every summary run since Phase 0 and
 * has never had a surface. It is the one financial time series we can offer
 * without a transaction ledger (§3 Tier 1) — a derived aggregate, not a mirror
 * of Plaid's data — and showing it costs no Plaid call at all.
 *
 * Note what this page does NOT do: it reads stored snapshots only. It does not
 * fetch live balances, so the most recent point is from the last time you
 * loaded the summary, not from this moment. The provenance card says so.
 */

import { type NetWorthHistoryData, formatCents, getNetWorthHistory } from '@pfg/core';
import { requireCtx } from '@/server/auth';
import { FigureEvidence } from '../Evidence';
import { NetWorthChart } from './NetWorthChart';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  const ctx = await requireCtx();
  const history = await getNetWorthHistory(ctx, { limit: 180 });
  const points: NetWorthHistoryData['points'] = history.data.points;

  const latest = points[points.length - 1];
  const first = points[0];
  // The change is computed here in cents, not in the browser and not by a
  // model — same rule as everywhere else (§0.1, §0.3).
  const change =
    latest && first && points.length > 1 ? latest.netWorthCents - first.netWorthCents : null;

  return (
    <div className="stack">
      <div className="card">
        <h2>Net worth over time</h2>
        <p className="card-sub">
          One point per day, each computed from live balances at the time you loaded your
          summary. Days you did not open the app have no point.
        </p>

        {points.length === 0 ? (
          <p className="muted">
            No snapshots yet. One is written each time your summary is computed, so this fills
            in as you use the app.
          </p>
        ) : (
          <>
            <div className="figure-row" style={{ marginBottom: 18 }}>
              <div>
                <div className="figure-label">Latest</div>
                <div className={`figure-sm ${latest!.netWorthCents < 0n ? 'negative' : ''}`}>
                  {formatCents(latest!.netWorthCents)}
                </div>
              </div>
              <div>
                <div className="figure-label">Points recorded</div>
                <div className="figure-sm">{points.length}</div>
              </div>
              {change !== null && (
                <div>
                  <div className="figure-label">Change across the range</div>
                  <div className={`figure-sm ${change < 0n ? 'negative' : ''}`}>
                    {change >= 0n ? '+' : ''}
                    {formatCents(change)}
                  </div>
                </div>
              )}
            </div>

            <NetWorthChart
              points={points.map((p) => ({
                asOfDate: p.asOfDate,
                // Charts need numbers, and SVG geometry is the one place a
                // float is harmless — it is never read back as money. The
                // labels below come from formatCents on the bigint.
                netWorth: Number(p.netWorthCents),
                assets: Number(p.assetsCents),
                liabilities: Number(p.liabilitiesCents),
                label: formatCents(p.netWorthCents),
              }))}
            />
          </>
        )}

        <FigureEvidence
          entry={{ tool: 'getNetWorthHistory', params: {}, data: null, provenance: history.provenance }}
          label="Where this history comes from"
        />
      </div>

      {points.length > 0 && (
        <div className="card">
          <h2>Every recorded point</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>Assets</th>
                  <th style={{ textAlign: 'right' }}>Liabilities</th>
                  <th style={{ textAlign: 'right' }}>Net worth</th>
                </tr>
              </thead>
              <tbody>
                {[...points].reverse().map((point) => (
                  <tr key={point.asOfDate}>
                    <td>{point.asOfDate}</td>
                    <td className="num">{formatCents(point.assetsCents)}</td>
                    <td className="num">{formatCents(point.liabilitiesCents)}</td>
                    <td className={`num ${point.netWorthCents < 0n ? 'negative' : ''}`}>
                      {formatCents(point.netWorthCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
