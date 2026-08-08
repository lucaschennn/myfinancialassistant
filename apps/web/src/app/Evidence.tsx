/**
 * The §5 "why" card: the evidence bundle, rendered.
 *
 * This is the component that makes §0.2 visible. Every figure the app states
 * came from a tool result that carries provenance, and this is where a user can
 * open that up and see which accounts, as of when, and what arithmetic.
 *
 * Server component on purpose. The bundle contains bigint cents, which cannot
 * cross the RSC serialisation boundary — and shipping it to the client would
 * put raw financial data into a payload for no benefit, since none of this is
 * interactive beyond a <details> toggle the browser handles natively.
 */

import type { EvidenceBundle, EvidenceEntry, Limitation, Provenance } from '@pfg/core';

/** Human labels for tool names; the raw name is still shown in monospace. */
const TOOL_LABELS: Record<string, string> = {
  listAccounts: 'Listed your connected accounts',
  getBalances: 'Read current balances',
  getHoldings: 'Read investment holdings',
  getTransactions: 'Read transactions in range',
  netWorth: 'Computed net worth',
  assetAllocation: 'Computed asset allocation',
  fireProgress: 'Computed FIRE progress',
  cashFlow: 'Computed cash flow',
  savingsRate: 'Computed savings rate',
  spendingByCategory: 'Grouped spending by category',
  getUserContext: 'Read your profile and goals',
  getNetWorthHistory: 'Read stored net worth snapshots',
};

const SOURCE_LABELS: Record<Provenance['source'], string> = {
  plaid: 'plaid',
  db: 'stored',
  compute: 'computed',
  user: 'you',
};

function ProvenanceDetail({ provenance }: { provenance: Provenance }) {
  const asOf = new Date(provenance.asOf);
  return (
    <>
      <div className="prov">
        <span className="prov-source">{SOURCE_LABELS[provenance.source]}</span>
        {provenance.computation}
      </div>
      <div className="prov">
        As of {asOf.toLocaleString()}
        {provenance.accountIds && provenance.accountIds.length > 0 && (
          <> · {provenance.accountIds.length} account(s)</>
        )}
        {provenance.period && (
          <>
            {' '}
            · {provenance.period.from} to {provenance.period.to}
          </>
        )}
        {provenance.inputs && provenance.inputs.length > 0 && (
          <> · from {provenance.inputs.join(', ')}</>
        )}
      </div>
      {/*
        §6 honest-about-gaps. Notes are the place a figure admits it is less
        complete than it looks, so they are rendered, never collapsed away.

        They carry an explicit "Caveat" label rather than relying on colour.
        Previously the only thing distinguishing a caveat from the method above
        it was 12px gold text, which is both the least accessible way to encode
        meaning and easy to read as decoration — on the most important sentence
        on the card.
      */}
      {provenance.notes?.map((note, i) => (
        <div className="note" key={i}>
          <span className="note-tag">Caveat</span>
          {note}
        </div>
      ))}
    </>
  );
}

function Step({ entry }: { entry: EvidenceEntry }) {
  return (
    <div className="evidence-step">
      <div>
        <span className="tool-name">{entry.tool}</span>{' '}
        <span className="muted">— {TOOL_LABELS[entry.tool] ?? 'Ran a tool'}</span>
      </div>
      <ProvenanceDetail provenance={entry.provenance} />
    </div>
  );
}

/**
 * A step that could not run.
 *
 * Rendered with the same `tool-name` treatment as a successful step, so a gap
 * reads as part of the pipeline rather than as a footnote — "fireProgress ·
 * could not run" sits in the sequence where the step would have been. A bare
 * "not available" has no subject and tells the reader nothing.
 */
export function LimitationStep({ limitation }: { limitation: Limitation }) {
  return (
    <div className="evidence-step">
      <div>
        {limitation.tool ? (
          <>
            <span className="tool-name missing">{limitation.tool}</span>{' '}
            <span className="muted">— could not run</span>
          </>
        ) : (
          <span className="muted">About this answer</span>
        )}
      </div>
      <div className="note">
        <span className="note-tag">Gap</span>
        {limitation.reason}
      </div>
    </div>
  );
}

/**
 * The full pipeline behind an answer.
 *
 * `limitations` are surfaced above the steps rather than buried inside them:
 * a step that could not run at all is the most important thing on the card.
 */
export function EvidenceCard({
  bundle,
  limitations = [],
  label = 'How this was worked out',
}: {
  bundle: EvidenceBundle;
  limitations?: Limitation[];
  label?: string;
}) {
  return (
    <details className="evidence">
      <summary>
        {label} · {bundle.entries.length} step{bundle.entries.length === 1 ? '' : 's'}
      </summary>
      <div className="evidence-body">
        {limitations.map((limitation, i) => (
          <LimitationStep limitation={limitation} key={i} />
        ))}
        {bundle.entries.map((entry, i) => (
          <Step entry={entry} key={`${entry.tool}-${i}`} />
        ))}
      </div>
    </details>
  );
}

/**
 * A single figure's provenance, for attaching to one number rather than to a
 * whole answer.
 */
export function FigureEvidence({
  entry,
  label = 'Why this number',
}: {
  entry: EvidenceEntry | undefined;
  label?: string;
}) {
  if (!entry) return null;
  return (
    <details className="evidence">
      <summary>{label}</summary>
      <div className="evidence-body">
        <ProvenanceDetail provenance={entry.provenance} />
      </div>
    </details>
  );
}
