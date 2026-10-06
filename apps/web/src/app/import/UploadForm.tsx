'use client';

/**
 * Upload a CSV export or a PDF statement. The file goes to the server as-is;
 * nothing is parsed here. A PDF takes longer because one model call reads it,
 * and the network panel afterwards says so.
 */

import type { NetworkTrace } from '@pfg/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { NetworkPanel } from '../NetworkPanel';

type UploadResponse =
  | { outcome: 'created' | 'duplicate'; documentId: string; status: string; committedAt?: string | null; trace: NetworkTrace }
  | { error: string };

export function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [trace, setTrace] = useState<NetworkTrace | null>(null);

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setMessage(null);
    setTrace(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch('/api/documents', { method: 'POST', body });
      const json = (await response.json().catch(() => ({ error: 'The upload did not complete.' }))) as UploadResponse;
      if (!response.ok || 'error' in json) throw new Error('error' in json ? json.error : 'The upload did not complete.');
      setTrace(json.trace);
      if (json.outcome === 'duplicate') {
        setMessage(
          json.status === 'committed'
            ? 'You have already imported this exact file, so it was not added again. Nothing was double-counted.'
            : 'You have already uploaded this exact file. Opening the one you have.',
        );
        if (json.status !== 'committed') router.push(`/import/${json.documentId}`);
        setBusy(false);
        return;
      }
      router.push(`/import/${json.documentId}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <>
      <form className="field-row" onSubmit={upload}>
        <input
          type="file"
          accept=".csv,.pdf,text/csv,application/pdf"
          aria-label="CSV export or PDF statement"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || !file}>
          {busy ? (file?.name.toLowerCase().endsWith('.pdf') ? 'Reading the statement…' : 'Uploading…') : 'Upload'}
        </button>
      </form>
      {message && <p className="muted" style={{ marginTop: 10 }}>{message}</p>}
      {trace && <NetworkPanel trace={trace} label="What that upload cost" />}
    </>
  );
}
