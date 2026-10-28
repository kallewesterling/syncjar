/**
 * course-settings.mjs — decide which course-level settings `push:course-settings`
 * would write, and check afterwards that nothing else moved.
 *
 * `push` writes titles and content, and its skip state hashes exactly those,
 * so a setting edited in details.json never reaches Skilljar through it. This
 * is the separate path for settings, and it writes only the fields in
 * COURSE_SETTINGS. details.json also carries the title and descriptions, and
 * neither may be written from here: the allowlist is what makes "nothing else
 * changes" a property of the code rather than of the caller's care.
 *
 * Writes go through `PATCH /courses/{id}` with a body of only the changed
 * fields. Every field below was tested on 2026-10-28 against a throwaway
 * staging course: set, read back, restored, with the whole course record and
 * its published-course record diffed at each step. Each one changed only
 * itself and `modified_at`. `PUT` is the wrong verb here: it requires `title`
 * and `short_description`, so it would rewrite them.
 *
 * Not here, on purpose: `short_description`, `manual_course_time` and
 * `course_and_lesson_time_format` can be set but never cleared again (blank
 * and null are a 400), so a push could leave a course in a state nobody can
 * undo through the API. See CLAUDE.md, "Course settings writes".
 */

const boolean = {
  validate: (value) => (typeof value === 'boolean' ? null : 'not true or false'),
  equal: (a, b) => a === b
};

// Compared as sets: the order of a course's labels means nothing, and a
// reordering must not become a write.
const labels = {
  validate(value, { knownLabels }) {
    if (!Array.isArray(value) || !value.every(l => typeof l === 'string' && l.trim() !== '')) {
      return 'not a list of label names';
    }
    // Only an existing label was tested. What Skilljar does with an unknown
    // name, refuse it or create an organisation-wide label, was not.
    const unknown = value.filter(l => !knownLabels.has(l));
    return unknown.length ? `names labels that do not exist in Skilljar (${unknown.join(', ')})` : null;
  },
  equal: (a, b) => {
    const sa = [...new Set(a ?? [])].sort();
    const sb = [...new Set(b ?? [])].sort();
    return JSON.stringify(sa) === JSON.stringify(sb);
  }
};

export const COURSE_SETTINGS = {
  enforce_sequential_navigation: boolean,
  display_course_and_lesson_time: boolean,
  display_manual_course_time: boolean,
  labels
};

export const COURSE_SETTING_FIELDS = Object.keys(COURSE_SETTINGS);

// Skilljar sets this on every write, so it is expected to move.
const ALWAYS_CHANGES = new Set(['modified_at']);

// Read-only fields Skilljar recomputes from the settings named. `course_time`
// is the displayed time: turning on the manual-time flag makes it read
// `manual_course_time`, turning it off empties it.
const DERIVED = {
  course_time: ['display_course_and_lesson_time', 'display_manual_course_time']
};

/**
 * Compares local details.json settings with the upstream course records.
 *
 *   locals        [{ courseDir, details }] — details is the parsed details.json
 *   upstreamById  Map course id -> record from `GET /courses`
 *   knownLabels   Set of label names from `GET /labels`
 *
 * Returns `{ changes, inSync, warnings }`. Each change is
 * `{ courseId, courseDir, title, field, from, to }`. A details.json without
 * the field is not a change: it has no opinion, and an older pull would not
 * have written it.
 */
export function planCourseSettings({ locals, upstreamById, knownLabels = new Set(), fields = COURSE_SETTING_FIELDS }) {
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
      const spec = COURSE_SETTINGS[field];
      const to = details[field];
      if (spec.equal(upstream[field], to)) {
        inSync += 1;
        continue;
      }
      const problem = spec.validate(to, { knownLabels });
      if (problem) {
        warnings.push(`${courseDir}/details.json: ${field} is ${JSON.stringify(to)}, ${problem} — not pushing it`);
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
      if (!COURSE_SETTINGS[field].equal(now[field], value)) {
        problems.push(`${courseDir}: ${field} is ${JSON.stringify(now[field])} upstream, expected ${JSON.stringify(value)}`);
      }
    }

    const keys = new Set([...Object.keys(was ?? {}), ...Object.keys(now)]);
    for (const key of keys) {
      if (key in body || ALWAYS_CHANGES.has(key)) continue;
      if (DERIVED[key]?.some(source => source in body)) continue;
      if (JSON.stringify(was?.[key]) !== JSON.stringify(now[key])) {
        problems.push(`${courseDir}: ${key} changed unexpectedly (${JSON.stringify(was?.[key])} → ${JSON.stringify(now[key])})`);
      }
    }
  }

  return problems;
}
