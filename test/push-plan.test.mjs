import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHtml, planCourse } from '../scripts/push-plan.mjs';

// --- normalizeHtml ---------------------------------------------------------

test('normalizeHtml collapses incidental whitespace outside <pre>', () => {
  assert.equal(
    normalizeHtml('<p>one</p>\n\n   <p>two</p>  '),
    normalizeHtml('<p>one</p> <p>two</p>')
  );
});

// The reason this function exists. Skilljar and the local copy indent markup
// differently without anyone editing anything; collapsing that noise is what
// stops the push reporting changes nobody made.
test('normalizeHtml treats differently-indented markup as identical', () => {
  const upstream = '<div>\r\n  <p>Hello</p>\r\n</div>';
  const local = '<div>\n    <p>Hello</p>\n</div>';
  assert.equal(normalizeHtml(upstream), normalizeHtml(local));
});

// The reason the <pre> carve-out exists. A YAML block indented with tabs and
// the same block indented with spaces are different documents — YAML forbids
// the tab — so a reader who copies the first one gets a parse error. If these
// compared equal, the fix could never be pushed.
test('normalizeHtml keeps whitespace inside <pre> significant', () => {
  const tabs = '<pre>foo:\n\tbar: 1</pre>';
  const spaces = '<pre>foo:\n  bar: 1</pre>';
  assert.notEqual(normalizeHtml(tabs), normalizeHtml(spaces));
});

test('normalizeHtml settles line endings inside <pre>', () => {
  assert.equal(
    normalizeHtml('<pre>a\r\n  b</pre>'),
    normalizeHtml('<pre>a\n  b</pre>')
  );
});

test('normalizeHtml handles several <pre> blocks and the text between them', () => {
  const a = '<pre>  x</pre>\n\n<p>gap</p>\n\n<pre>  y</pre>';
  const b = '<pre>  x</pre> <p>gap</p> <pre>  y</pre>';
  assert.equal(normalizeHtml(a), normalizeHtml(b));
  assert.notEqual(normalizeHtml(a), normalizeHtml('<pre>x</pre> <p>gap</p> <pre>  y</pre>'));
});

test('normalizeHtml tolerates undefined', () => {
  assert.equal(normalizeHtml(undefined), '');
  assert.equal(normalizeHtml(), '');
});

// --- planCourse ------------------------------------------------------------

// Builds the argument object for a one-lesson, one-content-item course, so
// each test below only has to state the part it is about.
function fixture({
  courseTitle = 'Crush your CVEs',
  upstreamCourseTitle = 'Crush your CVEs',
  lessonTitle = 'What are CVEs?',
  upstreamLessonTitle = 'What are CVEs?',
  localHtml = '<p>Body</p>',
  upstreamHtml = '<p>Body</p>',
  contentItems,
  upstreamLessons,
  upstreamItems,
  localHtmlByItemId,
  lessonFilter = null
} = {}) {
  const lesson = {
    id: 'lesson1',
    slug: '10-what-are-cves',
    title: lessonTitle,
    content_items: contentItems ?? [{ id: 'item1', file: 'lessons/10/content-item1.html', order: 1 }]
  };

  return {
    courseDir: 'Crush-Your-CVEs',
    courseDetails: { id: 'course1', title: courseTitle },
    lessons: [lesson],
    upstreamCourse: { id: 'course1', title: upstreamCourseTitle },
    upstreamLessonsById: upstreamLessons
      ?? new Map([['lesson1', { id: 'lesson1', title: upstreamLessonTitle }]]),
    upstreamItemsByLessonId: upstreamItems
      ?? new Map([['lesson1', new Map([['item1', { id: 'item1', content_html: upstreamHtml }]])]]),
    localHtmlByItemId: localHtmlByItemId ?? new Map([['item1', localHtml]]),
    lessonFilter
  };
}

test('a course that matches upstream produces no actions', () => {
  const { actions, warnings, inSyncCount } = planCourse(fixture());
  assert.deepEqual(actions, []);
  assert.deepEqual(warnings, []);
  assert.equal(inSyncCount, 3); // course title, lesson title, content item
});

test('whitespace-only markup differences are not changes', () => {
  const { actions } = planCourse(fixture({
    localHtml: '<div>\n    <p>Hi</p>\n</div>',
    upstreamHtml: '<div>\r\n  <p>Hi</p>\r\n</div>'
  }));
  assert.deepEqual(actions, []);
});

test('a real content edit becomes a content action carrying both sides', () => {
  const { actions } = planCourse(fixture({
    localHtml: '<p>New body</p>',
    upstreamHtml: '<p>Old body</p>'
  }));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'content');
  assert.equal(actions[0].endpoint, '/lessons/lesson1/content-items/item1');
  assert.equal(actions[0].lessonId, 'lesson1');
  assert.equal(actions[0].localValue, '<p>New body</p>');
  assert.equal(actions[0].upstreamValue, '<p>Old body</p>');
});

test('title changes become PATCHable text actions on the right endpoints', () => {
  const { actions } = planCourse(fixture({
    courseTitle: 'Crush your CVEs, faster',
    lessonTitle: 'What even are CVEs?'
  }));
  assert.deepEqual(actions.map(a => [a.kind, a.endpoint, a.field]), [
    ['text', '/courses/course1', 'title'],
    ['text', '/lessons/lesson1', 'title']
  ]);
});

