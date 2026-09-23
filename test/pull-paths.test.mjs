import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchesFilter,
  publishedEntry,
  samePublished,
  sameJson,
  isOrphanedPublished
} from '../scripts/pull-paths.mjs';

// Importing the script must not require an API key or hit the network: main()
// is only invoked when the file is run directly. If this import ever starts
// throwing, the guard at the bottom of pull-paths.mjs has regressed.
test('the module is importable without SKILLJAR_API_KEY', () => {
  assert.equal(typeof matchesFilter, 'function');
});

test('matchesFilter matches on directory name', () => {
  assert.ok(matchesFilter('Onboarding-Guide', 'Something Else', 'onboarding'));
  assert.ok(matchesFilter('Onboarding-Guide', 'Something Else', 'ONBOARDING'));
  assert.ok(!matchesFilter('Onboarding-Guide', 'Something Else', 'vulnerability'));
});

test('matchesFilter matches on the slugified title too', () => {
  // The directory keeps its original name after a retitle upstream, so the
  // current title is the only thing a user filtering by it can match on.
  assert.ok(matchesFilter('Old-Directory-Name', 'Painless Vulnerability Management', 'painless-vuln'));
});

test('matchesFilter tolerates a path with no title', () => {
  assert.doesNotThrow(() => matchesFilter('Some-Dir', undefined, 'x'));
  assert.ok(!matchesFilter('Some-Dir', undefined, 'x'));
  assert.ok(matchesFilter('Some-Dir', null, 'some'));
});

test('publishedEntry keeps the per-domain fields and defaults hidden', () => {
  assert.deepEqual(
    publishedEntry({ id: 'pp1', slug: 'a-path', hidden: true, path: { id: 'p1' } }),
    { slug: 'a-path', published_path_id: 'pp1', hidden: true }
  );
  // Absent `hidden` means visible, not undefined — otherwise the key would be
  // dropped by JSON.stringify and every comparison would report drift.
  assert.deepEqual(
    publishedEntry({ id: 'pp2', slug: 'b-path' }),
    { slug: 'b-path', published_path_id: 'pp2', hidden: false }
  );
});

test('samePublished ignores generated_at', () => {
  const domains = { 'courses.example.com': { slug: 'a', published_path_id: 'pp1', hidden: false } };
  assert.ok(samePublished(
    { path_id: 'p1', generated_at: '2020-01-01T00:00:00.000Z', domains },
    { path_id: 'p1', generated_at: '2026-09-21T00:00:00.000Z', domains }
  ));
});

test('samePublished sees a changed slug, a new domain, and a missing file', () => {
  const base = {
    path_id: 'p1',
    generated_at: 'x',
    domains: { 'courses.example.com': { slug: 'a', published_path_id: 'pp1', hidden: false } }
  };
  assert.ok(!samePublished(base, {
    ...base,
    domains: { 'courses.example.com': { slug: 'renamed', published_path_id: 'pp1', hidden: false } }
  }));
  assert.ok(!samePublished(base, {
    ...base,
    domains: {
      ...base.domains,
      'staging.example.com': { slug: 'a', published_path_id: 'pp2', hidden: false }
    }
  }));
  assert.ok(!samePublished(null, base));
});

test('sameJson treats a missing file as different, including from empty data', () => {
  // A path with no items writes `[]`. That has to be distinguishable from
  // having never been written, or --check would call it clean.
  assert.ok(!sameJson(null, []));
  assert.ok(!sameJson(undefined, []));
  assert.ok(sameJson([], []));
});

test('isOrphanedPublished only condemns records the run can speak for', () => {
  const twoDomains = {
    domains: {
      'courses.example.com': { slug: 'a' },
      'staging.example.com': { slug: 'a' }
    }
  };
  // Scoping a run to one of two domains says nothing about the other, so the
  // file is not orphaned — this is the case that would otherwise make
  // `--check --domain one-of-two` fail forever.
  assert.ok(!isOrphanedPublished(twoDomains, ['courses.example.com']));
  assert.ok(isOrphanedPublished(twoDomains, ['courses.example.com', 'staging.example.com']));

  const oneDomain = { domains: { 'courses.example.com': { slug: 'a' } } };
  assert.ok(isOrphanedPublished(oneDomain, ['courses.example.com']));
  assert.ok(!isOrphanedPublished(oneDomain, ['staging.example.com']));

  // A file recording no domains at all is orphaned by definition: there is
  // nothing in it that any run could confirm.
  assert.ok(isOrphanedPublished({ domains: {} }, ['courses.example.com']));
  assert.ok(isOrphanedPublished({}, ['courses.example.com']));
});

test('sameJson compares verbatim payloads deeply', () => {
  const items = [{ id: 'i1', slug: 'lesson-a', course: { id: 'c1', lesson_count: 3 } }];
  assert.ok(sameJson(items, [{ id: 'i1', slug: 'lesson-a', course: { id: 'c1', lesson_count: 3 } }]));
  assert.ok(!sameJson(items, [{ id: 'i1', slug: 'lesson-a', course: { id: 'c1', lesson_count: 4 } }]));
  // Order is API order; a reordering is a real difference, not noise.
  assert.ok(!sameJson(
    [{ id: 'i1' }, { id: 'i2' }],
    [{ id: 'i2' }, { id: 'i1' }]
  ));
});
