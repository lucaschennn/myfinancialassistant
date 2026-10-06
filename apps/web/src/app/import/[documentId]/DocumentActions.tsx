'use client';

/**
 * Removing a document. Before import it is simply thrown away. After import the
 * choice is explicit (§3): keep the rows it added as your own entries, or drop
 * them with it. The original file is deleted either way.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function DocumentActions({ documentId, committed }: { documentId: string; committed: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState<'idle' | 'confirm'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok) {
      router.push('/import');
      router.refresh();
    } else {
      setError('That did not work. Try again.');
      setBusy(false);
    }
  }

  if (!committed) {
    return (
      <div className="form-actions">
        <button type="button" disabled={busy} onClick={() => go(`/api/documents/${documentId}/reject`)}>
          Remove this document
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  if (stage === 'idle') {
    return (
      <div className="form-actions">
        <button type="button" onClick={() => setStage('confirm')}>
          Delete this document…
        </button>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="muted">
        The original file will be deleted. What should happen to the balances and transactions it
        added to your records?
      </p>
      <div className="form-actions">
        <button type="button" disabled={busy} onClick={() => go(`/api/documents/${documentId}/delete`, { ledger: 'keep' })}>
          Keep them as my own entries
        </button>
        <button type="button" disabled={busy} onClick={() => go(`/api/documents/${documentId}/delete`, { ledger: 'drop' })}>
          Remove them too
        </button>
        <button type="button" disabled={busy} onClick={() => setStage('idle')}>
          Cancel
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
