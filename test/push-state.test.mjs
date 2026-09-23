import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import {
  STATE_VERSION,
  fingerprintCourse,
  readState,
  writeState,
  shouldSkip,
  recordCourse
} from '../scripts/push-state.mjs';

function course({
  title = 'Crush your CVEs',
  lessonTitle = 'What are CVEs?',
  html = '<p>Body</p>',
  lessons,
  localHtmlByItemId
} = {}) {
  return {
    courseDetails: { id: 'course1', title },
    lessons: lessons ?? [
      { id: 'lesson1', title: lessonTitle, content_items: [{ id: 'item1', file: 'a.html' }] }
    ],
    localHtmlByItemId: localHtmlByItemId ?? new Map([['item1', html]])
  };
}

// --- fingerprintCourse -----------------------------------------------------

test('the same course hashes the same twice', () => {
  assert.equal(fingerprintCourse(course()), fingerprintCourse(course()));
});

test('a content edit changes the fingerprint', () => {
  assert.notEqual(
    fingerprintCourse(course()),
    fingerprintCourse(course({ html: '<p>Different</p>' }))
  );
});

test('a course title change changes the fingerprint', () => {
  assert.notEqual(fingerprintCourse(course()), fingerprintCourse(course({ title: 'Renamed' })));
});

test('a lesson title change changes the fingerprint', () => {
  assert.notEqual(
    fingerprintCourse(course()),
    fingerprintCourse(course({ lessonTitle: 'Renamed lesson' }))
  );
});

// The content repo's history shows the pull rewriting trailing newlines on
// files nobody edited. Under a raw hash those courses would rescan forever,
// and the fingerprint would disagree with what push calls a change.
test('whitespace-only churn does not change the fingerprint', () => {
  assert.equal(
    fingerprintCourse(course({ html: '<div>\r\n  <p>Hi</p>\r\n</div>' })),
    fingerprintCourse(course({ html: '<div>\n    <p>Hi</p>\n</div>\n' }))
  );
});

// Inside <pre> whitespace is content, so a tabs-to-spaces fix is a real edit
// and has to invalidate the skip — otherwise it could never be pushed.
test('whitespace inside <pre> does change the fingerprint', () => {
  assert.notEqual(
    fingerprintCourse(course({ html: '<pre>foo:\n\tbar: 1</pre>' })),
    fingerprintCourse(course({ html: '<pre>foo:\n  bar: 1</pre>' }))
  );
});

test('the fingerprint does not depend on lesson or item ordering', () => {
  const a = course({
    lessons: [
      { id: 'l1', title: 'One', content_items: [{ id: 'i1' }, { id: 'i2' }] },
      { id: 'l2', title: 'Two', content_items: [] }
    ],
    localHtmlByItemId: new Map([['i1', 'a'], ['i2', 'b']])
  });
  const b = course({
    lessons: [
      { id: 'l2', title: 'Two', content_items: [] },
      { id: 'l1', title: 'One', content_items: [{ id: 'i2' }, { id: 'i1' }] }
    ],
    localHtmlByItemId: new Map([['i2', 'b'], ['i1', 'a']])
  });
  assert.equal(fingerprintCourse(a), fingerprintCourse(b));
});

// A deleted file must not hash the same as an empty one, or the deletion is
// invisible and the course is skipped with a change outstanding.
test('a missing file is distinguishable from an empty one', () => {
  assert.notEqual(
    fingerprintCourse(course({ localHtmlByItemId: new Map() })),
    fingerprintCourse(course({ html: '' }))
  );
});

test('adding a content item changes the fingerprint', () => {
  const base = course();
  const extra = course({
    lessons: [{ id: 'lesson1', title: 'What are CVEs?', content_items: [{ id: 'item1' }, { id: 'item2' }] }],
    localHtmlByItemId: new Map([['item1', '<p>Body</p>'], ['item2', '<p>New</p>']])
  });
  assert.notEqual(fingerprintCourse(base), fingerprintCourse(extra));
});

// --- shouldSkip ------------------------------------------------------------

const entry = { fingerprint: 'abc', upstreamModifiedAt: '2026-08-18T18:39:19Z' };

test('skips only when both the local hash and the upstream timestamp match', () => {
  assert.equal(shouldSkip(entry, { fingerprint: 'abc', upstreamModifiedAt: '2026-08-18T18:39:19Z' }), true);
});

test('does not skip when the local content has changed', () => {
  assert.equal(shouldSkip(entry, { fingerprint: 'xyz', upstreamModifiedAt: '2026-08-18T18:39:19Z' }), false);
});

test('does not skip when upstream has moved', () => {
  assert.equal(shouldSkip(entry, { fingerprint: 'abc', upstreamModifiedAt: '2026-09-01T00:00:00Z' }), false);
});

// Every unknown resolves to a scan. The cost of guessing wrong that way is a
// slow run; the other way it is a missed change.
test('an unknown course is never skipped', () => {
  assert.equal(shouldSkip(undefined, { fingerprint: 'abc', upstreamModifiedAt: 'x' }), false);
});

test('a course with no upstream timestamp is never skipped', () => {
  assert.equal(shouldSkip(entry, { fingerprint: 'abc', upstreamModifiedAt: null }), false);
  assert.equal(
    shouldSkip({ fingerprint: 'abc', upstreamModifiedAt: null }, { fingerprint: 'abc', upstreamModifiedAt: 'x' }),
    false
  );
});

// --- state file ------------------------------------------------------------

const tmpFile = async () =>
  path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'syncjar-state-')), 'state.json');

test('state survives a write/read round trip', async () => {
  const file = await tmpFile();
  const state = recordCourse({ version: STATE_VERSION, courses: {} }, 'c1', {
    dir: 'Crush-Your-CVEs', fingerprint: 'abc', upstreamModifiedAt: '2026-08-18T18:39:19Z'
  });
  await writeState(file, state);

  const back = await readState(file);
  assert.equal(back.courses.c1.fingerprint, 'abc');
  assert.equal(back.courses.c1.dir, 'Crush-Your-CVEs');
  assert.ok(back.courses.c1.verifiedAt);
});

test('a missing state file reads as empty rather than throwing', async () => {
  assert.deepEqual(await readState('/no/such/path/state.json'), { version: STATE_VERSION, courses: {} });
});

test('an unreadable state file reads as empty', async () => {
  const file = await tmpFile();
  await fs.writeFile(file, '{ not json');
  assert.deepEqual(await readState(file), { version: STATE_VERSION, courses: {} });
});

// A fingerprint computed under older rules cannot be compared with one
// computed under the current rules, so the whole file is discarded.
test('state from a previous version is ignored', async () => {
  const file = await tmpFile();
  await fs.writeJson(file, { version: STATE_VERSION - 1, courses: { c1: { fingerprint: 'abc' } } });
  assert.deepEqual(await readState(file), { version: STATE_VERSION, courses: {} });
});

test('recording a course twice overwrites rather than duplicates', () => {
  let state = { version: STATE_VERSION, courses: {} };
  state = recordCourse(state, 'c1', { dir: 'd', fingerprint: 'one', upstreamModifiedAt: 'a' });
  state = recordCourse(state, 'c1', { dir: 'd', fingerprint: 'two', upstreamModifiedAt: 'b' });
  assert.equal(Object.keys(state.courses).length, 1);
  assert.equal(state.courses.c1.fingerprint, 'two');
});
