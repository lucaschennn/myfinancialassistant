'use client';

/**
 * Write surfaces for the context tools (§4) — goals and notes.
 *
 * All three of `setGoal`, `deleteGoal`, and `addNote` have existed in `core`
 * since Phase 0 with no way for a user to reach them. This is that way.
 *
 * Amounts stay strings all the way to the server, where `dollarsToCents` does
 * the one float conversion §0.3 allows.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const GOAL_TYPES = [
  { value: 'fire', label: 'Financial independence' },
  { value: 'emergency_fund', label: 'Emergency fund' },
  { value: 'debt_payoff', label: 'Debt payoff' },
  { value: 'savings_target', label: 'Savings target' },
  { value: 'custom', label: 'Something else' },
] as const;

export function AddGoalForm() {
  const router = useRouter();
  const [type, setType] = useState<string>('emergency_fund');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(amount.trim() ? { targetDollars: amount.trim() } : {}),
          ...(date ? { targetDate: date } : {}),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Could not save that goal.');
      }
      setLabel('');
      setAmount('');
      setDate('');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="field-row" onSubmit={submit}>
      <select value={type} onChange={(e) => setType(e.target.value)} disabled={busy} aria-label="Goal type">
        {GOAL_TYPES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Name (optional)"
        aria-label="Goal name"
        disabled={busy}
      />
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        placeholder="Target $ (optional)"
        aria-label="Target amount in dollars"
        disabled={busy}
      />
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        aria-label="Target date"
        disabled={busy}
      />
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Saving…' : 'Add goal'}
      </button>
      {error && (
        <p className="error" style={{ flexBasis: '100%', margin: 0 }}>
          {error}
        </p>
      )}
    </form>
  );
}

export function DeleteGoalButton({ goalId }: { goalId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      await fetch('/api/goals', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goalId }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button onClick={remove} disabled={busy}>
      {busy ? 'Removing…' : 'Remove'}
    </button>
  );
}

export function AddNoteForm() {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Could not save that note.');
      }
      setNote('');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="field-row" onSubmit={submit}>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Anything Jolly should know — a job change, a move, a plan…"
        aria-label="Note"
        disabled={busy}
      />
      <button type="submit" className="primary" disabled={busy || !note.trim()}>
        {busy ? 'Saving…' : 'Add note'}
      </button>
      {error && (
        <p className="error" style={{ flexBasis: '100%', margin: 0 }}>
          {error}
        </p>
      )}
    </form>
  );
}
