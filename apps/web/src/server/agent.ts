/**
 * The agent loop (§1): intent router → workflow executor → synthesis.
 *
 * Model roles are the ones §2 fixes: Haiku classifies, Sonnet narrates. The
 * executor in between is entirely deterministic — it is the same code path the
 * Checkpoint 0 test drives, so the figures a user reads in chat are produced by
 * the pipeline that has been under test since Phase 0.
 *
 * Two design points worth stating outright:
 *
 *  1. The router picks a workflow; it never picks tools. A workflow's tool
 *     sequence is fixed in `core` (§5), so the widest possible routing mistake
 *     is answering the wrong question — never computing a figure the wrong way.
 *
 *  2. Synthesis is streamed from Anthropic but NOT streamed to the browser.
 *     §2 asks for streaming, and streaming to the SDK is what actually solves
 *     the problem it names — long generations timing out a serverless
 *     invocation. Streaming onward to the client would mean the user reads
 *     figures before `checkAttribution()` has seen them, and an unverified
 *     figure on screen cannot be recalled. §0.1 outranks the typing effect.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  type Ctx,
  type SessionSnapshot,
  type EvidenceBundle,
  type Limitation,
  type RouterDecision,
  type TraceRecorder,
  type WorkflowName,
  type WorkflowParams,
  FALLBACK_DECISION,
  JOLLY_SYSTEM_PROMPT,
  ROUTER_SCHEMA,
  ROUTER_SYSTEM_PROMPT,
  UnknownWorkflowError,
  attributionFailureMessage,
  attributionRetryTurn,
  checkAttribution,
  implementedWorkflows,
  isRouterDecision,
  resolvePeriod,
  runWorkflow,
  synthesisUserTurn,
} from '@pfg/core';

/**
 * The agent loop needs a ctx carrying live Plaid data, and nothing more. It
 * deliberately does NOT import the Clerk-backed session helper: keeping the
 * dependency pointed at `core` means this module can be driven directly by a
 * script (`npm run agent:smoke`) as well as by a request, which is what makes
 * the loop testable against the sandbox without standing up auth.
 */
export type AgentCtx = Ctx & { snapshot: SessionSnapshot };

/** §2: Haiku for intent classification, Sonnet for synthesis. */
const ROUTER_MODEL = 'claude-haiku-4-5';
const SYNTHESIS_MODEL = 'claude-sonnet-5';

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — the agent loop cannot run without it.');
  }
  client ??= new Anthropic();
  return client;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * What the §0.1 guard did on this turn.
 *
 * `retried` and `withheld` are very different events and were previously
 * indistinguishable to the caller, which left the UI describing a rewritten
 * answer as "held back" — a claim about text the user was, in fact, reading.
 */
export type AttributionOutcome = 'clean' | 'retried' | 'withheld';

export interface AgentResult {
  answer: string;
  workflow: WorkflowName;
  bundle: EvidenceBundle;
  limitations: Limitation[];
  /** One entry per rejected draft. Empty on a clean turn. */
  attributionWarnings: string[];
  /** Whether `answer` is the first draft, a rewrite, or the refusal message. */
  attributionOutcome: AttributionOutcome;
  routedBy: 'model' | 'fallback';
}

/**
 * Classify the question into one of the six §5 workflows.
 *
 * Structured outputs make the workflow name a schema constraint rather than a
 * prompt request — the model cannot return a pipeline that does not exist.
 * A routing failure degrades to `summary_overview` instead of throwing: a
 * correct broad answer beats a 500, and it matches what the router is told to
 * do with a vague question anyway.
 */
export async function route(
  question: string,
  history: ChatTurn[] = [],
  trace?: TraceRecorder,
): Promise<{
  decision: RouterDecision;
  routedBy: 'model' | 'fallback';
}> {
  const call = () =>
    anthropic().messages.create({
      model: ROUTER_MODEL,
      max_tokens: 256,
      system: ROUTER_SYSTEM_PROMPT,
      output_config: {
        format: { type: 'json_schema', schema: ROUTER_SCHEMA },
      },
      messages: [
        // Recent turns only — routing depends on what was just discussed
        // ("and last month?"), not on the whole conversation.
        ...history.slice(-4).map((turn) => ({ role: turn.role, content: turn.content })),
        { role: 'user' as const, content: question },
      ],
    });

  try {
    const response = trace
      ? await trace.track('anthropic', ROUTER_MODEL, call, () => ({ detail: 'intent routing' }))
      : await call();

    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return { decision: FALLBACK_DECISION, routedBy: 'fallback' };

    const parsed: unknown = JSON.parse(block.text);
    if (!isRouterDecision(parsed)) return { decision: FALLBACK_DECISION, routedBy: 'fallback' };

    return { decision: parsed, routedBy: 'model' };
  } catch (error) {
    console.error('[agent] routing failed, falling back to summary_overview:', error);
    return { decision: FALLBACK_DECISION, routedBy: 'fallback' };
  }
}

