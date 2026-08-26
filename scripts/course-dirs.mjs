/**
 * course-dirs.mjs — resolve which directory under COURSE_CONTENT_PATH holds a course.
 *
 * A Skilljar course title is mutable; the course id is not. Naming a directory
 * after the title therefore creates a second directory whenever an editor
 * rewords or re-cases a title, leaving the old directory behind with the same
 * course id inside its details.json. Two directories that differ only in case
 * also collide on a case-insensitive filesystem, which is the macOS default.
 *
 * So the id decides the directory. Each course directory records its id in
 * details.json, which lets us map id -> existing directory name and reuse that
 * name verbatim. A title only names a directory when the id is new to the tree.
 */
import fs from 'fs-extra';
import path from 'path';

// Turns a title into a directory-safe name. Deliberately preserves case, so
// this is only ever used for ids that have no directory yet.
export function slugify(text) {
  return text
    .toString()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Course directories are real directories only. The content path also holds
// generated JSON files (course-urls.json and friends) and may hold dotfiles.
export async function listCourseDirs(contentPath) {
  let entries;
  try {
    entries = await fs.readdir(contentPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
}

/**
 * Reads every course directory's details.json and indexes it by course id.
 *
 * Returns:
 *   byId        Map id -> directory name to write into
 *   duplicates  Map id -> every directory carrying that id, when more than one
 *   takenLower  Map lowercased directory name -> directory name, for every
 *               directory present, including ones we could not identify
 *   unidentified  directory names with no readable details.json id
 */
export async function readCourseDirIndex(contentPath) {
  const byId = new Map();
  const duplicates = new Map();
  const takenLower = new Map();
  const unidentified = [];

  for (const dir of await listCourseDirs(contentPath)) {
    // Reserve the name even if we cannot identify the course. An unidentified
    // directory still occupies its name on disk.
    takenLower.set(dir.toLowerCase(), dir);

    let id = null;
    try {
      const details = await fs.readJson(path.join(contentPath, dir, 'details.json'));
      if (typeof details?.id === 'string' && details.id) id = details.id;
    } catch {
      // No details.json, or it is not readable JSON.
    }

    if (!id) {
      unidentified.push(dir);
      continue;
    }

    if (byId.has(id)) {
      // The tree is already dirty for this id. Keep the first directory in sort
      // order so the choice does not drift between runs, and report the rest so
      // a human can delete them. Writing to only one of them is what stops the
      // duplication from growing.
      const all = duplicates.get(id) ?? [byId.get(id)];
      all.push(dir);
      duplicates.set(id, all);
      continue;
    }

    byId.set(id, dir);
  }

  return { byId, duplicates, takenLower, unidentified };
}

/**
 * Returns the directory name to write `course` into, and reserves it.
 *
 * An id that already has a directory keeps that directory's name exactly,
 * whatever the title now says. A new id is named from its title, with the id
 * appended if that name is already taken. Name comparison is case-insensitive
 * because the target filesystem is.
 *
 * Mutates `index`, so calling it again for the same course returns the same
 * name, and two new courses sharing a title cannot claim the same directory.
 */
export function resolveCourseDirName(index, course) {
  const existing = index.byId.get(course.id);
  if (existing) return existing;

  // A course whose title slugifies to nothing still needs a directory.
  const base = slugify(course.title || '') || course.id;

  let candidate = [base, `${base}-${course.id}`]
    .find(name => !index.takenLower.has(name.toLowerCase()));

  if (!candidate) {
    let n = 2;
    do {
      candidate = `${base}-${course.id}-${n++}`;
    } while (index.takenLower.has(candidate.toLowerCase()));
  }

  index.byId.set(course.id, candidate);
  index.takenLower.set(candidate.toLowerCase(), candidate);
  return candidate;
}
