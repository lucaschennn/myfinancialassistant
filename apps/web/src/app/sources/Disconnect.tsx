'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function Disconnect({ itemId, institution }: { itemId: string; institution: string }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    const response = await fetch(`/api/plaid/items/${itemId}/disconnect`, { method: 'POST' });
    const json = (await response.json().catch(() => ({}))) as { plaidNotified?: boolean; error?: string };
    if (!response.ok) {
      setMessage(json.error ?? 'Could not disconnect.');
      setBusy(false);
      return;
    }
    if (json.plaidNotified === false) {
      setMessage('Disconnected here. Plaid could not be told just now, but this app can no longer read the bank.');
    }
    router.refresh();
  }

  if (!confirm) {
    return (
      <button type="button" className="link-button" onClick={() => setConfirm(true)}>
        Disconnect
      </button>
    );
  }
  return (
    <span className="form-actions">
      <span className="muted">Stop reading {institution}?</span>
      <button type="button" disabled={busy} onClick={go}>
        Disconnect
      </button>
      <button type="button" disabled={busy} onClick={() => setConfirm(false)}>
        Cancel
      </button>
      {message && <span className="muted">{message}</span>}
    </span>
  );
}
