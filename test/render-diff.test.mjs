import test from 'node:test';
import assert from 'node:assert/strict';

import { toDisplayLines, buildRows, renderDiff } from '../scripts/render-diff.mjs';

const texts = (html) => toDisplayLines(html).map(l => l.text);
const kinds = (rows) => rows.map(r => r.kind);

// --- toDisplayLines --------------------------------------------------------

test('block tags start new display lines', () => {
  assert.deepEqual(
    texts('<p>One</p><p>Two</p>'),
    ['<p>One', '</p>', '<p>Two', '</p>']
  );
});

test('inline tags stay on their line', () => {
  assert.deepEqual(
    texts('<p>Run <code>chainctl</code> and <strong>wait</strong></p>'),
    ['<p>Run <code>chainctl</code> and <strong>wait</strong>', '</p>']
  );
});

// This is the whole reason the reflow exists: the two sides are indented and
// wrapped differently by Skilljar and by the local copy, and a line diff over
// the raw markup would call every line changed.
test('indentation and wrapping differences produce identical lines', () => {
  const upstream = '<div>\r\n  <p>Hello   there</p>\r\n</div>';
  const local = '<div>\n\t\t<p>Hello there</p>\n</div>';
  assert.deepEqual(texts(upstream), texts(local));
});

test('whitespace inside <pre> is preserved line by line', () => {
  assert.deepEqual(
    texts('<pre>foo:\n\tbar: 1</pre>'),
    ['<pre>foo:', '\tbar: 1</pre>']
  );
});

test('<pre> line endings are settled but indentation is not', () => {
  assert.deepEqual(texts('<pre>a\r\n  b</pre>'), texts('<pre>a\n  b</pre>'));
  assert.notDeepEqual(texts('<pre>a\n\tb</pre>'), texts('<pre>a\n  b</pre>'));
});

test('empty input yields no lines', () => {
  assert.deepEqual(toDisplayLines(''), []);
  assert.deepEqual(toDisplayLines(undefined), []);
});

// --- buildRows -------------------------------------------------------------

test('identical content yields no change rows', () => {
  const rows = buildRows('<p>Same</p>', '<p>Same</p>');
  assert.ok(!kinds(rows).includes('change'));
});

test('markup that differs only in whitespace yields no change rows', () => {
  const rows = buildRows('<div>\r\n  <p>Hi</p>\r\n</div>', '<div>\n    <p>Hi</p>\n</div>');
  assert.ok(!kinds(rows).includes('change'));
});

// An edit in place has to pair its old and new versions into one row, or the
// two columns can't sit opposite each other.
test('an edited line becomes one row carrying both versions', () => {
  const rows = buildRows(
    '<li>Automate image updates in CI/CD</li>',
    '<li>Automate image updates everywhere CI/CD</li>'
  );
  const changes = rows.filter(r => r.kind === 'change');
  assert.equal(changes.length, 1);
  assert.match(changes[0].left.text, /updates in CI\/CD/);
  assert.match(changes[0].right.text, /updates everywhere CI\/CD/);
});

test('a purely added line has no left side', () => {
  const rows = buildRows('<p>One</p>', '<p>One</p><p>Two</p>');
  const changes = rows.filter(r => r.kind === 'change');
  assert.ok(changes.length > 0);
  assert.ok(changes.every(r => r.left === null));
  assert.match(changes.map(r => r.right.text).join(' '), /Two/);
});

test('a purely removed line has no right side', () => {
  const rows = buildRows('<p>One</p><p>Two</p>', '<p>One</p>');
  const changes = rows.filter(r => r.kind === 'change');
  assert.ok(changes.length > 0);
  assert.ok(changes.every(r => r.right === null));
});

// A one-word fix in a long lesson should not print the whole lesson.
test('long unchanged runs are elided', () => {
  const filler = Array.from({ length: 40 }, (_, i) => `<p>Line ${i}</p>`).join('');
  const rows = buildRows(`${filler}<p>old</p>`, `${filler}<p>new</p>`);

  const elisions = rows.filter(r => r.kind === 'elision');
  assert.equal(elisions.length, 1);
  assert.ok(elisions[0].count > 50, `expected a large elision, got ${elisions[0].count}`);
  // Context either side of the change survives.
  assert.ok(rows.filter(r => r.kind === 'same').length >= 3);
});

test('a short unchanged run is kept rather than elided', () => {
  const rows = buildRows('<p>a</p><p>old</p>', '<p>a</p><p>new</p>');
  assert.ok(!kinds(rows).includes('elision'));
});

// Whitespace inside <pre> is content: a tabs-vs-spaces YAML fix has to show up
// as a change, or it can never be reviewed and pushed.
test('a tabs-to-spaces fix inside <pre> is a change', () => {
  const rows = buildRows('<pre>foo:\n\tbar: 1</pre>', '<pre>foo:\n  bar: 1</pre>');
  assert.ok(kinds(rows).includes('change'));
});

// --- renderDiff ------------------------------------------------------------

test('side-by-side puts both versions on the same visual row', () => {
  const out = renderDiff(
    '<li>Automate image updates in CI/CD</li>',
    '<li>Automate image updates everywhere CI/CD</li>',
    { style: 'side-by-side', width: 160 }
  );
  const row = out.split('\n').find(l => l.includes('updates in'));
  assert.ok(row, 'expected a row containing the old text');
  assert.ok(row.includes('everywhere'), 'old and new should share one row');
});

test('side-by-side rows line up with the header rule', () => {
  const out = renderDiff('<p>One</p>', '<p>Two</p>', { style: 'side-by-side', width: 120 });
  const lines = out.split('\n');
  const dividerCol = lines[1].indexOf('┼');
  assert.ok(dividerCol > 0);
  for (const line of lines.slice(2)) {
    const col = line.indexOf('│');
    if (col !== -1) assert.equal(col, dividerCol, `misaligned: ${JSON.stringify(line)}`);
  }
});

test('stacked marks removals and additions on separate lines', () => {
  const out = renderDiff('<p>One</p>', '<p>Two</p>', { style: 'stacked', width: 80 });
  assert.match(out, /^-.*One/m);
  assert.match(out, /^\+.*Two/m);
  assert.ok(!out.includes('│'));
});

test('auto picks two columns when wide and stacks when narrow', () => {
  const wide = renderDiff('<p>One</p>', '<p>Two</p>', { style: 'auto', width: 160 });
  const narrow = renderDiff('<p>One</p>', '<p>Two</p>', { style: 'auto', width: 60 });
  assert.ok(wide.includes('│'));
  assert.ok(!narrow.includes('│'));
});

test('no visible difference says so rather than printing an empty frame', () => {
  assert.match(renderDiff('', ''), /no visible difference/);
});

// Long tokens (a URL, a base64 src) have no space to break at, so wrapping has
// to fall back to a hard break rather than overflowing the column.
test('a long unbreakable token is hard-wrapped inside its column', () => {
  const long = 'x'.repeat(300);
  const out = renderDiff(`<p>${long}</p>`, `<p>${long}y</p>`, { style: 'side-by-side', width: 100 });
  for (const line of out.split('\n')) {
    // eslint-disable-next-line no-control-regex
    assert.ok(line.replace(/\[[0-9;]*m/g, '').length <= 100, 'line overflowed the terminal width');
  }
});
