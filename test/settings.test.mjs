import test from 'node:test';
import assert from 'node:assert/strict';

import { boolean, text, html, planSettings, patchBodies, verifySettings } from '#lib/push/settings.mjs';
import { PATH_SETTINGS, pathTargets } from '#lib/push/path-settings.mjs';
import { LESSON_SETTINGS, lessonTargets } from '#lib/push/lesson-settings.mjs';
import {
  PUBLISHED_SETTINGS,
  publishedTargets,
  publishedKey,
  withoutDerived,
  registrationWarnings
} from '#lib/push/published-settings.mjs';
import { filterByDirOrId } from '#lib/content/read-dirs.mjs';

const target = (id, local, upstream) => ({ id, label: `T ${id}`, endpoint: `/things/${id}`, local, upstream });

// --- field rules ------------------------------------------------------------

test('text compares after trimming, as Skilljar stores it', () => {
  assert.ok(text().equal(' a name ', 'a name'));
  assert.ok(!text().equal('a', 'b'));
  assert.ok(text().equal(undefined, ''));
});

test('a required text field refuses blank', () => {
  assert.equal(text().validate(''), null);
  assert.match(text({ required: true }).validate('  '), /blank/);
  assert.match(text().validate(3), /not a string/);
});

test('html ignores incidental whitespace, as push does', () => {
  assert.ok(html.equal('<p>one</p>\r\n<p>two</p>', '<p>one</p> <p>two</p>'));
  assert.ok(!html.equal('<p>one</p>', '<p>two</p>'));
});

// --- planSettings -----------------------------------------------------------

test('only differing allowlisted fields become changes', () => {
  const { changes, inSync, warnings } = planSettings({
    targets: [target('a', { flag: true, name: 'x', other: 'edited' }, { flag: false, name: 'x', other: 'orig' })],
    fields: { flag: boolean, name: text() }
  });
  assert.deepEqual(changes, [{ id: 'a', label: 'T a', endpoint: '/things/a', field: 'flag', from: false, to: true }]);
  assert.equal(inSync, 1);
  assert.deepEqual(warnings, []);
});

test('a local record without a field has no opinion', () => {
  const { changes, inSync } = planSettings({ targets: [target('a', {}, { flag: true })], fields: { flag: boolean } });
  assert.deepEqual(changes, []);
  assert.equal(inSync, 0);
});

test('an invalid value is a warning naming the file', () => {
  const { changes, warnings } = planSettings({
    targets: [{ ...target('a', { flag: 'yes' }, { flag: false }), where: 'dir/file.json' }],
    fields: { flag: boolean }
  });
  assert.deepEqual(changes, []);
  assert.match(warnings[0], /^dir\/file\.json: flag is "yes", not true or false/);
});

test('a target with no upstream record is a warning', () => {
  const { changes, warnings } = planSettings({
    targets: [target('gone', { flag: true }, undefined)],
    fields: { flag: boolean },
    missing: (t) => `${t.label} vanished`
  });
  assert.deepEqual(changes, []);
  assert.deepEqual(warnings, ['T gone vanished']);
});

test('patchBodies sends one body per target with only its changes', () => {
  const { changes } = planSettings({
    targets: [target('a', { x: true, y: true }, { x: false, y: false }), target('b', { x: false }, { x: false })],
    fields: { x: boolean, y: boolean }
  });
  assert.deepEqual(patchBodies(changes), [{ id: 'a', label: 'T a', endpoint: '/things/a', body: { x: true, y: true } }]);
});

// --- verifySettings ---------------------------------------------------------

const change = { id: 'a', label: 'T a', endpoint: '/things/a', field: 'flag', from: false, to: true };
const byId = (...r) => new Map(r.map(x => [x.id, x]));

test('a write that landed verifies, with alwaysChanges allowed to move', () => {
  assert.deepEqual(verifySettings({
    changes: [change],
    fields: { flag: boolean },
    before: byId({ id: 'a', flag: false, modified_at: '1' }),
    after: byId({ id: 'a', flag: true, modified_at: '2' }),
    alwaysChanges: ['modified_at']
  }), []);
});

