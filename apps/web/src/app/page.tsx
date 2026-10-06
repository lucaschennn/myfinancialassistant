/**
 * The summary dashboard — Checkpoint 1's "see a transparent summary" (§8).
 *
 * Rendered from the `summary_overview` evidence bundle rather than by calling
 * compute functions ad hoc. That matters: the dashboard and the chat answer are
 * then reading the *same* pipeline output, so a figure cannot differ between
 * them, and every number on this page has a provenance entry behind it.
 */

import {
  type AssetAllocationData,
  type EvidenceBundle,
  type FireProgressData,
  type ListAccountsData,
  type NetWorthData,
  basisPointsToPercent,
  formatCents,
  runWorkflow,
} from '@pfg/core';
import Link from 'next/link';
import { ConnectBank } from './ConnectBank';
import { SourceBadge } from './SourceBadge';
import { EvidenceCard, FigureEvidence, LimitationStep } from './Evidence';
import { SpendTarget } from './SpendTarget';
import { NetworkPanel } from './NetworkPanel';
import { Chat } from './Chat';
import { requireUser } from '@/server/auth';
import { hasAnySource, requireSnapshotCtx, traceRender } from '@/server/session';

// Every source re-read on every render (§7): Plaid live, the manual ledger
// from Postgres. Nothing to cache.
export const dynamic = 'force-dynamic';

function entryData<T>(bundle: EvidenceBundle, tool: string): T | undefined {
  return bundle.entries.find((e) => e.tool === tool)?.data as T | undefined;
}

const percent = (bps: number | null): string =>
  bps === null ? '—' : `${basisPointsToPercent(bps).toFixed(1)}%`;

