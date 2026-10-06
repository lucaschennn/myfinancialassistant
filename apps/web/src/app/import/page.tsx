/**
 * Import (Phase 2, §7b): upload a CSV export or a PDF statement, and every
 * document you have handed over with where it stands.
 *
 * Nothing uploaded reaches your records until you have reviewed it (§0.8).
 */

import { listDocuments } from '@pfg/ingest';
import Link from 'next/link';
import { requireCtx } from '@/server/auth';
import { UploadForm } from './UploadForm';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, string> = {
  uploaded: 'Uploaded',
  needs_review: 'Waiting for your review',
  committed: 'Imported',
  failed: 'Could not be read',
};

export default async function ImportPage() {
  const ctx = await requireCtx();
  const docs = await listDocuments(ctx.db, ctx.userId);

  return (
    <div className="stack">
      <div className="card">
        <h2>Import a statement</h2>
        <p className="card-sub">
          A CSV export from your bank, or a PDF statement. CSVs are read by code alone. A PDF is
          read by an AI model that may only copy figures exactly as printed; every figure it reports
          is checked against the statement&apos;s own text, and anything not found there is
          dropped and shown to you. Either way, nothing is added to your records until you have
          reviewed it. Files are stored encrypted, and you can delete them at any time.
        </p>
        <UploadForm />
        <p className="faint" style={{ marginTop: 14 }}>
          Scanned (image-only) PDFs are not read, because a figure guessed from pixels cannot be
          checked against anything. Spreadsheets need exporting as CSV first.
        </p>
      </div>

      <div className="card">
        <h2>Your documents</h2>
        {docs.length === 0 ? (
          <p className="muted">Nothing uploaded yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Kind</th>
                  <th>Uploaded</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/import/${d.id}`}>{d.filename ?? 'Untitled document'}</Link>
                    </td>
                    <td className="muted">{d.kind === 'pdf' ? `PDF${d.pageCount ? `, ${d.pageCount} pages` : ''}` : 'CSV'}</td>
                    <td className="muted">{d.uploadedAt.slice(0, 10)}</td>
                    <td>
                      <span className={`status-pill status-${d.status}`}>{STATUS[d.status] ?? d.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
