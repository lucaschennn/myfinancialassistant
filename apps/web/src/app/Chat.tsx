'use client';

/**
 * The chat surface, with a "why" card attached to every answer (§5, §8).
 *
 * The evidence rendered here is provenance only — tool, source, timing,
 * computation, caveats. The bundle's `data` carries bigint cents that do not
 * survive JSON, and more to the point there is no reason to ship raw figures
 * to the browser when the answer already states the ones that matter.
 */

import { useRef, useState } from 'react';
import type { Limitation, NetworkTrace, Provenance } from '@pfg/core';
import { NetworkPanel } from './NetworkPanel';
import { RichText } from './RichText';

interface WireEntry {
  tool: string;
  params: Record<string, unknown>;
  provenance: Provenance;
}

interface WireBundle {
  workflow: string;
  generatedAt: string;
  entries: WireEntry[];
}

interface Answer {
  answer: string;
  workflow: string;
  bundle: WireBundle;
  limitations: Limitation[];
  attributionWarnings: string[];
  attributionOutcome: 'clean' | 'retried' | 'withheld';
  trace: NetworkTrace;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  evidence?: Answer;
}

const SOURCE_LABELS: Record<string, string> = {
  plaid: 'plaid',
  db: 'stored',
  compute: 'computed',
  user: 'you',
};

const WORKFLOW_LABELS: Record<string, string> = {
  summary_overview: 'Overall summary',
  spending_analysis: 'Spending analysis',
  investment_review: 'Investment review',
  goal_progress: 'Goal progress',
  transaction_lookup: 'Transaction lookup',
  general_qa: 'General question',
};

function EvidenceCard({ answer }: { answer: Answer }) {
  const { bundle, limitations, attributionWarnings, attributionOutcome } = answer;
  const withheld = attributionOutcome === 'withheld';

  return (
    <details className="evidence">
      <summary>
        {WORKFLOW_LABELS[answer.workflow] ?? answer.workflow} · {bundle.entries.length} step
        {bundle.entries.length === 1 ? '' : 's'}
      </summary>
      <div className="evidence-body">
        {/*
          Two different events, and conflating them misleads. `withheld` means
          nothing above can be trusted — the model twice stated a figure the
          tools never produced (§0.1) and the answer was replaced. `retried`
          means the guard worked: a bad draft was thrown away and the text above
          is a rewrite that passed. Labelling the second "held back" describes
          the user's own screen inaccurately, which is the one thing a
          transparency card cannot afford to do.
        */}
        {attributionOutcome !== 'clean' && (
          <div className="evidence-step">
            <div className="tool-name">
              {withheld ? 'answer held back' : 'draft discarded, answer rewritten'}
            </div>
            <div className="note">
              {withheld
                ? 'Two drafts in a row stated figures that could not be traced to your ' +
                  'accounts, so the answer was withheld rather than shown to you.'
                : 'What you are reading is a rewrite that passed the check. The discarded ' +
                  'draft was never shown.'}
            </div>
            {attributionWarnings.map((warning, i) => (
              <div className="note" key={i}>
                {warning}
              </div>
            ))}
          </div>
        )}
        {limitations.map((limitation, i) => (
          <div className="evidence-step" key={i}>
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
        ))}
        {bundle.entries.map((entry, i) => (
          <div className="evidence-step" key={`${entry.tool}-${i}`}>
            <div>
              <span className="tool-name">{entry.tool}</span>
            </div>
            <div className="prov">
              <span className="prov-source">
                {SOURCE_LABELS[entry.provenance.source] ?? entry.provenance.source}
              </span>
              {entry.provenance.computation}
            </div>
            <div className="prov">
              As of {new Date(entry.provenance.asOf).toLocaleString()}
              {entry.provenance.accountIds && entry.provenance.accountIds.length > 0 && (
                <> · {entry.provenance.accountIds.length} account(s)</>
              )}
              {entry.provenance.period && (
                <>
                  {' '}
                  · {entry.provenance.period.from} to {entry.provenance.period.to}
                </>
              )}
            </div>
            {entry.provenance.notes?.map((note, n) => (
              <div className="note" key={n}>
                <span className="note-tag">Caveat</span>
                {note}
              </div>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

const SUGGESTIONS = [
  'How am I doing overall?',
  'Where did my money go last month?',
  'What do I actually own?',
];

export function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function ask(question: string) {
    if (!question.trim() || busy) return;

    setError(null);
    setBusy(true);
    setInput('');

    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((prior) => [...prior, { role: 'user', content: question }]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Something went wrong.');
      }

      const answer = (await response.json()) as Answer;
      setTurns((prior) => [
        ...prior,
        { role: 'assistant', content: answer.answer, evidence: answer },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="card">
      <h2>Ask Jolly</h2>
      <p className="card-sub">
        Every answer is built from your live account data, and every figure can be traced back
        to the tool that produced it.
      </p>

      {turns.length === 0 && !busy && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {SUGGESTIONS.map((suggestion) => (
            <button key={suggestion} onClick={() => void ask(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {turns.map((turn, i) => (
        <div className="turn" key={i}>
          <div className="turn-role">{turn.role === 'user' ? 'You' : 'Jolly'}</div>
          <div className="turn-body">
            <RichText>{turn.content}</RichText>
          </div>
          {turn.evidence && (
            <>
              <EvidenceCard answer={turn.evidence} />
              {/* What the answer cost, next to how it was worked out (§0.2). */}
              {turn.evidence.trace && (
                <NetworkPanel trace={turn.evidence.trace} label="What this answer cost" />
              )}
            </>
          )}
        </div>
      ))}

      {busy && (
        <div className="turn">
          <div className="turn-role">Jolly</div>
          <div className="muted">Reading your accounts…</div>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your money…"
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || !input.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}
