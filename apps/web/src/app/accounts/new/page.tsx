/**
 * Typed entry (Phase 2, §7b, PHASE-2-INGESTION §7). The always-works path into
 * the manual ledger: no bank connection, no document, just what you know.
 */

import Link from 'next/link';
import { requireUser } from '@/server/auth';
import { NewAccountForm } from './NewAccountForm';

export const dynamic = 'force-dynamic';

export default async function NewAccountPage() {
  await requireUser();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="stack">
      <div className="card">
        <p className="faint" style={{ marginBottom: 6 }}>
          <Link href="/accounts">← All accounts</Link>
        </p>
        <h2>Add an account by hand</h2>
        <p className="card-sub">
          For an account you have no bank connection or document for. It is kept with your own
          records, encrypted at rest, and you can archive it at any time. Its figures are labelled
          as yours wherever they appear, so they are never mistaken for a live balance.
        </p>
        <NewAccountForm today={today} />
      </div>
    </div>
  );
}
