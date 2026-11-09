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
 * undo through the API. See CLAUDE.md, "Settings writes".
 */
import { boolean, planSettings, patchBodies as groupBodies, verifySettings } from '#lib/push/settings.mjs';

// Compared as sets: the order of a course's labels means nothing, and a
// reordering must not become a write.
const labels = {
  validate(value, { knownLabels = new Set() }) {
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

// `course_time` is the displayed time, which Skilljar recomputes: turning on
// the manual-time flag makes it read `manual_course_time`, turning it off
// empties it.
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
 * `{ courseId, courseDir, title, field, from, to }`.
 */
export function planCourseSettings({ locals, upstreamById, knownLabels = new Set(), fields = COURSE_SETTING_FIELDS }) {
  const titles = new Map();
  const targets = locals.map(({ courseDir, details }) => {
    const upstream = upstreamById.get(details.id);
    titles.set(details.id, upstream?.title ?? details.title);
    return {
      id: details.id,
      label: courseDir,
      where: `${courseDir}/details.json`,
      endpoint: `/courses/${details.id}`,
      local: details,
      upstream
    };
  });
  const { changes, inSync, warnings } = planSettings({
    targets,
    fields: Object.fromEntries(fields.map(f => [f, COURSE_SETTINGS[f]])),
    context: { knownLabels },
    missing: (t) => `course ${t.id} ("${t.label}") is not in the Skilljar catalog — pull to reconcile`
  });
  return {
    changes: changes.map(c => ({
      courseId: c.id, courseDir: c.label, title: titles.get(c.id), field: c.field, from: c.from, to: c.to
    })),
    inSync,
    warnings
  };
}

const toEngine = (changes) => changes.map(c => ({
  id: c.courseId, label: c.courseDir, endpoint: `/courses/${c.courseId}`, field: c.field, from: c.from, to: c.to
}));

/**
 * Groups changes into one PATCH body per course, in first-seen order.
 * Returns `[{ courseId, courseDir, title, body }]`.
 */
export function patchBodies(changes) {
  const titles = new Map(changes.map(c => [c.courseId, c.title]));
  return groupBodies(toEngine(changes)).map(b => ({
    courseId: b.id, courseDir: b.label, title: titles.get(b.id), body: b.body
  }));
}

/**
 * Checks the course records read after the writes against the records read
 * before them. Returns a list of problems; empty means every intended field
 * landed and no other field on any written course moved.
 */
export function verifyCourseSettings({ changes, before, after }) {
  return verifySettings({
    changes: toEngine(changes),
    fields: COURSE_SETTINGS,
    before,
    after,
    alwaysChanges: ['modified_at'],
    derived: DERIVED,
    gone: (label) => `${label}: course is missing from the catalog after the write`
  });
}
