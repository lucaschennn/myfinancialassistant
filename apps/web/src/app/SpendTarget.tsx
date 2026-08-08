'use client';

/**
 * Setting the annual spend target that `fireProgress` runs on.
 *
 * Deliberately rendered inside the FIRE card rather than on a separate settings
 * page: the figure is missing exactly where the limitation is displayed, so the
 * fix belongs in the same place as the explanation of why it is needed. A new
 * user should never have to go looking for it.
 *
 * The input stays a string the whole way to the server. Turning it into a number
 * here would put a float conversion in the browser, outside the one function
 * §0.3 permits to do it.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SpendTarget({ current }: { current?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(current === undefined);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus('saving');
    setMessage(null);
    try {
      const response = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetAnnualSpendDollars: value }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        targetAnnualSpend?: string | null;
      };
      if (!response.ok) throw new Error(body.error ?? 'Could not save your spend target.');

      setStatus('idle');
      setValue('');
      setOpen(false);
      // The dashboard is a server component that re-runs the whole
      // `summary_overview` pipeline; refreshing re-derives the FIRE figures from
      // it rather than us computing anything client-side.
      router.refresh();
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Something went wrong.');
    }
  }

  if (!open) {
    return (
      <p className="faint" style={{ marginTop: 12 }}>
        Target based on {current} of annual spending.{' '}
        <button
          onClick={() => setOpen(true)}
          style={{
            font: 'inherit',
            padding: 0,
            border: 'none',
            background: 'none',
            color: 'inherit',
            textDecoration: 'underline',
            cursor: 'pointer',
          }}
        >
          Change
        </button>
      </p>
    );
  }

  return (
    <form className="field-row" onSubmit={save} style={{ marginTop: 14 }}>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Annual spending, e.g. 60000"
        aria-label="Target annual spending in dollars"
        disabled={status === 'saving'}
      />
      <button type="submit" className="primary" disabled={status === 'saving' || value.trim() === ''}>
        {status === 'saving' ? 'Saving…' : 'Save'}
      </button>
      {current !== undefined && (
        <button type="button" onClick={() => setOpen(false)} disabled={status === 'saving'}>
          Cancel
        </button>
      )}
      {message && (
        <p className="error" style={{ flexBasis: '100%', margin: 0 }}>
          {message}
        </p>
      )}
    </form>
  );
}
