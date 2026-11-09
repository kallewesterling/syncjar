/**
 * empty-content.mjs — decide whether pull may replace a lesson content file
 * that has content with one that has none.
 *
 * An emptied content file is the most expensive mistake a pull can make,
 * because the next push sends it upstream and empties the live lesson. Atomic
 * writes (atomic-write.mjs) stop an interrupted pull from producing one. This
 * guards the other route: a read that comes back empty when the content is
 * not.
 *
 * A list read can't settle it alone. Pull gets content from the content-items
 * list with `include_content`, a parameter Skilljar's spec doesn't document,
 * and Skilljar has form here: `GET /lessons` carries a `content_html` that is
 * empty for every MODULAR lesson whatever the lesson holds. So an empty value
 * from the list is confirmed with the documented single-item read,
 * `GET /lessons/{id}/content-items/{id}`:
 *
 * - The item read has content: the list was wrong, and the item read's
 *   content is written.
 * - The item read is an empty string: Skilljar really has the item empty,
 *   and the empty file is written, with a warning.
 * - The item read fails, or has no `content_html` at all: nothing proves the
 *   item is empty, so the existing file is kept, with a warning.
 *
 * The extra request is only made when the local file has content and the
 * list says it shouldn't, which a healthy pull never sees.
 */
import fs from 'fs/promises';

export function isBlankHtml(html) {
  return typeof html !== 'string' || html.trim() === '';
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Returns `{ action: 'write', html, warning? }` or `{ action: 'keep', warning }`.
 *
 * `confirm()` makes the single-item read and resolves to its `content_html`,
 * as returned. It is only called when the existing file has content and
 * `html` has none. If it throws, the error should already be safe to print;
 * only its message is used.
 */
export async function resolveContentWrite({ target, html, confirm, readExisting = readIfExists }) {
  if (!isBlankHtml(html)) return { action: 'write', html };

  const existing = await readExisting(target);
  if (isBlankHtml(existing)) return { action: 'write', html: typeof html === 'string' ? html : '' };

  let confirmed;
  try {
    confirmed = await confirm();
  } catch (err) {
    return {
      action: 'keep',
      warning: `Skilljar's content list returned this item empty, and the single-item read to confirm it failed (${err.message}). Kept the existing file.`
    };
  }

  if (!isBlankHtml(confirmed)) {
    return {
      action: 'write',
      html: confirmed,
      warning: 'Skilljar\'s content list returned this item empty, but the single-item read has content. Wrote that instead.'
    };
  }
  if (typeof confirmed === 'string') {
    return {
      action: 'write',
      html: confirmed,
      warning: 'Skilljar has this item empty, confirmed by a second read, so the local file is now empty too. Check the lesson in Skilljar before committing this.'
    };
  }
  return {
    action: 'keep',
    warning: 'Skilljar returned no content for this item, and the single-item read had no content_html field at all. Kept the existing file.'
  };
}
