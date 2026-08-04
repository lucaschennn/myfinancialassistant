/**
 * A deliberately small Markdown subset — parsing only.
 *
 * Why not a library, and why parse to a tree rather than to HTML: the text
 * being rendered is model output, and model output is built from evidence that
 * contains third-party strings. A transaction's merchant name arrives from
 * Plaid, flows into the evidence bundle, and can be quoted verbatim in an
 * answer. Anything that ends in `dangerouslySetInnerHTML` therefore puts a
 * value we do not control on a path to the DOM.
 *
 * So this produces a tree of plain data, the renderer maps it to React
 * elements, and every string lands in a text node that React escapes. Injection
 * is impossible by construction rather than by sanitising carefully.
 *
 * The subset covers what synthesis actually emits: paragraphs, bullet and
 * numbered lists, bold, italic, and inline code. Raw HTML is not supported —
 * it is passed through as literal text.
 */

export type Span =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'code'; value: string };

export type Block =
  | { type: 'paragraph'; spans: Span[] }
  | { type: 'bullets'; items: Span[][] }
  | { type: 'numbered'; items: Span[][] }
  | { type: 'heading'; level: 1 | 2 | 3; spans: Span[] };

/**
 * Emphasis and code, non-nesting.
 *
 * `**bold**` is matched before `*italic*` so the longer delimiter wins. The
 * `[^*]` inner classes stop a run of asterisks being swallowed by a greedy
 * match, which is what turns "**a** and **b**" into one giant bold span.
 */
const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`)/g;

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];

  for (const piece of text.split(INLINE)) {
    if (!piece) continue;

    if (piece.length > 4 && piece.startsWith('**') && piece.endsWith('**')) {
      spans.push({ type: 'bold', value: piece.slice(2, -2) });
    } else if (piece.length > 4 && piece.startsWith('__') && piece.endsWith('__')) {
      spans.push({ type: 'bold', value: piece.slice(2, -2) });
    } else if (piece.length > 2 && piece.startsWith('*') && piece.endsWith('*')) {
      spans.push({ type: 'italic', value: piece.slice(1, -1) });
    } else if (piece.length > 2 && piece.startsWith('_') && piece.endsWith('_')) {
      spans.push({ type: 'italic', value: piece.slice(1, -1) });
    } else if (piece.length > 2 && piece.startsWith('`') && piece.endsWith('`')) {
      spans.push({ type: 'code', value: piece.slice(1, -1) });
    } else {
      spans.push({ type: 'text', value: piece });
    }
  }

  return spans;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;

/**
 * Group lines into blocks.
 *
 * Consecutive list lines become one list, so a breakdown renders as a single
 * `<ul>` rather than a run of one-item lists. A blank line always ends the
 * current block.
 */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  let paragraph: string[] = [];
  let list: { type: 'bullets' | 'numbered'; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join(' ').trim()) });
    paragraph = [];
  };

  const flushList = (): void => {
    if (!list) return;
    blocks.push({ type: list.type, items: list.items.map(parseInline) });
    list = null;
  };

  const flushAll = (): void => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (line.trim() === '') {
      flushAll();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      blocks.push({
        type: 'heading',
        level: heading[1]!.length as 1 | 2 | 3,
        spans: parseInline(heading[2]!),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      if (list?.type !== 'bullets') {
        flushList();
        list = { type: 'bullets', items: [] };
      }
      list.items.push(bullet[1]!);
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      flushParagraph();
      if (list?.type !== 'numbered') {
        flushList();
        list = { type: 'numbered', items: [] };
      }
      list.items.push(numbered[1]!);
      continue;
    }

    // A plain line while a list is open continues that list's last item —
    // this is how a wrapped bullet stays part of its bullet.
    if (list && list.items.length > 0) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    paragraph.push(line.trim());
  }

  flushAll();
  return blocks;
}