test('a write that did not land, or moved something else, is a problem', () => {
  const problems = verifySettings({
    changes: [change],
    fields: { flag: boolean },
    before: byId({ id: 'a', flag: false, title: 'x' }),
    after: byId({ id: 'a', flag: false, title: 'y' })
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /expected true/);
  assert.match(problems[1], /title changed unexpectedly/);
});

test('a derived field may follow its source and nothing else', () => {
  const args = {
    fields: { flag: boolean, other: boolean },
    before: byId({ id: 'a', flag: false, other: false, shown: '' }),
    derived: { shown: ['flag'] }
  };
  assert.deepEqual(verifySettings({ ...args, changes: [change], after: byId({ id: 'a', flag: true, other: false, shown: 'x' }) }), []);
  const viaOther = { ...change, field: 'other' };
  assert.match(
    verifySettings({ ...args, changes: [viaOther], after: byId({ id: 'a', flag: false, other: true, shown: 'x' }) })[0],
    /shown changed unexpectedly/
  );
});

test('a written record missing afterwards is a problem', () => {
  assert.match(verifySettings({ changes: [change], fields: { flag: boolean }, before: byId({ id: 'a' }), after: new Map() })[0], /missing/);
});

// --- paths ------------------------------------------------------------------

test('path targets PATCH /paths/{id} and compare all six path fields', () => {
  assert.deepEqual(Object.keys(PATH_SETTINGS), [
    'title', 'short_description', 'long_description_html', 'header_html', 'course_name_singular', 'course_name_plural'
  ]);
  const upstream = new Map([['p1', { id: 'p1', title: 'Path', course_name_singular: 'Course', short_description: '' }]]);
  const targets = pathTargets([{ dir: 'Path-dir', details: { id: 'p1', title: 'Path', course_name_singular: 'Step', short_description: '' } }], upstream);
  assert.equal(targets[0].endpoint, '/paths/p1');
  const { changes } = planSettings({ targets, fields: PATH_SETTINGS });
  assert.deepEqual(changes.map(c => [c.field, c.from, c.to]), [['course_name_singular', 'Course', 'Step']]);
});

test('a path title or item name cannot be pushed blank; a short description can', () => {
  const upstream = new Map([['p1', { id: 'p1', title: 'Path', course_name_plural: 'Courses', short_description: 'old' }]]);
  const { changes, warnings } = planSettings({
    targets: pathTargets([{ dir: 'd', details: { id: 'p1', title: '', course_name_plural: ' ', short_description: '' } }], upstream),
    fields: PATH_SETTINGS
  });
  assert.deepEqual(changes.map(c => c.field), ['short_description']);
  assert.equal(warnings.length, 2);
});

// --- lessons ----------------------------------------------------------------

test('lesson targets cover optional, description and tooltip, never title or order', () => {
  assert.deepEqual(Object.keys(LESSON_SETTINGS), ['optional', 'description_html', 'tooltip_html']);
  const upstream = new Map([['l1', { id: 'l1', title: 'Old title', order: 10, optional: false, description_html: '', tooltip_html: '' }]]);
  const targets = lessonTargets({
    courseDir: 'Course-dir',
    lessons: [{ id: 'l1', title: 'New title', order: 20, optional: true, description_html: '<p>d</p>', tooltip_html: '' }],
    upstreamById: upstream
  });
  assert.equal(targets[0].endpoint, '/lessons/l1');
  const { changes } = planSettings({ targets, fields: LESSON_SETTINGS });
  assert.deepEqual(changes.map(c => c.field), ['optional', 'description_html']);
});

test('a lesson missing upstream is a warning, not a change', () => {
  const { changes, warnings } = planSettings({
    targets: lessonTargets({ courseDir: 'c', lessons: [{ id: 'gone', title: 'Gone', optional: true }], upstreamById: new Map() }),
    fields: LESSON_SETTINGS
  });
  assert.deepEqual(changes, []);
  assert.match(warnings[0], /c › Gone/);
});

// --- published settings -----------------------------------------------------

const coursePublished = {
  course_id: 'c1',
  domains: {
    'a.example.com': { slug: 'one', published_course_id: 'pc1', hidden: true, strict_enforce_group_visibility: false },
    'b.example.com': { slug: 'one', published_course_id: 'pc2', hidden: false }
  }
};

test('a publish record is targeted per domain at its own endpoint', () => {
  const targets = publishedTargets({ kind: 'course', locals: [{ dir: 'One', published: coursePublished }], upstream: new Map() });
  assert.deepEqual(targets.map(t => [t.id, t.endpoint]), [
    ['a.example.com/pc1', '/domains/a.example.com/published-courses/pc1'],
    ['b.example.com/pc2', '/domains/b.example.com/published-courses/pc2']
  ]);
  const paths = publishedTargets({
    kind: 'path',
    locals: [{ dir: 'P', published: { domains: { 'a.example.com': { slug: 'p', published_path_id: 'pp1', hidden: false } } } }],
    upstream: new Map()
  });
  assert.equal(paths[0].endpoint, '/domains/a.example.com/published-paths/pp1');
});

test('only hidden and group visibility are pushed, never the slug', () => {
  assert.deepEqual(Object.keys(PUBLISHED_SETTINGS), ['hidden', 'strict_enforce_group_visibility']);
  const upstream = new Map([
    [publishedKey('a.example.com', 'pc1'), { id: 'pc1', slug: 'renamed', hidden: false, strict_enforce_group_visibility: false }],
    [publishedKey('b.example.com', 'pc2'), { id: 'pc2', slug: 'one', hidden: false, strict_enforce_group_visibility: true }]
  ]);
  const { changes } = planSettings({
    targets: publishedTargets({ kind: 'course', locals: [{ dir: 'One', published: coursePublished }], upstream }),
    fields: PUBLISHED_SETTINGS
  });
  // b.example.com's file predates the group-visibility field, so it has no opinion on it.
  assert.deepEqual(changes.map(c => [c.id, c.field, c.to]), [['a.example.com/pc1', 'hidden', true]]);
});

test('--domain narrows publish records to the named domains', () => {
  const targets = publishedTargets({
    kind: 'course', locals: [{ dir: 'One', published: coursePublished }], upstream: new Map(), domains: ['b.example.com']
  });
  assert.deepEqual(targets.map(t => t.id), ['b.example.com/pc2']);
});

// --- registration on paths ---------------------------------------------------

const D = 'a.example.com';
const courseLocal = (cid, pcid) => ({ dir: cid, published: { course_id: cid, domains: { [D]: { published_course_id: pcid } } } });
const pathLocal = (courseIds) => ({ dir: 'Path', published: { domains: { [D]: { published_path_id: 'pp' } } }, courseIds });
const hideChange = (pcid, to = true) => ({ id: publishedKey(D, pcid), field: 'hidden', from: !to, to });

// Seen on staging: hiding a path's only course closed its registration.
test('hiding a path\'s last visible course is warned about', () => {
  const upstream = new Map([[publishedKey(D, 'pc1'), { hidden: false }], [publishedKey(D, 'pc2'), { hidden: true }]]);
  const warnings = registrationWarnings({
    changes: [hideChange('pc1')],
    courseLocals: [courseLocal('c1', 'pc1'), courseLocal('c2', 'pc2')],
    pathLocals: [pathLocal(['c1', 'c2'])],
    upstream
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Path on a\.example\.com: .*closes registration/);
});

// Seen on production: paths with some hidden courses stay open.
test('hiding a course while another stays visible is not warned about', () => {
  const upstream = new Map([[publishedKey(D, 'pc1'), { hidden: false }], [publishedKey(D, 'pc2'), { hidden: false }]]);
  assert.deepEqual(registrationWarnings({
    changes: [hideChange('pc1')],
    courseLocals: [courseLocal('c1', 'pc1'), courseLocal('c2', 'pc2')],
    pathLocals: [pathLocal(['c1', 'c2'])],
    upstream
  }), []);
});

test('a path already without a visible course is not this run\'s doing', () => {
  const upstream = new Map([[publishedKey(D, 'pc1'), { hidden: true }]]);
  assert.deepEqual(registrationWarnings({
    changes: [hideChange('pc1')],
    courseLocals: [courseLocal('c1', 'pc1')],
    pathLocals: [pathLocal(['c1'])],
    upstream
  }), []);
});

test('the derived registration flag is dropped before verifying, and nothing else', () => {
  assert.deepEqual(
    withoutDerived({ id: 'x', hidden: true, offer: { id: 'o', registration_open: false, price: { amount: '0.00' } } }),
    { id: 'x', hidden: true, offer: { id: 'o', price: { amount: '0.00' } } }
  );
  assert.deepEqual(withoutDerived({ id: 'x' }), { id: 'x' });
});

// --- filterByDirOrId --------------------------------------------------------

test('filterByDirOrId keeps matches by directory or id and reports the rest', () => {
  const entries = [{ dir: 'A', id: '1' }, { dir: 'B', id: '2' }];
  assert.deepEqual(filterByDirOrId(entries, [], e => e.id).kept, entries);
  const { kept, unmatched } = filterByDirOrId(entries, ['A', '2', 'nope'], e => e.id);
  assert.deepEqual(kept, entries);
  assert.deepEqual(unmatched, ['nope']);
});
