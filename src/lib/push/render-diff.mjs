/**
 * render-diff.mjs — show what changed between two copies of a content item.
 *
 * The hard part is not the diff, it is making the two sides comparable first.
 * Skilljar and the local copy wrap and indent the same markup differently
 * without anyone editing anything, so a line diff over the raw HTML reports
 * almost every line as changed. That is why this used to be a word-level diff
 * over one long unbroken string: it was the only thing that stayed readable.
 *
 * But a word diff has nowhere to put the two versions side by side, so a
 * one-word edit showed up as adjacent red and green fragments spliced into a
 * single run of text — `updates ▸in◂▸isdffsdn◂ CI/CD` — which reads as neither
 * the old sentence nor the new one.
 *
 * So: reflow both sides into the same line structure (`toDisplayLines`), diff
 * those lines, and lay the result out in two columns. Within a changed pair,
 * highlight just the words that moved. The reflow uses exactly the whitespace
 * rules the comparison in push-plan.mjs uses, so anything it shows as changed
 * is something push would actually write.
 *
 * Note that display lines are not file lines — the reflow invents them — so
 * this deliberately shows no line numbers. Numbering them would invite someone
 * to go looking for line 5 of a file that has no such line.
 */
import chalk from 'chalk';
import { diffArrays, diffWordsWithSpace } from 'diff';

// Tags that start a new line when markup is reflowed for display. Inline tags
// (<a>, <strong>, <code>, <span>…) deliberately stay inside their line: the
// point is to produce a stable, comparable shape, not to pretty-print.
const BLOCK_TAGS = [
  'p', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'blockquote',
  'section', 'article', 'aside', 'header', 'footer', 'figure',
  'figcaption', 'hr', 'br', 'form', 'fieldset', 'nav', 'main', 'dl', 'dt', 'dd'
].join('|');

const BLOCK_BOUNDARY = new RegExp(`(?=</?(?:${BLOCK_TAGS})\\b)`, 'gi');

// How many unchanged lines to keep either side of a change before eliding.
const CONTEXT_LINES = 3;

// Below this, two columns leave too little room for either to be legible and
// the stacked renderer reads better.
const MIN_SIDE_BY_SIDE_WIDTH = 100;

/**
 * Reflows raw HTML into the lines the two sides are compared and displayed as.
 *
 * Outside `<pre>`, runs of whitespace collapse and block tags start new lines,
 * which is what makes an upstream copy and a local copy of the same content
 * produce identical lines. Inside `<pre>`, whitespace is content — a YAML block
 * indented with tabs is a different document from one indented with spaces —
 * so those lines are kept exactly, and only line endings are settled.
 */
export function toDisplayLines(html = '') {
  const lines = [];

  // Odd indices are the captured <pre> spans; even indices are everything else.
  String(html)
    .split(/(<pre\b[\s\S]*?<\/pre>)/i)
    .forEach((part, i) => {
      if (i % 2) {
        for (const line of part.replace(/\r\n?/g, '\n').split('\n')) {
          lines.push({ text: line, pre: true });
        }
        return;
      }
      for (const chunk of part.replace(/\s+/g, ' ').split(BLOCK_BOUNDARY)) {
        const text = chunk.trim();
        if (text) lines.push({ text, pre: false });
      }
    });

  return lines;
}

// A line's identity for diffing. Prefixed so a <pre> line can never compare
// equal to an identical-looking line outside one, where the whitespace rules
// differ.
const lineKey = (line) => `${line.pre ? 'pre' : 'txt'} ${line.text}`;

/**
 * Pairs up the removed and added lines of one change so they can sit opposite
 * each other. Any surplus on either side becomes a one-sided row.
 */
function pairRows(removed, added) {
  const rows = [];
  for (let i = 0; i < Math.max(removed.length, added.length); i++) {
    rows.push({ kind: 'change', left: removed[i] ?? null, right: added[i] ?? null });
  }
  return rows;
}

/**
 * Turns two HTML strings into display rows: `same` for shared context,
 * `change` for a differing pair, and `elision` where unchanged context was
 * dropped. Exported for testing — the renderers below are just formatting.
 */
