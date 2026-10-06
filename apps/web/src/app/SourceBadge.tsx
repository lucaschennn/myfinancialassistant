/**
 * Where an account's numbers come from, in words (§0.4, §7). A user must never
 * have to guess whether a figure came from their bank this morning or from a
 * statement they uploaded in August. Text, not colour alone.
 *
 * Takes only the source string, so it imports nothing at runtime from @pfg/core
 * and can be rendered from client components too.
 */

import type { SourceKind } from '@pfg/core';

const LABELS: Record<SourceKind, { text: string; title: string }> = {
  plaid: {
    text: 'Live · Plaid',
    title: 'Fetched from your bank through Plaid on this load. Never stored.',
  },
  manual: {
    text: 'Your records',
    title: 'From a statement, export, or entry you added. Stored encrypted, and deletable.',
  },
};

export function SourceBadge({ source }: { source: SourceKind }) {
  const label = LABELS[source];
  return (
    <span className={`source-badge source-${source}`} title={label.title}>
      {label.text}
    </span>
  );
}