// The course title belongs to the whole course, so --lesson must not touch it
// even when it differs. The old implementation skipped the course-title fetch
// entirely in that case; this preserves that.
test('a lesson filter leaves the course title alone', () => {
  const { actions } = planCourse(fixture({
    courseTitle: 'A different course title',
    lessonFilter: '10-what-are-cves'
  }));
  assert.deepEqual(actions.map(a => a.label), []);
});

test('a lesson filter excludes lessons that do not match', () => {
  const { actions } = planCourse(fixture({
    localHtml: '<p>New</p>',
    upstreamHtml: '<p>Old</p>',
    lessonFilter: 'some-other-lesson'
  }));
  assert.deepEqual(actions, []);
});

// Actions are consumed as a prompt queue, so their order is what the operator
// experiences. Course title, then each lesson's title before its content.
test('actions come out in reading order', () => {
  const plan = planCourse({
    ...fixture({ courseTitle: 'Changed course' }),
    lessons: [
      { id: 'lesson1', slug: 'a', title: 'Local A', content_items: [{ id: 'item1', file: 'a.html' }] },
      { id: 'lesson2', slug: 'b', title: 'Local B', content_items: [{ id: 'item2', file: 'b.html' }] }
    ],
    upstreamLessonsById: new Map([
      ['lesson1', { id: 'lesson1', title: 'Upstream A' }],
      ['lesson2', { id: 'lesson2', title: 'Upstream B' }]
    ]),
    upstreamItemsByLessonId: new Map([
      ['lesson1', new Map([['item1', { id: 'item1', content_html: 'old a' }]])],
      ['lesson2', new Map([['item2', { id: 'item2', content_html: 'old b' }]])]
    ]),
    localHtmlByItemId: new Map([['item1', 'new a'], ['item2', 'new b']])
  });

  assert.deepEqual(plan.actions.map(a => a.label), [
    'course title (Changed course)',
    'lesson title (Local A)',
    'content-item item1',
    'lesson title (Local B)',
    'content-item item2'
  ]);
});

// The pull records HTML files it found on disk but could not match upstream
// with `id: null`. The old push built `/content-items/null`, took a 404 and
// exited, so one stray file killed a whole run.
test('a content item with no upstream id warns instead of aborting', () => {
  const { actions, warnings } = planCourse(fixture({
    contentItems: [
      { id: null, file: 'lessons/10/orphan.html', order: 2 },
      { id: 'item1', file: 'lessons/10/content-item1.html', order: 1 }
    ],
    localHtml: '<p>New</p>',
    upstreamHtml: '<p>Old</p>'
  }));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /orphan\.html has no upstream content-item id/);
  // The real item alongside it is still planned.
  assert.deepEqual(actions.map(a => a.itemId), ['item1']);
});

test('a lesson missing upstream warns and does not stop the rest', () => {
  const plan = planCourse({
    ...fixture(),
    lessons: [
      { id: 'gone', slug: 'a', title: 'Deleted upstream', content_items: [] },
      { id: 'lesson1', slug: 'b', title: 'Still here', content_items: [{ id: 'item1', file: 'b.html' }] }
    ],
    upstreamLessonsById: new Map([['lesson1', { id: 'lesson1', title: 'Still here' }]]),
    localHtmlByItemId: new Map([['item1', '<p>New</p>']]),
    upstreamItemsByLessonId: new Map([
      ['lesson1', new Map([['item1', { id: 'item1', content_html: '<p>Old</p>' }]])]
    ])
  });

  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /lesson gone .* not in Crush-Your-CVEs upstream/);
  assert.deepEqual(plan.actions.map(a => a.itemId), ['item1']);
});

test('a content item missing upstream warns rather than being pushed blindly', () => {
  const { actions, warnings } = planCourse(fixture({
    upstreamItems: new Map([['lesson1', new Map()]])
  }));
  assert.deepEqual(actions, []);
  assert.match(warnings[0], /content item item1 .* not in lesson lesson1 upstream/);
});

test('a lessons-meta entry with no file on disk warns', () => {
  const { actions, warnings } = planCourse(fixture({ localHtmlByItemId: new Map() }));
  assert.deepEqual(actions, []);
  assert.match(warnings[0], /missing on disk/);
});

// Titles are compared trimmed, matching the old syncTextField.
test('leading and trailing whitespace on a title is not a change', () => {
  const { actions } = planCourse(fixture({
    courseTitle: '  Crush your CVEs  ',
    lessonTitle: 'What are CVEs? '
  }));
  assert.deepEqual(actions, []);
});

// The apply phase stamps description_html onto this object and then writes
// lessons-meta.json from it, so it has to be the caller's live lesson object
// rather than a copy.
test('a content action carries the live lesson object', () => {
  const args = fixture({ localHtml: '<p>New</p>', upstreamHtml: '<p>Old</p>' });
  const { actions } = planCourse(args);
  assert.equal(actions[0].lesson, args.lessons[0]);
});
