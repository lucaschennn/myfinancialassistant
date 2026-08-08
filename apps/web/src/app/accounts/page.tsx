/**
 * Every connected account, grouped by institution (§8 Phase 1.5-B/C).
 *
 * Balances were previously only reachable as an aggregate — net worth, or a
 * row in the summary's account list with no figure attached. This is the first
 * surface that shows what each account actually holds, and the first that shows
 * `snapshot.gaps` as something other than prose buried in a provenance note.
 *
 * Holdings are skipped on this page: it is a list, and the per-account page is
 * where positions belong.
 */

import {
  type GetBalancesData,
  type ListAccountsData,
  formatCents,
  getBalances,
  listAccounts,
} from '@pfg/core';
import Link from 'next/link';
import { requireUser } from '@/server/auth';
import { hasLinkedItems, requireSnapshotCtx, traceRender } from '@/server/session';
import { ConnectBank } from '../ConnectBank';
import { FigureEvidence } from '../Evidence';
import { NetworkPanel } from '../NetworkPanel';

export const dynamic = 'force-dynamic';

export default async function AccountsPage() {
  const user = await requireUser();

  if (!(await hasLinkedItems(user.id))) {
    return (
      <div className="card">
        <h2>Nothing connected yet</h2>
        <p className="card-sub">Connect an institution and its accounts will appear here.</p>
        <ConnectBank hasAccounts={false} />
      </div>
    );
  }

  // Holdings are not needed for a list view, and skipping them removes a Plaid
  // round trip from every load of this page (§7 — the fetch is the slow part).
  const started = Date.now();
  const ctx = await requireSnapshotCtx({ includeTransactions: false, includeHoldings: false });
  const accounts: ListAccountsData = listAccounts(ctx).data;
  const balancesResult = getBalances(ctx, {});
  const balances: GetBalancesData = balancesResult.data;
  traceRender(ctx, 'GET /accounts', started);

  const byId = new Map(balances.balances.map((b) => [b.accountId, b]));
  const institutions = [...new Set(accounts.accounts.map((a) => a.institutionName ?? 'Unknown'))];

  return (
    <div className="stack">
      <div className="card">
        <h2>Connected accounts</h2>
        <p className="card-sub">
          {accounts.accounts.length} account(s) across {institutions.length} institution(s),
          read live from Plaid just now. Balances are shown exactly as your institution
          reports them — a card balance is what you owe, not a negative number.
        </p>
        <ConnectBank hasAccounts />
      </div>

      {/*
        §6 honest-about-gaps, promoted from a provenance note to its own card.
        An institution that failed to respond is the most important thing on
        this page when it happens, and it used to be one sentence inside a
        collapsed panel.
      */}
      {ctx.snapshot.gaps.length > 0 && (
        <div className="card">
          <h2>Missing data</h2>
          <p className="card-sub">
            These did not come back from Plaid on this load, so anything computed from them
            is incomplete.
          </p>
          {ctx.snapshot.gaps.map((gap, i) => (
            <div className="note" key={i}>
              <span className="note-tag">Gap</span>
              {gap.institutionName ?? gap.itemId} — {gap.dataset} unavailable: {gap.reason}
            </div>
          ))}
        </div>
      )}

      {institutions.map((institution) => {
        const rows = accounts.accounts.filter(
          (a) => (a.institutionName ?? 'Unknown') === institution,
        );
        return (
          <div className="card" key={institution}>
            <h2>{institution}</h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Type</th>
                    <th style={{ textAlign: 'right' }}>Current</th>
                    <th style={{ textAlign: 'right' }}>Available</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((account) => {
                    const balance = byId.get(account.accountId);
                    return (
                      <tr key={account.accountId}>
                        <td>
                          <Link href={`/accounts/${account.accountId}`}>{account.name}</Link>
                          {account.mask && <span className="muted"> ····{account.mask}</span>}
                        </td>
                        <td className="muted">
                          {account.subtype ?? account.type}
                        </td>
                        <td className="num">
                          {balance?.currentCents !== null && balance?.currentCents !== undefined
                            ? formatCents(balance.currentCents)
                            : '—'}
                        </td>
                        <td className="num muted">
                          {balance?.availableCents !== null && balance?.availableCents !== undefined
                            ? formatCents(balance.availableCents)
                            : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <div className="card">
        <FigureEvidence
          entry={{
            tool: 'getBalances',
            params: {},
            data: null,
            provenance: balancesResult.provenance,
          }}
          label="Where these balances came from"
        />
        <NetworkPanel trace={ctx.trace.build()} label="What this page cost" />
      </div>
    </div>
  );
}
