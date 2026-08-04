/**
 * The parser is tested rather than the component, because everything that can
 * actually go wrong lives here — the renderer is a mechanical map from these
 * nodes to React elements.
 *
 * Fixtures below are lifted from real synthesis output (`npm run agent:smoke`),
 * so this pins the shapes the model actually produces rather than the ones
 * Markdown permits.
 */

import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline } from './markdown.js';

const text = (value: string) => ({ type: 'text', value });
const bold = (value: string) => ({ type: 'bold', value });

describe('inline spans', () => {
  it('pulls bold out of a sentence', () => {
    expect(parseInline('your net worth is **-$40,452** today')).toEqual([
      text('your net worth is '),
      bold('-$40,452'),
      text(' today'),
    ]);
  });

  it('keeps two bold runs separate rather than swallowing the middle', () => {
    // The greedy-match bug: "**a** and **b**" becoming one bold span reading
    // "a** and **b". Real answers routinely bold several figures in a line.
    expect(parseInline('**$86,542** in assets against **$126,994** in liabilities')).toEqual([
      bold('$86,542'),
      text(' in assets against '),
      bold('$126,994'),
      text(' in liabilities'),
    ]);
  });

  it('handles italic and inline code', () => {
    expect(parseInline('a *maybe* and `code`')).toEqual([
      text('a '),
      { type: 'italic', value: 'maybe' },
      text(' and '),
      { type: 'code', value: 'code' },
    ]);
  });

  it('leaves lone and unmatched markers as literal text', () => {
    // Figures and merchant names contain stray punctuation; a half-open
    // delimiter must not eat the rest of the sentence.
    expect(parseInline('5 * 3 is unmatched')).toEqual([text('5 * 3 is unmatched')]);
    expect(parseInline('an **unclosed run')).toEqual([text('an **unclosed run')]);
  });

  it('treats plain text as one span', () => {
    expect(parseInline('nothing special here')).toEqual([text('nothing special here')]);
  });
});

describe('blocks', () => {
  it('groups consecutive bullets into a single list', () => {
    const blocks = parseBlocks(
      ['- **Loan payments**: about $6,310', '- **Food and drink**: about $1,549'].join('\n'),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('bullets');
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('separates a paragraph from the list that follows it', () => {
    const blocks = parseBlocks(
      ['Over the past three months:', '', '- Loans: $6,310', '- Food: $1,549'].join('\n'),
    );

    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'bullets']);
  });

  it('recognises numbered lists distinctly from bullets', () => {
    const blocks = parseBlocks(['1. First thing', '2. Second thing'].join('\n'));
    expect(blocks[0]?.type).toBe('numbered');
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('does not merge a bullet list into an adjacent numbered list', () => {
    const blocks = parseBlocks(['- a', '- b', '1. c'].join('\n'));
    expect(blocks.map((b) => b.type)).toEqual(['bullets', 'numbered']);
  });

  it('joins a wrapped bullet back onto its own item', () => {
    const blocks = parseBlocks(['- Loan payments, mostly from', '  the recurring charge'].join('\n'));

    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(1);
  });

  it('joins wrapped paragraph lines with a space', () => {
    const blocks = parseBlocks('Here is a line\nand its continuation.');
    expect(blocks).toEqual([
      { type: 'paragraph', spans: [text('Here is a line and its continuation.')] },
    ]);
  });

  it('parses headings up to level three', () => {
    const blocks = parseBlocks('## Cash\n\nSome detail.');
    expect(blocks[0]).toEqual({ type: 'heading', level: 2, spans: [text('Cash')] });
  });

  it('produces nothing for empty or whitespace input', () => {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('\n\n  \n')).toEqual([]);
  });

  it('keeps HTML as literal text rather than markup', () => {
    // The reason this parser exists. A merchant name arrives from Plaid, rides
    // the evidence bundle into the answer, and must never reach the DOM as
    // markup. It stays a string here, and React escapes it downstream.
    const blocks = parseBlocks('You paid <img src=x onerror=alert(1)> last week');

    expect(blocks).toEqual([
      {
        type: 'paragraph',
        spans: [text('You paid <img src=x onerror=alert(1)> last week')],
      },
    ]);
  });

  it('handles a full answer end to end', () => {
    const answer = [
      "Over the past three months, your spending totaled about **$11,398**. Here's how it broke down:",
      '',
      '- **Loan payments**: about $6,310, or 55% of spending',
      '- **Food and drink**: about $1,549, or 14%',
      '',
      'One thing worth flagging: your income shows as only $1,500.',
    ].join('\n');

    expect(parseBlocks(answer).map((b) => b.type)).toEqual([
      'paragraph',
      'bullets',
      'paragraph',
    ]);
  });
});