export default async function DashboardPage() {
  const user = await requireUser();

  if (!(await hasAnySource(user.id))) {
    return (
      <div className="stack">
        <div className="card">
          <h2>Add your first account</h2>
          <p className="card-sub">
            Two ways in, and you can use both. Connect a bank and Jolly reads it live through
            Plaid each time you look, storing none of it. Or add accounts from your own records,
            typed in or imported from a statement, which are kept encrypted because nothing else
            holds them.
          </p>
          <ConnectBank hasAccounts={false} />
          <p style={{ marginTop: 14 }}>
            <Link className="btn" href="/accounts/new">
              Add an account by hand
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const started = Date.now();

  // The fixed five-tool pipeline (§5). The page does not choose tools.
  const ctx = await requireSnapshotCtx({ includeTransactions: false });
  const { bundle, limitations } = await runWorkflow('summary_overview', ctx, {});
  traceRender(ctx, 'GET / (summary dashboard)', started);

  const accounts = entryData<ListAccountsData>(bundle, 'listAccounts');
  const nw = entryData<NetWorthData>(bundle, 'netWorth');
  const allocation = entryData<AssetAllocationData>(bundle, 'assetAllocation');
  const fire = entryData<FireProgressData>(bundle, 'fireProgress');
  const findEntry = (tool: string) => bundle.entries.find((e) => e.tool === tool);

  return (
    <div className="stack">
      {/* --- net worth ---------------------------------------------------- */}
      {nw && (
        <div className="card">
          <div className="figure-label">Net worth</div>
          <div className={`figure ${nw.netWorthCents < 0n ? 'negative' : ''}`}>
            {formatCents(nw.netWorthCents)}
          </div>
          <div className="figure-row" style={{ marginTop: 20 }}>
            <div>
              <div className="figure-label">Assets</div>
              <div className="figure-sm">{formatCents(nw.assetsCents)}</div>
            </div>
            <div>
              <div className="figure-label">Liabilities</div>
              <div className="figure-sm">{formatCents(nw.liabilitiesCents)}</div>
            </div>
          </div>
          <FigureEvidence entry={findEntry('netWorth')} />
        </div>
      )}

      {/* --- FIRE progress ------------------------------------------------ */}
      {fire ? (
        <div className="card">
          <h2>Progress toward financial independence</h2>
          <p className="card-sub">
            {fire.basis.kind === 'multiple'
              ? `Target is ${fire.basis.multiple}× your annual spending.`
              : `Target assumes a ${(fire.basis.withdrawalRate * 100).toFixed(1)}% withdrawal rate.`}
          </p>
          <div className="figure">{percent(fire.progressBasisPoints)}</div>
          <div className="bar">
            <div
              className="bar-fill"
              style={{
                width: `${Math.min(100, basisPointsToPercent(fire.progressBasisPoints ?? 0))}%`,
              }}
            />
          </div>
          <div className="figure-row" style={{ marginTop: 16 }}>
            <div>
              <div className="figure-label">Investable now</div>
              <div className="figure-sm">{formatCents(fire.investableNetWorthCents)}</div>
            </div>
            <div>
              <div className="figure-label">Target</div>
              <div className="figure-sm">{formatCents(fire.targetCents)}</div>
            </div>
            <div>
              <div className="figure-label">Still to go</div>
              <div className="figure-sm">{formatCents(fire.shortfallCents)}</div>
            </div>
          </div>
          <FigureEvidence entry={findEntry('fireProgress')} />
          <SpendTarget current={formatCents(fire.annualSpendCents)} />
        </div>
      ) : (
        <div className="card">
          <h2>Progress toward financial independence</h2>
          <p className="card-sub">
            Tell Jolly roughly what you expect to spend in a year and this becomes a target
            you can track. Nothing else on this page depends on it.
          </p>
          <SpendTarget />
          {limitations.map((limitation, i) => (
            <LimitationStep limitation={limitation} key={i} />
          ))}
        </div>
      )}

      {/* --- allocation --------------------------------------------------- */}
      {allocation && allocation.buckets.length > 0 && (
        <div className="card">
          <h2>Asset allocation</h2>
          <p className="card-sub">
            Across {formatCents(allocation.totalValueCents)} of investment holdings.
          </p>
          <table>
            <thead>
              <tr>
                <th>Asset class</th>
                <th style={{ textAlign: 'right' }}>Value</th>
                <th style={{ textAlign: 'right' }}>Share</th>
              </tr>
            </thead>
            <tbody>
              {allocation.buckets.map((bucket) => (
                <tr key={bucket.assetClass}>
                  <td>{bucket.assetClass.replace('_', ' ')}</td>
                  <td className="num">{formatCents(bucket.valueCents)}</td>
                  <td className="num">{percent(bucket.shareBasisPoints)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <FigureEvidence entry={findEntry('assetAllocation')} />
        </div>
      )}

      {/* --- accounts ----------------------------------------------------- */}
      {nw && accounts && (
        <div className="card">
          <h2>Accounts</h2>
          <p className="card-sub">
            {accounts.accounts.length} account(s) across {accounts.institutions.length}{' '}
            institution(s).
          </p>
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th style={{ textAlign: 'right' }}>Contribution</th>
              </tr>
            </thead>
            <tbody>
              {nw.lines.map((line) => (
                <tr key={line.accountId}>
                  <td>
                    {line.name}
                    {line.mask && <span className="faint"> ····{line.mask}</span>}
                    <SourceBadge source={line.source} />
                    {line.institutionName && (
                      <div className="faint">{line.institutionName}</div>
                    )}
                  </td>
                  <td className="muted">{line.subtype ?? line.type}</td>
                  <td className={`num ${line.contributionCents < 0n ? 'error' : ''}`}>
                    {formatCents(line.contributionCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-actions" style={{ marginTop: 18 }}>
            <ConnectBank hasAccounts />
            <Link className="btn" href="/accounts/new">
              Add an account by hand
            </Link>
          </div>
        </div>
      )}

      <EvidenceCard
        bundle={bundle}
        limitations={limitations}
        label="How this whole summary was worked out"
      />

      {/*
        What the page itself cost (§0.2). Built after the workflow has run so it
        includes the derived-aggregate write, and rendered beside the evidence
        card because "how this was worked out" and "what that took" are two
        halves of the same question.
      */}
      <NetworkPanel trace={ctx.trace.build()} label="What this page cost" />

      <Chat />
    </div>
  );
}
