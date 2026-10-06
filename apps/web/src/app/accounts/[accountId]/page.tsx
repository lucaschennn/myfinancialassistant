/**
 * One account in full (§8 Phase 1.5-B/C).
 *
 * This is where the three datasets that were fetched-and-discarded on every
 * request finally have a surface: the individual holdings behind
 * `assetAllocation`, the securities they reference, and the transactions that
 * only ever reached the user through a chat answer.
 *
 * The transaction window is stated explicitly. A list that silently covers "the
 * last 90 days" invites the reader to conclude it is their whole history, which
 * is exactly the sort of quietly-incomplete figure §0.2 exists to prevent.
 */

import {
  type ManualBalancePoint,
  type SnapshotTransaction,
  formatCents,
  getBalances,
  getHoldings,
  getManualBalanceHistory,
  getTransactions,
} from '@pfg/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSnapshotCtx, traceRender } from '@/server/session';
import { FigureEvidence } from '../../Evidence';
import { NetworkPanel } from '../../NetworkPanel';
import { SourceBadge } from '../../SourceBadge';
import { ManualAccountTools } from './ManualAccountTools';

export const dynamic = 'force-dynamic';

function categoryLabel(transaction: SnapshotTransaction): string {
  const primary = transaction.category?.primary;
  if (!primary) return '—';
  return primary.toLowerCase().replace(/_/g, ' ');
}

