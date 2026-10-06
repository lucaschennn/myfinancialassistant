/**
 * Every source in one place (Phase 2, PHASE-2-INGESTION §7): bank connections,
 * the accounts you keep yourself, and the documents behind them.
 *
 * The two kinds are kept visibly distinct (§0.4): a bank connection is read
 * live and nothing of it is stored; your own records are stored, encrypted,
 * because nothing else holds them. This page says which is which rather than
 * blurring them into "connected accounts".
 */

import { TraceRecorder, formatCents } from '@pfg/core';
import { listDocuments, readManualSource } from '@pfg/ingest';
import { listPlaidItems } from '@pfg/plaid';
import Link from 'next/link';
import { requireCtx } from '@/server/auth';
import { ConnectBank } from '../ConnectBank';
import { NetworkPanel } from '../NetworkPanel';
import { SourceBadge } from '../SourceBadge';
import { Disconnect } from './Disconnect';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, string> = {
  active: 'Connected',
  login_required: 'Needs you to sign in again',
  revoked: 'Revoked',
};

export default async function SourcesPage() {
  const ctx = await requireCtx();
  const trace = new TraceRecorder();
  const started = Date.now();

  // Postgres only — "what do I have?" should not cost a live bank fetch.
  const [items, manual, docs] = await Promise.all([
    trace.track('db', 'read bank connections', () => listPlaidItems(ctx.db, ctx.userId), (r) => ({ count: r.length })),
    readManualSource({ userId: ctx.userId, db: ctx.db, transactionWindow: null, includeHoldings: false, trace }),
    trace.track('db', 'read documents', () => listDocuments(ctx.db, ctx.userId), (r) => ({ count: r.length })),
  ]);
  trace.add({
    scope: 'internal',
    label: 'GET /sources',
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    ok: true,
    detail: 'server render',
  });

  const waiting = docs.filter((d) => d.status === 'needs_review').length;

  return (
    <div className="stack">
      <div className="card">
        <h2>
          Bank connections <SourceBadge source="plaid" />
        </h2>
        <p className="card-sub">
          Read live through Plaid each time you look, and never stored here. Disconnecting deletes
          the access we hold; there is no copy of the bank&apos;s data to delete.
        </p>
        {items.length === 0 ? (
          <p className="muted">No banks connected.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.institutionName ?? 'Unknown institution'}</td>
                    <td className="muted">{STATUS[item.status] ?? item.status}</td>
                    <td className="muted">since {item.createdAt.slice(0, 10)}</td>
                    <td>
                      <Disconnect itemId={item.id} institution={item.institutionName ?? 'this bank'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          <ConnectBank hasAccounts={items.length > 0} />
        </div>
      </div>

      <div className="card">
        <h2>
          Your own records <SourceBadge source="manual" />
        </h2>
        <p className="card-sub">
          Accounts you typed in or imported from statements. Stored encrypted, because no bank
          connection holds them, and each balance is as of its own date.
        </p>
        {manual.accounts.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th style={{ textAlign: 'right' }}>Latest balance</th>
                  <th>As of</th>
                </tr>
              </thead>
              <tbody>
                {manual.accounts.map((a) => (
                  <tr key={a.accountId}>
                    <td>
                      <Link href={`/accounts/${a.accountId}`}>{a.name}</Link>
                      {a.mask && <span className="muted"> ····{a.mask}</span>}
                    </td>
                    <td className="muted">{a.subtype ?? a.type}</td>
                    <td className="num">{a.currentCents !== null ? formatCents(a.currentCents) : '—'}</td>
                    <td className="muted">{a.currentCents !== null ? a.balanceAsOf.slice(0, 10) : 'no balance yet'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-actions" style={{ marginTop: 14 }}>
          <Link className="btn" href="/accounts/new">
            Add an account by hand
          </Link>
          <Link className="btn" href="/import">
            Import a statement
          </Link>
        </div>
      </div>

      <div className="card">
        <h2>Documents</h2>
        <p className="card-sub">
          {docs.length} uploaded{waiting > 0 ? `, ${waiting} waiting for your review` : ''}. The
          original files are kept encrypted so they can be re-read, and you can delete any of them.
        </p>
        <Link href="/import">Manage documents →</Link>
      </div>

      <NetworkPanel trace={trace.build()} label="What this page cost" />
    </div>
  );
}