/**
 * Translate a router decision into executor params.
 *
 * This is where relative language becomes explicit dates (§4) — compute
 * functions never see the word "last month".
 */
export function toWorkflowParams(decision: RouterDecision, now = new Date()): WorkflowParams {
  return {
    ...(decision.period ? { period: resolvePeriod(decision.period, now) } : {}),
    ...(decision.categories ? { categories: decision.categories } : {}),
    ...(decision.multiple !== undefined ? { multiple: decision.multiple } : {}),
    ...(decision.withdrawalRate !== undefined ? { withdrawalRate: decision.withdrawalRate } : {}),
  };
}

/**
 * Narrate the evidence bundle.
 *
 * The attribution guard runs on the draft before it is returned. On a
 * violation the model gets exactly one correction naming the offending
 * figures; if the second attempt also fails, the answer is withheld. A model
 * that has twice stated untraceable numbers should not get a third try at the
 * user's screen — and silently showing them would make §0.1 a slogan.
 */
async function synthesise(
  question: string,
  bundle: EvidenceBundle,
  limitations: Limitation[],
  history: ChatTurn[],
  trace?: TraceRecorder,
): Promise<{ answer: string; warnings: string[]; outcome: AttributionOutcome }> {
  const warnings: string[] = [];

  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-6).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: synthesisUserTurn({ question, bundle, limitations }) },
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Streamed to avoid a serverless HTTP timeout on a long generation (§2);
    // buffered here so the guard sees the whole answer before the user does.
    const call = () =>
      anthropic()
        .messages.stream({
          model: SYNTHESIS_MODEL,
          max_tokens: 4096,
          system: JOLLY_SYSTEM_PROMPT,
          messages,
        })
        .finalMessage();

    // The retry is disclosed rather than folded into one entry: §0.1's guard
    // can double the cost of a turn, and a user looking at what their question
    // cost should see that happen.
    const message = trace
      ? await trace.track('anthropic', SYNTHESIS_MODEL, call, () => ({
          detail: attempt === 0 ? 'synthesis' : 'synthesis retry (attribution guard)',
        }))
      : await call();

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    const report = checkAttribution(text, bundle);
    if (report.ok) {
      return { answer: text, warnings, outcome: attempt === 0 ? 'clean' : 'retried' };
    }

    const figures = report.violations.map((v) => v.figure);
    // "Draft", not "attempt": these warnings are rendered to the user, and a
    // discarded draft must not read as a description of the answer on screen.
    warnings.push(
      `Draft ${attempt + 1} stated ${figures.length} figure(s) absent from the evidence: ${figures.join(', ')}.`,
    );
    console.error('[agent] §0.1 attribution violation', {
      attempt: attempt + 1,
      violations: report.violations,
    });

    if (attempt === 0) {
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: attributionRetryTurn(figures) });
      continue;
    }

    return { answer: attributionFailureMessage(report), warnings, outcome: 'withheld' };
  }

  // Unreachable — the loop either returns a clean answer or the failure message.
  return {
    answer: attributionFailureMessage({ ok: false, violations: [], allowed: [] }),
    warnings,
    outcome: 'withheld',
  };
}

/**
 * One chat turn, end to end.
 *
 * `ctx` already carries a live snapshot fetched for this request (§7
 * refetch-per-turn), so nothing here touches Plaid or persists financial data.
 */
export async function runAgentTurn(
  ctx: AgentCtx,
  question: string,
  history: ChatTurn[] = [],
): Promise<AgentResult> {
  const { decision, routedBy } = await route(question, history, ctx.trace);
  const params = toWorkflowParams(decision);

  let workflow = decision.workflow;
  let run;
  try {
    run = await runWorkflow(workflow, ctx, params);
  } catch (error) {
    // A workflow the router can name but Phase 1 has not registered yet.
    // Degrade to the summary rather than failing the turn (§5 general_qa is
    // described as a constrained fallback; this is the same instinct).
    if (!(error instanceof UnknownWorkflowError)) throw error;
    console.warn(
      `[agent] "${workflow}" is not registered (have: ${implementedWorkflows().join(', ')}) — using summary_overview.`,
    );
    workflow = 'summary_overview';
    run = await runWorkflow(workflow, ctx, {});
  }

  const { answer, warnings, outcome } = await synthesise(
    question,
    run.bundle,
    run.limitations,
    history,
    ctx.trace,
  );

  return {
    answer,
    workflow,
    bundle: run.bundle,
    limitations: run.limitations,
    attributionWarnings: warnings,
    attributionOutcome: outcome,
    routedBy,
  };
}