export default async function AccountPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  const started = Date.now();
  const ctx = await requireSnapshotCtx({ transactionDays: 90 });

  const account = ctx.snapshot.accounts.find((a) => a.accountId === accountId);
  // A stale bookmark, or an account that vanished from the item since. Either
  // way it is a 404 rather than an empty page implying it exists but is blank.
  if (!account) notFound();

  const balanceResult = getBalances(ctx, { accountIds: [accountId] });
  const balance = balanceResult.data.balances[0];

  const holdingsResult = getHoldings(ctx, { accountIds: [accountId] });
  const { holdings, securities } = holdingsResult.data;
  const securityById = new Map(securities.map((s) => [s.securityId, s]));

  const window = ctx.snapshot.transactionWindow;
  const transactionsResult = window
    ? getTransactions(ctx, { from: window.from, to: window.to, accountIds: [accountId] })
    : null;
  const transactions = transactionsResult?.data.transactions ?? [];

  // An account from your own records has a real balance history (§3: a series,
  // not a column). A Plaid account has none by design — nothing of it is stored.
  let history: ManualBalancePoint[] = [];
  if (account.source === 'manual') {
    const read = () => getManualBalanceHistory(ctx, accountId);
    const result = await ctx.trace.track('db', 'read balance history', read, (r) => ({
      count: r.data.points.length,
    }));
    history = result.data.points;
  }
  traceRender(ctx, 'GET /accounts/[id]', started);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="stack">
      <div className="card">
        <p className="faint" style={{ marginBottom: 6 }}>
          <Link href="/accounts">← All accounts</Link>
        </p>
        <h2>
          {account.name}
          {account.mask && <span className="muted"> ····{account.mask}</span>}
          <SourceBadge source={account.source} />
        </h2>
        <p className="card-sub">
          {account.institutionName ?? 'Unknown institution'} · {account.subtype ?? account.type}
          {account.officialName && account.officialName !== account.name && (
            <> · {account.officialName}</>
          )}
        </p>

        <div className="figure-row" style={{ marginTop: 16 }}>
          <div>
            <div className="figure-label">Current</div>
            <div className="figure-sm">
              {balance?.currentCents != null ? formatCents(balance.currentCents) : '—'}
            </div>
          </div>
          <div>
            <div className="figure-label">Available</div>
            <div className="figure-sm">
              {balance?.availableCents != null ? formatCents(balance.availableCents) : '—'}
            </div>
          </div>
          <div>
            <div className="figure-label">As of</div>
            <div className="figure-sm">{account.balanceAsOf.slice(0, 10)}</div>
          </div>
          {balance?.limitCents != null && (
            <div>
              <div className="figure-label">Limit</div>
              <div className="figure-sm">{formatCents(balance.limitCents)}</div>
            </div>
          )}
        </div>
        <FigureEvidence entry={{ tool: 'getBalances', params: {}, data: null, provenance: balanceResult.provenance }} />
      </div>

      {account.source === 'manual' && (
        <div className="card">
          <h2>Balance history</h2>
          <p className="card-sub">
            Every balance recorded for this account, oldest first. The latest one is what your
            totals use. None of these came from a bank connection: each came from a statement you
            imported or a value you typed.
          </p>
          {history.length === 0 ? (
            <p className="muted">
              No balance recorded yet. Until one is, this account is left out of your totals.
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>As of</th>
                    <th>From</th>
                    <th style={{ textAlign: 'right' }}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((point) => (
                    <tr key={point.asOfDate}>
                      <td className="muted">{point.asOfDate}</td>
                      <td className="muted">
                        {point.documentKind === 'csv'
                          ? 'CSV import'
                          : point.documentKind === 'pdf'
                            ? 'PDF statement'
                            : 'Typed by you'}
                      </td>
                      <td className="num">{formatCents(point.currentCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ManualAccountTools accountId={accountId} today={today} />
        </div>
      )}

      {holdings.length > 0 && (
        <div className="card">
          <h2>Holdings</h2>
          <p className="card-sub">
            {holdings.length} position(s). These feed the asset allocation on your summary —
            until now they were fetched on every request and never shown.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Security</th>
                  <th>Type</th>
                  <th style={{ textAlign: 'right' }}>Quantity</th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((holding, i) => {
                  const security = securityById.get(holding.securityId);
                  return (
                    <tr key={`${holding.securityId}-${i}`}>
                      <td>
                        {security?.tickerSymbol && (
                          <span className="tool-name">{security.tickerSymbol} </span>
                        )}
                        {security?.name ?? 'Unknown security'}
                      </td>
                      <td className="muted">{security?.type ?? '—'}</td>
                      <td className="num muted">{holding.quantity}</td>
                      <td className="num">
                        {holding.valueCents != null ? formatCents(holding.valueCents) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <FigureEvidence entry={{ tool: 'getHoldings', params: {}, data: null, provenance: holdingsResult.provenance }} />
        </div>
      )}

      <div className="card">
        <h2>Transactions</h2>
        <p className="card-sub">
          {window
            ? `${transactions.length} transaction(s) between ${window.from} and ${window.to}. ` +
              'This is the period covered for this request, not your full history.'
            : 'No transaction period is covered by every one of your sources, so none are shown.'}
        </p>
        {transactions.length === 0 ? (
          <p className="muted">Nothing in this window.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((transaction) => (
                  <tr key={transaction.transactionId}>
                    <td className="muted">{transaction.date}</td>
                    <td>
                      {transaction.merchantName ?? transaction.name}
                      {transaction.pending && <span className="muted"> · pending</span>}
                    </td>
                    <td className="muted">{categoryLabel(transaction)}</td>
                    {/*
                      Plaid's sign convention is preserved rather than "fixed":
                      a positive amount is money leaving the account. Flipping it
                      here would make this table disagree with every figure
                      cashFlow produces from the same rows.
                    */}
                    <td className={`num ${transaction.amountCents < 0n ? 'positive' : ''}`}>
                      {formatCents(transaction.amountCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {transactionsResult && (
          <FigureEvidence
            entry={{
              tool: 'getTransactions',
              params: {},
              data: null,
              provenance: transactionsResult.provenance,
            }}
          />
        )}
      </div>

      <div className="card">
        <NetworkPanel trace={ctx.trace.build()} label="What this page cost" />
      </div>
    </div>
  );
}
