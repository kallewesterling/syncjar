import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COURSE_SETTING_FIELDS,
  planCourseSettings,
  patchBodies,
  verifyCourseSettings
} from '#lib/push/course-settings.mjs';

const FIELD = 'enforce_sequential_navigation';

function upstream(id, overrides = {}) {
  return {
    id,
    title: `Course ${id}`,
    short_description: 'short',
    long_description_html: '<p>long</p>',
    labels: [],
    [FIELD]: false,
    modified_at: '2026-10-28T10:00:00Z',
    ...overrides
  };
}

function local(id, details = {}) {
  return { courseDir: `dir-${id}`, details: { id, title: `Course ${id}`, ...details } };
}

const byId = (...records) => new Map(records.map(r => [r.id, r]));

// --- planCourseSettings ---------------------------------------------------

test('the only field pushed is enforce_sequential_navigation', () => {
  assert.deepEqual(COURSE_SETTING_FIELDS, [FIELD]);
});

test('a setting that differs from upstream is a change, with before and after', () => {
  const { changes, inSync, warnings } = planCourseSettings({
    locals: [local('a', { [FIELD]: true })],
    upstreamById: byId(upstream('a'))
  });
  assert.deepEqual(changes, [
    { courseId: 'a', courseDir: 'dir-a', title: 'Course a', field: FIELD, from: false, to: true }
  ]);
  assert.equal(inSync, 0);
  assert.deepEqual(warnings, []);
});

test('a setting that matches upstream is in sync, not a change', () => {
  const { changes, inSync } = planCourseSettings({
    locals: [local('a', { [FIELD]: false })],
    upstreamById: byId(upstream('a'))
  });
  assert.deepEqual(changes, []);
  assert.equal(inSync, 1);
});

// The point of the allowlist. details.json carries the title and descriptions
// too, and a local edit to them must not turn into a write from here.
test('differences in fields outside the allowlist are ignored', () => {
  const { changes, inSync } = planCourseSettings({
    locals: [local('a', {
      [FIELD]: false,
      title: 'Locally retitled',
      short_description: 'edited',
      long_description_html: '<p>edited</p>',
      labels: ['x']
    })],
    upstreamById: byId(upstream('a'))
  });
  assert.deepEqual(changes, []);
  assert.equal(inSync, 1);
});

test('a details.json without the field has no opinion', () => {
  const { changes, inSync, warnings } = planCourseSettings({
    locals: [local('a')],
    upstreamById: byId(upstream('a', { [FIELD]: true }))
  });
  assert.deepEqual(changes, []);
  assert.equal(inSync, 0);
  assert.deepEqual(warnings, []);
});

// "true" as a string is the likely hand-edit mistake, and Skilljar may well
// coerce it, so it must be refused here rather than sent.
test('a non-boolean value is a warning, not a change', () => {
  const { changes, warnings } = planCourseSettings({
    locals: [local('a', { [FIELD]: 'true' })],
    upstreamById: byId(upstream('a'))
  });
  assert.deepEqual(changes, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dir-a\/details\.json/);
});

test('a course missing upstream is a warning, not a change', () => {
  const { changes, warnings } = planCourseSettings({
    locals: [local('gone', { [FIELD]: true })],
    upstreamById: byId(upstream('a'))
  });
  assert.deepEqual(changes, []);
  assert.match(warnings[0], /gone/);
});

test('the change is labelled with the upstream title', () => {
  const { changes } = planCourseSettings({
    locals: [local('a', { [FIELD]: true, title: 'Local title' })],
    upstreamById: byId(upstream('a', { title: 'Upstream title' }))
  });
  assert.equal(changes[0].title, 'Upstream title');
});

// --- patchBodies ----------------------------------------------------------

test('each course gets one PATCH body holding only its changed fields', () => {
  const { changes } = planCourseSettings({
    locals: [local('a', { [FIELD]: true }), local('b', { [FIELD]: false }), local('c', { [FIELD]: false })],
    upstreamById: byId(upstream('a'), upstream('b'), upstream('c', { [FIELD]: true }))
  });
  assert.deepEqual(patchBodies(changes), [
    { courseId: 'a', courseDir: 'dir-a', title: 'Course a', body: { [FIELD]: true } },
    { courseId: 'c', courseDir: 'dir-c', title: 'Course c', body: { [FIELD]: false } }
  ]);
});

// --- verifyCourseSettings -------------------------------------------------

const change = { courseId: 'a', courseDir: 'dir-a', title: 'Course a', field: FIELD, from: false, to: true };

test('a write that landed, with only modified_at also moving, verifies clean', () => {
  const problems = verifyCourseSettings({
    changes: [change],
    before: byId(upstream('a')),
    after: byId(upstream('a', { [FIELD]: true, modified_at: '2026-10-28T11:00:00Z' }))
  });
  assert.deepEqual(problems, []);
});

// Skilljar has returned 200 for writes that changed nothing.
test('a write that did not land is a problem', () => {
  const problems = verifyCourseSettings({
    changes: [change],
    before: byId(upstream('a')),
    after: byId(upstream('a', { modified_at: '2026-10-28T11:00:00Z' }))
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /expected true/);
});

test('any other field moving on a written course is a problem', () => {
  const problems = verifyCourseSettings({
    changes: [change],
    before: byId(upstream('a')),
    after: byId(upstream('a', { [FIELD]: true, short_description: '' }))
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /short_description changed unexpectedly/);
});

test('a written course missing from the catalog afterwards is a problem', () => {
  const problems = verifyCourseSettings({
    changes: [change],
    before: byId(upstream('a')),
    after: new Map()
  });
  assert.match(problems[0], /missing from the catalog/);
});

test('courses that were not written are not checked', () => {
  const problems = verifyCourseSettings({
    changes: [change],
    before: byId(upstream('a'), upstream('b')),
    after: byId(upstream('a', { [FIELD]: true }), upstream('b', { title: 'edited in the UI meanwhile' }))
  });
  assert.deepEqual(problems, []);
});
