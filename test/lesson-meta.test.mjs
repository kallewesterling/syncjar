import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitContentItems,
  describeNonHtmlItem,
  buildLessonEntry
} from '#lib/content/lesson-meta.mjs';

// Invented sample data. Mirrors the shape of `GET /lessons` and
// `GET /lessons/{id}/content-items`, not any real course.
const lesson = {
  id: 'lessonA',
  course_id: 'courseA',
  title: 'Check your understanding',
  order: 30,
  type: 'MODULAR',
  optional: false,
  time_seconds: 0,
  search_keywords: '',
  tooltip_html: null,
  display_fullscreen: false,
  content_html: '',
  content_quiz_id: null,
  content_asset_id: null,
  content_web_package_id: null,
  description_html: '<p>A short check.</p>'
};

const htmlItem = { id: 'itemH', type: 'HTML', header: 'Intro', order: 1, content_html: '<p>Hi</p>' };
const quizItem = {
  id: 'itemQ', type: 'QUIZ', header: '', order: 2,
  content_html: '', content_quiz_id: 'quizA', content_asset_id: null, content_rating_id: null
};
const assetItem = { id: 'itemA', type: 'ASSET', header: 'Diagram', order: 3, content_asset_id: 'assetA' };

test('splitContentItems separates HTML items from quiz, asset and rating items', () => {
  const { html, other } = splitContentItems([htmlItem, quizItem, assetItem]);
  assert.deepEqual(html.map(i => i.id), ['itemH']);
  assert.deepEqual(other.map(i => i.id), ['itemQ', 'itemA']);
});

test('an item with no type but with HTML is treated as HTML', () => {
  const { html, other } = splitContentItems([{ id: 'x', content_html: '<p>x</p>' }]);
  assert.equal(html.length, 1);
  assert.equal(other.length, 0);
});

// Push PUTs every file back with type HTML, so writing a non-HTML item as a
// file would turn it into a page on the next push.
test('a non-HTML item is never treated as a file, even with content_html', () => {
  const { html, other } = splitContentItems([{ ...quizItem, content_html: '<p>stray</p>' }]);
  assert.equal(html.length, 0);
  assert.equal(other.length, 1);
});

test('an empty HTML item is dropped, as before', () => {
  const { html, other } = splitContentItems([{ ...htmlItem, content_html: '' }]);
  assert.equal(html.length, 0);
  assert.equal(other.length, 0);
});

test('describeNonHtmlItem keeps the reference and drops unset fields', () => {
  assert.deepEqual(describeNonHtmlItem(quizItem), {
    id: 'itemQ', type: 'QUIZ', order: 2, content_quiz_id: 'quizA'
  });
  assert.deepEqual(describeNonHtmlItem(assetItem), {
    id: 'itemA', type: 'ASSET', order: 3, header: 'Diagram', content_asset_id: 'assetA'
  });
});

test('buildLessonEntry keeps the lesson fields the pull used to drop', () => {
  const entry = buildLessonEntry({ lesson, slug: '30-Check', contentItems: [] });
  assert.equal(entry.type, 'MODULAR');
  assert.equal(entry.optional, false);
  assert.equal(entry.time_seconds, 0);
  for (const unset of ['search_keywords', 'tooltip_html', 'content_quiz_id', 'content_asset_id', 'content_web_package_id']) {
    assert.equal(unset in entry, false, `${unset} should be omitted`);
  }
  assert.equal('content_html' in entry, false);
  assert.equal('course_id' in entry, false);
});

// Everything existing consumers read has to stay exactly where it was.
test('buildLessonEntry keeps the original keys and values', () => {
  const contentItems = [{ id: 'itemH', file: 'lessons/30-Check/intro-itemH.html', order: 1 }];
  const entry = buildLessonEntry({ lesson, slug: '30-Check', contentItems });
  assert.equal(entry.id, 'lessonA');
  assert.equal(entry.slug, '30-Check');
  assert.equal(entry.title, 'Check your understanding');
  assert.equal(entry.order, 30);
  assert.equal(entry.description_html, '<p>A short check.</p>');
  assert.deepEqual(entry.content_items, contentItems);
});

test('buildLessonEntry writes description_html as an empty string when unset', () => {
  const entry = buildLessonEntry({ lesson: { ...lesson, description_html: null }, slug: 's', contentItems: [] });
  assert.equal(entry.description_html, '');
});

test('non_html_items is omitted for a lesson that has none', () => {
  const entry = buildLessonEntry({ lesson, slug: 's', contentItems: [] });
  assert.equal('non_html_items' in entry, false);
});

test('non_html_items is sorted by order, whatever order the API returned', () => {
  const entry = buildLessonEntry({
    lesson, slug: 's', contentItems: [], nonHtmlItems: [assetItem, quizItem]
  });
  assert.deepEqual(entry.non_html_items.map(i => i.id), ['itemQ', 'itemA']);
});

// A quiz can be linked from more than one lesson; each lesson records its own
// reference, and neither is dropped.
test('two lessons can reference the same quiz', () => {
  const a = buildLessonEntry({ lesson, slug: 'a', contentItems: [], nonHtmlItems: [quizItem] });
  const b = buildLessonEntry({
    lesson: { ...lesson, id: 'lessonB' }, slug: 'b', contentItems: [],
    nonHtmlItems: [{ ...quizItem, id: 'itemQ2' }]
  });
  assert.equal(a.non_html_items[0].content_quiz_id, 'quizA');
  assert.equal(b.non_html_items[0].content_quiz_id, 'quizA');
});
