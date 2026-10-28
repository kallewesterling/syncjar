/**
 * course-settings.mjs — decide which course-level settings `push:course-settings`
 * would write, and check afterwards that nothing else moved.
 *
 * `push` writes titles and content, and its skip state hashes exactly those,
 * so a setting edited in details.json never reaches Skilljar through it. This
 * is the separate path for settings, and it writes only the fields named in
 * COURSE_SETTING_FIELDS. details.json also carries descriptions, labels and
 * the title, and none of those may be written from here: the allowlist is
 * what makes "nothing else changes" a property of the code rather than of
 * the caller's care.
 *
 * Writes go through `PATCH /courses/{id}` with a body of only the changed
 * fields. Tested on 2026-10-28 against a throwaway staging course: a PATCH of
 * `enforce_sequential_navigation` alone returned 200, the read-back changed
 * that field and `modified_at` and nothing else, and setting it back restored
 * the record. `PUT` is the wrong verb here: it requires `title` and
 * `short_description`, so it would rewrite them.
 */

export const COURSE_SETTING_FIELDS = ['enforce_sequential_navigation'];

// Skilljar sets this on every write, so it is expected to move.
const ALWAYS_CHANGES = new Set(['modified_at']);

/**
 * Compares local details.json settings with the upstream course records.
 *
 *   locals        [{ courseDir, details }] — details is the parsed details.json
 *   upstreamById  Map course id -> record from `GET /courses`
 *
 * Returns `{ changes, inSync, warnings }`. Each change is
 * `{ courseId, courseDir, title, field, from, to }`. A details.json without
 * the field is not a change: it has no opinion, and an older pull would not
 * have written it.
 */
export function planCourseSettings({ locals, upstreamById, fields = COURSE_SETTING_FIELDS }) {
  const changes = [];
  const warnings = [];
  let inSync = 0;

  for (const { courseDir, details } of locals) {
    const upstream = upstreamById.get(details.id);
    if (!upstream) {
      warnings.push(`course ${details.id} ("${courseDir}") is not in the Skilljar catalog — pull to reconcile`);
      continue;
    }

    for (const field of fields) {
      if (!(field in details)) continue;
      const to = details[field];
      if (typeof to !== 'boolean') {
        warnings.push(`${courseDir}/details.json: ${field} is ${JSON.stringify(to)}, not true or false — not pushing it`);
        continue;
      }
      if (upstream[field] === to) {
        inSync += 1;
        continue;
      }
      changes.push({
        courseId: details.id,
        courseDir,
        title: upstream.title ?? details.title,
        field,
        from: upstream[field],
        to
      });
    }
  }

  return { changes, inSync, warnings };
}

/**
 * Groups changes into one PATCH body per course, in first-seen order.
 * Returns `[{ courseId, courseDir, title, body }]`.
 */
export function patchBodies(changes) {
  const byCourse = new Map();
  for (const c of changes) {
    if (!byCourse.has(c.courseId)) {
      byCourse.set(c.courseId, { courseId: c.courseId, courseDir: c.courseDir, title: c.title, body: {} });
    }
    byCourse.get(c.courseId).body[c.field] = c.to;
  }
  return [...byCourse.values()];
}

/**
 * Checks the course records read after the writes against the records read
 * before them. A 200 is not taken as proof: Skilljar has accepted writes
 * before and changed nothing (see CLAUDE.md, "Quiz writes").
 *
 * Returns a list of problems; empty means every intended field landed and no
 * other field on any written course moved.
 */
export function verifyCourseSettings({ changes, before, after }) {
  const problems = [];

  for (const { courseId, courseDir, body } of patchBodies(changes)) {
    const was = before.get(courseId);
    const now = after.get(courseId);
    if (!now) {
      problems.push(`${courseDir}: course ${courseId} is missing from the catalog after the write`);
      continue;
    }

    for (const [field, value] of Object.entries(body)) {
      if (now[field] !== value) {
        problems.push(`${courseDir}: ${field} is ${JSON.stringify(now[field])} upstream, expected ${JSON.stringify(value)}`);
      }
    }

    const keys = new Set([...Object.keys(was ?? {}), ...Object.keys(now)]);
    for (const key of keys) {
      if (key in body || ALWAYS_CHANGES.has(key)) continue;
      if (JSON.stringify(was?.[key]) !== JSON.stringify(now[key])) {
        problems.push(`${courseDir}: ${key} changed unexpectedly (${JSON.stringify(was?.[key])} → ${JSON.stringify(now[key])})`);
      }
    }
  }

  return problems;
}
