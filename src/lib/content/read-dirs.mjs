/**
 * read-dirs.mjs — read one JSON file from every content directory.
 */
import fs from 'fs-extra';
import path from 'path';
import { listCourseDirs } from '#lib/content/course-dirs.mjs';

/**
 * Returns `[{ dir, data }]` for each directory under `contentPath` that has
 * `fileName`. A directory without it is skipped: the settings pushes treat a
 * missing file as having no opinion.
 */
export async function readDirFiles(contentPath, fileName) {
  const out = [];
  for (const dir of await listCourseDirs(contentPath)) {
    const file = path.join(contentPath, dir, fileName);
    if (await fs.pathExists(file)) out.push({ dir, data: await fs.readJson(file) });
  }
  return out;
}

/**
 * Keeps the entries whose directory name or id is in `wanted`, and reports
 * any wanted name that matched nothing. An empty `wanted` keeps everything.
 */
export function filterByDirOrId(entries, wanted, idOf) {
  if (!wanted.length) return { kept: entries, unmatched: [] };
  const set = new Set(wanted);
  const kept = entries.filter(e => set.has(e.dir) || set.has(idOf(e)));
  const found = new Set(kept.flatMap(e => [e.dir, idOf(e)]));
  return { kept, unmatched: wanted.filter(w => !found.has(w)) };
}