export function buildRows(oldHtml, newHtml) {
  const oldLines = toDisplayLines(oldHtml);
  const newLines = toDisplayLines(newHtml);

  const parts = diffArrays(oldLines, newLines, {
    comparator: (a, b) => lineKey(a) === lineKey(b)
  });

  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      for (const line of part.value) rows.push({ kind: 'same', left: line, right: line });
      continue;
    }
    // diffArrays emits a removal immediately followed by its addition when a
    // line was edited in place. Consuming both at once is what lets the old
    // and new versions sit opposite each other rather than in separate blocks.
    if (part.removed && parts[i + 1]?.added) {
      rows.push(...pairRows(part.value, parts[i + 1].value));
      i++;
      continue;
    }
    if (part.removed) rows.push(...pairRows(part.value, []));
    else rows.push(...pairRows([], part.value));
  }

  return elideContext(rows);
}

/**
 * Replaces long runs of unchanged rows with a single marker. A one-word fix in
 * a long lesson should not print the whole lesson.
 */
function elideContext(rows) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.kind !== 'change') return;
    for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(rows.length - 1, i + CONTEXT_LINES); j++) {
      keep[j] = true;
    }
  });

  const out = [];
  let dropped = 0;
  rows.forEach((row, i) => {
    if (keep[i]) {
      if (dropped) {
        out.push({ kind: 'elision', count: dropped });
        dropped = 0;
      }
      out.push(row);
    } else {
      dropped++;
    }
  });
  if (dropped) out.push({ kind: 'elision', count: dropped });
  return out;
}

/**
 * Splits two versions of a line into characters tagged with whether they are
 * part of an edit, so the changed words can be highlighted in place.
 */
function markChanges(oldText, newText) {
  const left = [];
  const right = [];
  for (const part of diffWordsWithSpace(oldText ?? '', newText ?? '')) {
    if (part.added) {
      for (const ch of part.value) right.push({ ch, changed: true });
    } else if (part.removed) {
      for (const ch of part.value) left.push({ ch, changed: true });
    } else {
      for (const ch of part.value) {
        left.push({ ch, changed: false });
        right.push({ ch, changed: false });
      }
    }
  }
  return { left, right };
}

/**
 * Wraps a tagged character array to `width`, breaking at spaces where it can
 * and mid-token where it cannot (a long URL or attribute has no break point).
 */
function wrapChars(chars, width) {
  if (chars.length === 0) return [[]];
  const lines = [];
  let start = 0;

  while (start < chars.length) {
    if (chars.length - start <= width) {
      lines.push(chars.slice(start));
      break;
    }
    let end = start + width;
    let breakAt = -1;
    for (let i = end; i > start; i--) {
      if (chars[i - 1].ch === ' ') { breakAt = i; break; }
    }
    if (breakAt > start) end = breakAt;
    lines.push(chars.slice(start, end));
    start = end;
  }

  return lines;
}

/**
 * Renders one wrapped line, colouring changed runs and padding to `width`.
 */
function paint(chars, width, changedStyle, plainStyle) {
  let out = '';
  let i = 0;
  while (i < chars.length) {
    const { changed } = chars[i];
    let j = i;
    while (j < chars.length && chars[j].changed === changed) j++;
    const text = chars.slice(i, j).map(c => c.ch).join('');
    out += changed ? changedStyle(text) : plainStyle(text);
    i = j;
  }
  return out + ' '.repeat(Math.max(0, width - chars.length));
}

const DIM = (s) => chalk.gray(s);
const REMOVED = (s) => chalk.bgRed.white(s);
const ADDED = (s) => chalk.bgGreen.black(s);

