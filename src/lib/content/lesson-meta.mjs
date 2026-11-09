/**
 * lesson-meta.mjs — the shape of one lesson's entry in lessons-meta.json.
 *
 * `content_items` lists HTML files, and every consumer — push, preview, the
 * Markdown export, content repos' own tooling — reads `item.file` from each
 * entry. Quiz, asset and rating items have no file, so they go under their
 * own `non_html_items` key rather than into that list.
 */

// Lesson fields kept alongside the ones the pull always wrote. `content_html`
// is left out: it is empty for MODULAR lessons, whose content lives in content
// items, and `course_id` is the directory the file is already in.
export const LESSON_FIELDS = [
  'type',
  'optional',
  'time_seconds',
  'search_keywords',
  'tooltip_html',
  'display_fullscreen',
  'content_quiz_id',
  'content_asset_id',
  'content_web_package_id'
];

const ITEM_FIELDS = ['header', 'content_quiz_id', 'content_asset_id', 'content_rating_id'];

// Unset fields are left out rather than written as null, so a lesson's entry
// grows only by what it actually has. `false` and `0` are values, and stay.
function isSet(value) {
  return value !== null && value !== undefined && value !== '';
}

function pick(record, fields) {
  const out = {};
  for (const field of fields) {
    if (isSet(record[field])) out[field] = record[field];
  }
  return out;
}

/**
 * Splits a lesson's content items into the ones written as HTML files and the
 * ones recorded as metadata only.
 *
 * An item with no `type` is treated as HTML, which is what the pull assumed
 * before it read the field. A non-HTML item is never written as a file even if
 * it carries `content_html`: push PUTs every file back with `type: 'HTML'`,
 * which would turn a quiz into a page.
 */
export function splitContentItems(items) {
  const html = [];
  const other = [];
  for (const item of items) {
    const type = item.type ?? 'HTML';
    if (type === 'HTML') {
      if (item.content_html) html.push(item);
    } else {
      other.push(item);
    }
  }
  return { html, other };
}

export function describeNonHtmlItem(item) {
  return { id: item.id, type: item.type, order: item.order, ...pick(item, ITEM_FIELDS) };
}

/**
 * Builds one lessons-meta.json entry. `contentItems` is the list of HTML file
 * entries the pull has already written; `nonHtmlItems` are raw content items.
 */
export function buildLessonEntry({ lesson, slug, contentItems, nonHtmlItems = [] }) {
  const entry = {
    id: lesson.id,
    slug,
    title: lesson.title,
    order: lesson.order,
    ...pick(lesson, LESSON_FIELDS),
    description_html: lesson.description_html || '',
    content_items: contentItems
  };

  if (nonHtmlItems.length) {
    entry.non_html_items = nonHtmlItems
      .map(describeNonHtmlItem)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
  }

  return entry;
}
