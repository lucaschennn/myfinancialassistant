'use client';

/**
 * Typed entry. Every amount stays a string until the server's `parseAmount`
 * turns it into cents (§0.3) — the browser never parses money.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const TYPES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'depository', label: 'Bank account', hint: 'Checking, savings, money market.' },
  { value: 'investment', label: 'Investment account', hint: 'Brokerage, 401(k), IRA.' },
  { value: 'credit', label: 'Credit card', hint: 'Enter what you owe as a positive number.' },
  { value: 'loan', label: 'Loan', hint: 'Mortgage, auto, student. Enter what you owe as a positive number.' },
  { value: 'other', label: 'Other asset', hint: 'A home or a vehicle. Counts toward net worth, not FIRE progress.' },
];

export function NewAccountForm({ today }: { today: string }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    type: 'depository',
    subtype: '',
    institutionName: '',
    mask: '',
    balance: '',
    asOfDate: today,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set =
    (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [key]: e.target.value });

  const typeHint = TYPES.find((t) => t.value === form.type)?.hint;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/manual-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          ...(form.subtype.trim() ? { subtype: form.subtype } : {}),
          ...(form.institutionName.trim() ? { institutionName: form.institutionName } : {}),
          ...(form.mask.trim() ? { mask: form.mask } : {}),
          ...(form.balance.trim() ? { balance: form.balance, asOfDate: form.asOfDate } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; accountId?: string };
      if (!response.ok || !body.accountId) throw new Error(body.error ?? 'Could not save that account.');
      router.push(`/accounts/${body.accountId}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setSaving(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      <label htmlFor="acct-name">Account name</label>
      <input id="acct-name" value={form.name} onChange={set('name')} placeholder="Credit Union Checking" required />

      <label htmlFor="acct-type">Kind of account</label>
      <div>
        <select id="acct-type" value={form.type} onChange={set('type')}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {typeHint && <p className="faint field-hint">{typeHint}</p>}
      </div>

      <label htmlFor="acct-subtype">
        Subtype <span className="faint">(optional)</span>
      </label>
      <input id="acct-subtype" value={form.subtype} onChange={set('subtype')} placeholder="checking, mortgage, 401k" />

      <label htmlFor="acct-inst">
        Institution <span className="faint">(optional)</span>
      </label>
      <input id="acct-inst" value={form.institutionName} onChange={set('institutionName')} placeholder="Hometown Credit Union" />

      <label htmlFor="acct-mask">
        Last 4 digits <span className="faint">(optional)</span>
      </label>
      <input id="acct-mask" value={form.mask} onChange={set('mask')} maxLength={4} inputMode="numeric" placeholder="4412" />

      <label htmlFor="acct-balance">
        Balance <span className="faint">(optional)</span>
      </label>
      <input id="acct-balance" value={form.balance} onChange={set('balance')} inputMode="decimal" placeholder="4,182.09" />

      <label htmlFor="acct-date">Balance as of</label>
      <div>
        <input id="acct-date" type="date" value={form.asOfDate} max={today} onChange={set('asOfDate')} />
        <p className="faint field-hint">
          Use the statement date, not today, if you are copying from a statement. Older balances
          are labelled with their date wherever they appear.
        </p>
      </div>

      <div className="form-actions">
        <button type="submit" className="primary" disabled={saving || form.name.trim() === ''}>
          {saving ? 'Saving…' : 'Add account'}
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </form>
  );
}
