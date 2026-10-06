/**
 * One uploaded document: its review screen while it awaits review, what became
 * of it once imported, or why it could not be read.
 */

import { TraceRecorder } from '@pfg/core';
import { DocumentNotFoundError, listManualAccountChoices, loadReview } from '@pfg/ingest';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCtx } from '@/server/auth';
import { NetworkPanel } from '../../NetworkPanel';
import { DocumentActions } from './DocumentActions';
import { ReviewScreen } from './ReviewScreen';

export const dynamic = 'force-dynamic';

export default async function DocumentPage({ params }: { params: Promise<{ documentId: string }> }) {
  const ctx = await requireCtx();
  const { documentId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) notFound();

  const trace = new TraceRecorder();
  let review;
  try {
    review = await loadReview({ db: ctx.db, userId: ctx.userId, documentId, trace });
  } catch (error) {
    if (error instanceof DocumentNotFoundError) notFound();
    throw error;
  }
  const { document, view } = review;

  const header = (
    <div className="card">
      <p className="faint" style={{ marginBottom: 6 }}>
        <Link href="/import">← All documents</Link>
      </p>
      <h2>{document.filename ?? 'Untitled document'}</h2>
      <p className="card-sub">
        {document.kind === 'pdf' ? `PDF statement${document.pageCount ? `, ${document.pageCount} pages` : ''}` : 'CSV export'} ·
        uploaded {document.uploadedAt.slice(0, 10)}
        {document.committedAt ? ` · imported ${document.committedAt.slice(0, 10)}` : ''}
      </p>
    </div>
  );

  if (document.status === 'needs_review' && view) {
    const accounts = await listManualAccountChoices(ctx.db, ctx.userId);
    return (
      <div className="stack">
        {header}
        <ReviewScreen initial={view} accounts={accounts} initialTrace={trace.build()} />
      </div>
    );
  }

  if (document.status === 'failed') {
    return (
      <div className="stack">
        {header}
        <div className="card">
          <h2>This document could not be read</h2>
          <p>{document.failureReason}</p>
          <p className="card-sub">
            Nothing from it was added to your records. Remove it, and try again or add the account
            by hand.
          </p>
          <div className="form-actions">
            <DocumentActions documentId={document.id} committed={false} />
            <Link className="btn" href="/accounts/new">
              Add an account by hand
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {header}
      <div className="card">
        <h2>Imported</h2>
        <p className="card-sub">
          The balances and transactions from this document are part of your records and appear on
          your accounts, labelled as yours. Its review draft was cleared once imported.
        </p>
        <p>
          <Link href="/accounts">See your accounts →</Link>
        </p>
        <DocumentActions documentId={document.id} committed />
        <NetworkPanel trace={trace.build()} label="What this page cost" />
      </div>
    </div>
  );
}