function renderSideBySide(rows, totalWidth) {
  // A row is laid out as:
  //   <mark><sp><text…><sp>│<sp><mark><sp><text…>
  //     1     1  tw      1  1  1    1     1  tw     = 2·tw + 7
  // The header and rule are derived from the same arithmetic rather than
  // guessed at, because chalk's escape codes make `.padEnd()` on a styled
  // string silently wrong.
  const textWidth = Math.max(16, Math.floor((totalWidth - 7) / 2));
  const dividerCol = textWidth + 3;
  const out = [];

  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  out.push(
    chalk.bold(pad('  Skilljar (upstream)', dividerCol))
    + chalk.gray('│') + chalk.bold('   local')
  );
  out.push(chalk.gray(`${'─'.repeat(dividerCol)}┼${'─'.repeat(textWidth + 3)}`));

  for (const row of rows) {
    if (row.kind === 'elision') {
      out.push(chalk.gray(`${' '.repeat(2)}⋯ ${row.count} unchanged line(s) ⋯`));
      continue;
    }

    const isChange = row.kind === 'change';
    const { left, right } = isChange
      ? markChanges(row.left?.text, row.right?.text)
      : {
        left: [...(row.left?.text ?? '')].map(ch => ({ ch, changed: false })),
        right: [...(row.right?.text ?? '')].map(ch => ({ ch, changed: false }))
      };

    const leftLines = row.left === null ? [] : wrapChars(left, textWidth);
    const rightLines = row.right === null ? [] : wrapChars(right, textWidth);
    const height = Math.max(leftLines.length, rightLines.length);

    for (let i = 0; i < height; i++) {
      const lMark = row.left === null ? ' ' : (isChange && i === 0 ? chalk.red('-') : ' ');
      const rMark = row.right === null ? ' ' : (isChange && i === 0 ? chalk.green('+') : ' ');
      const lText = leftLines[i]
        ? paint(leftLines[i], textWidth, REMOVED, DIM)
        : ' '.repeat(textWidth);
      const rText = rightLines[i]
        ? paint(rightLines[i], textWidth, ADDED, DIM)
        : '';
      out.push(`${lMark} ${lText} ${chalk.gray('│')} ${rMark} ${rText}`.trimEnd());
    }
  }

  return out.join('\n');
}

function renderStacked(rows, totalWidth) {
  const textWidth = Math.max(20, totalWidth - 2);
  const out = [];

  for (const row of rows) {
    if (row.kind === 'elision') {
      out.push(chalk.gray(`  ⋯ ${row.count} unchanged line(s) ⋯`));
      continue;
    }

    if (row.kind === 'same') {
      for (const line of wrapChars([...row.left.text].map(ch => ({ ch, changed: false })), textWidth)) {
        out.push(`  ${paint(line, 0, DIM, DIM)}`);
      }
      continue;
    }

    const { left, right } = markChanges(row.left?.text, row.right?.text);
    if (row.left !== null) {
      for (const line of wrapChars(left, textWidth)) {
        out.push(`${chalk.red('-')} ${paint(line, 0, REMOVED, DIM)}`);
      }
    }
    if (row.right !== null) {
      for (const line of wrapChars(right, textWidth)) {
        out.push(`${chalk.green('+')} ${paint(line, 0, ADDED, DIM)}`);
      }
    }
  }

  return out.join('\n');
}

/**
 * Renders the difference between two content-item bodies.
 *
 * `style` is 'auto' (side by side when the terminal is wide enough),
 * 'side-by-side', or 'stacked'.
 */
export function renderDiff(oldHtml, newHtml, { style = 'auto', width } = {}) {
  // `process.stdout.columns` is undefined when output is piped, so fall back
  // to COLUMNS before the default — that's what lets a piped run be told how
  // wide to render, which is also how the tests drive this.
  const totalWidth = width
    || process.stdout.columns
    || Number(process.env.COLUMNS)
    || 100;
  const rows = buildRows(oldHtml, newHtml);

  if (rows.length === 0) return chalk.gray('  (no visible difference)');

  const sideBySide = style === 'side-by-side'
    || (style === 'auto' && totalWidth >= MIN_SIDE_BY_SIDE_WIDTH);

  return sideBySide ? renderSideBySide(rows, totalWidth) : renderStacked(rows, totalWidth);
}

/**
 * A plain-text before/after for short single-line values such as titles, where
 * a two-column layout would be more structure than the content deserves.
 */
export function renderValueChange(oldValue, newValue) {
  return `${chalk.red('-')} ${chalk.bgRed.white(oldValue ?? '')}\n${chalk.green('+')} ${chalk.bgGreen.black(newValue ?? '')}`;
}
