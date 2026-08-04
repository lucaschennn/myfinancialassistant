'use client';

/**
 * The §7.1 Link flow, client half.
 *
 * Bank credentials are entered inside Plaid's own iframe and never touch this
 * app — the only thing that comes back is a short-lived public token, which we
 * immediately hand to the server to exchange (§9: no bank credentials stored,
 * ever).
 */

import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { useRouter } from 'next/navigation';

export function ConnectBank({ hasAccounts }: { hasAccounts: boolean }) {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'exchanging' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  // Fetch a Link token on mount so the button is ready when clicked. Tokens are
  // short-lived, which is fine — this page is not left open for hours.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/plaid/link-token', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('link-token failed'))))
      .then((data: { linkToken: string }) => {
        if (!cancelled) setLinkToken(data.linkToken);
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('error');
          setMessage('Could not reach Plaid. Check PLAID_CLIENT_ID and PLAID_SECRET.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSuccess = useCallback(
    async (publicToken: string) => {
      setStatus('exchanging');
      setMessage(null);
      try {
        const response = await fetch('/api/plaid/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicToken }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? 'Exchange failed.');
        }
        const result = (await response.json()) as {
          institutionName: string | null;
          accountCount: number;
        };
        setStatus('idle');
        setMessage(
          `Connected ${result.institutionName ?? 'your institution'} — ${result.accountCount} account(s).`,
        );
        // The dashboard is a server component reading live Plaid data; refresh
        // re-runs it rather than us duplicating the fetch on the client.
        router.refresh();
      } catch (error) {
        setStatus('error');
        setMessage(error instanceof Error ? error.message : 'Something went wrong.');
      }
    },
    [router],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    // Plaid types the public token as nullable — a Link flow can complete
    // without one (e.g. an OAuth handoff that ends early). Nothing to exchange
    // in that case, so treat it as a no-op rather than posting an empty token.
    onSuccess: (publicToken) => {
      if (!publicToken) return;
      void onSuccess(publicToken);
    },
  });

  const busy = status === 'exchanging';

  return (
    <div>
      <button
        className={hasAccounts ? '' : 'primary'}
        onClick={() => open()}
        disabled={!ready || !linkToken || busy}
      >
        {busy ? 'Connecting…' : hasAccounts ? 'Connect another institution' : 'Connect a bank'}
      </button>
      {message && (
        <p className={status === 'error' ? 'error' : 'faint'} style={{ marginTop: 10 }}>
          {message}
        </p>
      )}
    </div>
  );
}
