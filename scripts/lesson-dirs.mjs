/**
 * lesson-dirs.mjs — resolve which directory under a course holds a lesson.
 *
 * The same problem course-dirs.mjs exists for shows up one level down: a
 * Skilljar lesson title (and thus its slugified directory name) is mutable,
 * but the lesson id is not. Naming a lesson directory from its title on every
 * sync creates a second directory whenever an editor rewords or re-cases a
 * lesson title upstream, and the old one is never cleaned up. Two directories
 * that differ only in case also collide on a case-insensitive filesystem,
 * which is the macOS default — this is exactly how the courses repo ended up
 * with 508 duplicate lesson-directory pairs (fixed there in a one-time
 * cleanup; see chainguard-dev/courses tools/dedupe-lesson-dirs.mjs).
 *
 * So the id decides the directory, same as at the course level. Unlike
 * course ids, a lesson's id -> slug history doesn't need a directory scan to
 * discover — it's already recorded centrally in the course's own
 * lessons-meta.json from the previous run, which readLessonDirIndex reads
 * before this run overwrites it.
 *
 * A lesson directory name is pinned in full once assigned, including its
 * numeric order prefix — if a lesson is later reordered upstream, the local
 * directory's prefix can drift from the live order. That's an accepted,
 * cosmetic-only tradeoff: no build tooling in the courses repo reads
 * directory listing order for lesson sequencing, only lessons-meta.json's
 * own `order` field, which always reflects the current sync.
 */
import fs from 'fs-extra';
import path from 'path';
import { slugify } from './course-dirs.mjs';

/**
 * Reads a course's existing lessons-meta.json (if any) and indexes it by
 * lesson id.
 *
 * Returns:
 *   byId        Map lesson id -> directory name to write into
 *   takenLower  Map lowercased directory name -> directory name, for every
 *               slug already on record, so a new lesson can't collide with
 *               one that already has a home
 */
export async function readLessonDirIndex(courseDir) {
  const byId = new Map();
  const takenLower = new Map();

  let meta;
  try {
    meta = await fs.readJson(path.join(courseDir, 'lessons-meta.json'));
  } catch {
    return { byId, takenLower };
  }
  if (!Array.isArray(meta)) return { byId, takenLower };

  for (const lesson of meta) {
    if (typeof lesson?.id !== 'string' || !lesson.id) continue;
    if (typeof lesson?.slug !== 'string' || !lesson.slug) continue;
    byId.set(lesson.id, lesson.slug);
    takenLower.set(lesson.slug.toLowerCase(), lesson.slug);
  }

  return { byId, takenLower };
}

/**
 * Returns the directory name to write `lesson` into, and reserves it.
 *
 * An id that already has a directory keeps that directory's name exactly,
 * whatever the title or order now say. A new id is named from its order and
 * title, with the id appended if that name is already taken. Name
 * comparison is case-insensitive because the target filesystem is.
 *
 * Mutates `index`, so calling it again for the same lesson returns the same
 * name, and two new lessons sharing a title cannot claim the same directory.
 */
export function resolveLessonDirName(index, lesson) {
  const existing = index.byId.get(lesson.id);
  if (existing) return existing;

  const base = `${lesson.order.toString().padStart(2, '0')}-${slugify(lesson.title || '') || lesson.id}`;

  let candidate = [base, `${base}-${lesson.id}`]
    .find((name) => !index.takenLower.has(name.toLowerCase()));

  if (!candidate) {
    let n = 2;
    do {
      candidate = `${base}-${lesson.id}-${n++}`;
    } while (index.takenLower.has(candidate.toLowerCase()));
  }

  index.byId.set(lesson.id, candidate);
  index.takenLower.set(candidate.toLowerCase(), candidate);
  return candidate;
}
