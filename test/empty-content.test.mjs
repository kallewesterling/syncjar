import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { resolveContentWrite, isBlankHtml } from '#lib/content/empty-content.mjs';

const EXISTING = '<p>The lesson as it was pulled last time.</p>\n';

async function existingFile(t, contents = EXISTING) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncjar-empty-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'content-abc123.html');
  if (contents !== null) await fsp.writeFile(target, contents);
  return target;
}

// A confirm() that records whether it was called.
function confirmer(result) {
  const calls = [];
  const fn = async () => {
    calls.push(1);
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = calls;
  return fn;
}

test('isBlankHtml treats missing and whitespace-only as blank', () => {
  for (const v of [undefined, null, '', '  \n\t']) assert.equal(isBlankHtml(v), true);
  assert.equal(isBlankHtml('<p></p>'), false);
});

test('content is written as it is, with no extra read', async (t) => {
  const target = await existingFile(t);
  const confirm = confirmer('unused');
  const decision = await resolveContentWrite({ target, html: '<p>New</p>', confirm });
  assert.deepEqual(decision, { action: 'write', html: '<p>New</p>' });
  assert.equal(confirm.calls.length, 0);
});

test('empty content for a new or already-empty file is written, with no extra read', async (t) => {
  for (const contents of [null, '', '\n']) {
    const target = await existingFile(t, contents);
    const confirm = confirmer('unused');
    assert.deepEqual(await resolveContentWrite({ target, html: '', confirm }), { action: 'write', html: '' });
    assert.equal(confirm.calls.length, 0);
  }
});

test('empty content over a non-empty file fires the warning and keeps the file when it cannot be confirmed', async (t) => {
  const target = await existingFile(t);
  const confirm = confirmer(new Error('HTTP 503'));
  const decision = await resolveContentWrite({ target, html: '', confirm });
  assert.equal(confirm.calls.length, 1);
  assert.equal(decision.action, 'keep');
  assert.match(decision.warning, /returned this item empty.*HTTP 503.*Kept the existing file/);
  assert.equal(await fsp.readFile(target, 'utf8'), EXISTING);
});

test('a missing content_html in both reads keeps the file', async (t) => {
  const target = await existingFile(t);
  const decision = await resolveContentWrite({ target, html: undefined, confirm: confirmer(undefined) });
  assert.equal(decision.action, 'keep');
  assert.match(decision.warning, /no content_html field/);
});

test('when the item read has content, the list read was wrong and the item read wins', async (t) => {
  const target = await existingFile(t);
  const decision = await resolveContentWrite({ target, html: '', confirm: confirmer('<p>Really here.</p>') });
  assert.equal(decision.action, 'write');
  assert.equal(decision.html, '<p>Really here.</p>');
  assert.match(decision.warning, /single-item read has content/);
});

test('when the item read is empty too, Skilljar really has it empty, and it is written with a warning', async (t) => {
  const target = await existingFile(t);
  const decision = await resolveContentWrite({ target, html: '', confirm: confirmer('') });
  assert.equal(decision.action, 'write');
  assert.equal(decision.html, '');
  assert.match(decision.warning, /Skilljar has this item empty, confirmed by a second read/);
});
