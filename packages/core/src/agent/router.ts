/**
 * The intent router's contract (§5).
 *
 * The router's only job is to pick one of six fixed workflows and pull out a
 * few parameters. It cannot invent a pipeline, because there is nothing here
 * that lets it name one — the schema below enumerates the options, so an
 * unknown workflow is a schema violation rather than a runtime surprise. That
 * is what §0.6 means by "the model's freedom is in narration, not in which
 * numbers exist".
 *
 * Relative dates are resolved here rather than in `core/compute`, per §4:
 * compute functions take an explicit `{ from, to }` and stay pure date-range-in,
 * figure-out. Turning "last month" into two ISO dates is language work, and it
 * belongs on this side of the line.
 */

import type { WorkflowName } from '../workflows/types.js';

/** The relative phrases the router may emit. Anything else is a schema error. */
export type RelativePeriod =
  | 'current_month'
  | 'last_month'
  | 'last_3_months'
  | 'last_6_months'
  | 'year_to_date'
  | 'last_12_months';

export interface RouterDecision {
  workflow: WorkflowName;
  /** Present only when the question is period-scoped. */
  period?: RelativePeriod;
  /** FIRE knobs, when the user names them explicitly. */
  multiple?: number;
  withdrawalRate?: number;
  /** Plain-language categories to filter on, for transaction lookups. */
  categories?: string[];
  /** One line on why this workflow — surfaced in the trace, not to the user. */
  reasoning?: string;
}

/**
 * JSON Schema for structured outputs. Using a schema rather than asking for
 * JSON in the prompt is the difference between "the router usually returns a
 * valid workflow" and "it cannot return anything else".
 */
export const ROUTER_SCHEMA = {
  type: 'object',
  properties: {
    workflow: {
      type: 'string',
      enum: [
        'summary_overview',
        'spending_analysis',
        'investment_review',
        'goal_progress',
        'transaction_lookup',
        'general_qa',
      ],
      description: 'Which fixed pipeline answers this question.',
    },
    period: {
      type: 'string',
      enum: [
        'current_month',
        'last_month',
        'last_3_months',
        'last_6_months',
        'year_to_date',
        'last_12_months',
      ],
      description:
        'The time range the question is about. Omit when the question is not about a period.',
    },
    multiple: {
      type: 'number',
      description: 'FIRE multiple, only when the person names one (e.g. "at 30x my spending").',
    },
    withdrawalRate: {
      type: 'number',
      description:
        'Withdrawal rate as a fraction, only when named (e.g. "the 4% rule" becomes 0.04).',
    },
    categories: {
      type: 'array',
      items: { type: 'string' },
      description: 'Spending categories named in the question, e.g. ["groceries", "travel"].',
    },
    reasoning: {
      type: 'string',
      description: 'One short sentence on why this workflow fits.',
    },
  },
  required: ['workflow'],
  additionalProperties: false,
} as const;

export const ROUTER_SYSTEM_PROMPT = `You classify a personal-finance question into exactly one workflow. You do not answer the question.

- summary_overview — overall position: net worth, "how am I doing", asset allocation and retirement progress together, or an opening question with no specific focus.
- spending_analysis — where money went, spending by category, cash flow, savings rate, "am I spending too much".
- investment_review — holdings, portfolio composition, diversification, what they own.
- goal_progress — progress toward retirement, financial independence, or a goal they have set. Also anything about their targets.
- transaction_lookup — finding specific transactions: a merchant, an amount, a date, "did I pay X".
- general_qa — conceptual or definitional questions that need no figures from their accounts ("what is a Roth IRA"), and anything that fits nothing above.

Rules:
- Pick the single best fit. When a question spans two, pick the one carrying its main intent.
- Set period only when the question is genuinely about a stretch of time. "How much did I spend on food?" implies a period; "what's my net worth" does not.
- Set multiple or withdrawalRate only when the person states a number themselves. Never supply a default.
- Prefer summary_overview when a question is broad or vague.`;

export interface Period {
  from: string;
  to: string;
}

const iso = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * `now` moved back `months`, clamped to the last valid day of the target month.
 *
 * The clamp is the whole point. `Date.UTC(2026, 1, 31)` — 31 February — does not
 * throw; it rolls forward to 3 March. So "the last 6 months" asked on 31 August
 * would start on 3 March: four days short, still labelled six months, and with
 * nothing in the provenance to say so (§0.2). The compute layer's own truncation
 * notes cannot catch it either — they only fire when a range exceeds the fetched
 * snapshot window, not when the range handed to them was wrong to begin with.
 *
 * Clamping gives 31 August → 28 February, the same convention `last_month`
 * already gets for free from its day-0 trick.
 */
function monthsBack(now: Date, months: number): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  // Day 0 of the month after the target is the target's own last day.
  const lastDayOfTarget = new Date(Date.UTC(year, month - months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - months, Math.min(now.getUTCDate(), lastDayOfTarget)));
}

/**
 * Turn a relative phrase into the explicit range `core/compute` requires.
 *
 * Built in UTC throughout. A boundary that shifts with the server's timezone
 * would make the same question return different figures depending on where the
 * function happened to run, which is the kind of nondeterminism that quietly
 * invalidates a provenance record.
 */
export function resolvePeriod(relative: RelativePeriod, now = new Date()): Period {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = iso(now);

  switch (relative) {
    case 'current_month':
      return { from: iso(new Date(Date.UTC(year, month, 1))), to: today };

    case 'last_month': {
      const first = new Date(Date.UTC(year, month - 1, 1));
      // Day 0 of this month is the last day of the previous one.
      const last = new Date(Date.UTC(year, month, 0));
      return { from: iso(first), to: iso(last) };
    }

    case 'last_3_months':
      return { from: iso(monthsBack(now, 3)), to: today };

    case 'last_6_months':
      return { from: iso(monthsBack(now, 6)), to: today };

    case 'year_to_date':
      return { from: iso(new Date(Date.UTC(year, 0, 1))), to: today };

    case 'last_12_months':
      return { from: iso(monthsBack(now, 12)), to: today };
  }
}

/**
 * The fallback when the router is unavailable or returns something unusable.
 *
 * `summary_overview` rather than an error: a broad, correct answer built from
 * the fixed pipeline is a better failure mode than a 500, and it is the same
 * workflow the router is told to prefer when a question is vague.
 */
export const FALLBACK_DECISION: RouterDecision = {
  workflow: 'summary_overview',
  reasoning: 'Routing was unavailable; fell back to the general summary.',
};

/**
 * Validate a decision that came back from the model.
 *
 * Structured outputs make the shape a guarantee, but this is the boundary
 * between a model and a pipeline that touches someone's financial data — worth
 * one explicit check rather than trusting the schema end to end.
 */
export function isRouterDecision(value: unknown): value is RouterDecision {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { workflow?: unknown };
  return (
    typeof candidate.workflow === 'string' &&
    (ROUTER_SCHEMA.properties.workflow.enum as readonly string[]).includes(candidate.workflow)
  );
}
