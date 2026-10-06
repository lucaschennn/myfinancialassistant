'use client';

/**
 * Editing one of your own accounts: record a newer (or corrected) balance, or
 * archive it. Amounts stay strings to the server (§0.3); the balance history
 * itself is rendered by the server page, already formatted.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function ManualAccountTools({ accountId, today }: { accountId: string; today: string }) {
  const router = useRouter();
  const [balance, setBalance] = useState('');
  const [asOfDate, setAsOfDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  async function post(path: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(json.error ?? 'That did not save.');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function record(event: React.FormEvent) {
    event.preventDefault();
    if (await post(`/api/manual-accounts/${accountId}/balances`, { balance, asOfDate })) {
      setBalance('');
      router.refresh();
    }
  }

  async function archive() {
    if (await post(`/api/manual-accounts/${accountId}/archive`)) {
      router.push('/accounts');
      router.refresh();
    }
  }

  return (
    <>
      <form className="form-grid" onSubmit={record}>
        <label htmlFor="bal-amount">New balance</label>
        <input
          id="bal-amount"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          inputMode="decimal"
          placeholder="4,182.09"
          disabled={busy}
        />
        <label htmlFor="bal-date">As of</label>
        <input
          id="bal-date"
          type="date"
          value={asOfDate}
          max={today}
          onChange={(e) => setAsOfDate(e.target.value)}
          disabled={busy}
        />
        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy || balance.trim() === ''}>
            Record balance
          </button>
          <span className="faint">Recording a date that already has a balance corrects it.</span>
        </div>
      </form>

      <div className="form-actions" style={{ marginTop: 22 }}>
        {confirmArchive ? (
          <>
            <span className="muted">
              Archive this account? It leaves your totals from now on; its history is kept.
            </span>
            <button type="button" onClick={archive} disabled={busy}>
              Archive
            </button>
            <button type="button" onClick={() => setConfirmArchive(false)} disabled={busy}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirmArchive(true)} disabled={busy}>
            Archive account…
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}
