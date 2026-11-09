/**
 * report.mjs — maps audit events onto the local course tree.
 *
 * Event target ids are documented as opaque, but lesson, section and course
 * targets carry the same ids as v2's lessons and courses, which are also
 * v1's and therefore the ids in details.json and lessons-meta.json. An id the
 * tree does not have is a lesson or course created since the pull, one in a
 * course that was never pulled, or one since deleted; `resolveUnknownTargets`
 * asks the API which.
 */
import fs from 'fs-extra';
import path from 'path';
import { listCourseDirs } from '#lib/content/course-dirs.mjs';
import { mapWithConcurrency } from '#lib/concurrency.mjs';
import { LESSON_TARGET_TYPES, classifyEvent } from '#lib/drift/audit-events.mjs';

export const KINDS = ['content', 'structure', 'settings'];

async function readJsonOrNull(file) {
  try {
    return await fs.readJson(file);
  } catch {
    return null;
  }
}

/**
 * Indexes the content tree: courses by id from details.json, lessons by id
 * from lessons-meta.json. A directory without a readable details.json is not
 * a course. Where two directories carry one id, the first in sort order wins,
 * as it does for pull.
 */
export async function readLocalTree(contentPath) {
  const courses = new Map();
  const lessons = new Map();
  for (const dir of await listCourseDirs(contentPath)) {
    const details = await readJsonOrNull(path.join(contentPath, dir, 'details.json'));
    if (typeof details?.id !== 'string' || courses.has(details.id)) continue;
    courses.set(details.id, { id: details.id, dir, title: details.title ?? dir });
    const meta = await readJsonOrNull(path.join(contentPath, dir, 'lessons-meta.json'));
    for (const lesson of Array.isArray(meta) ? meta : []) {
      if (lesson?.id && !lessons.has(lesson.id)) {
        lessons.set(lesson.id, { id: lesson.id, courseId: details.id, title: lesson.title ?? lesson.slug ?? lesson.id, type: lesson.type ?? null, order: lesson.order ?? null });
      }
    }
  }
  return { courses, lessons };
}

/**
 * The local courses a `--course` query names: an exact directory name or id
 * if one matches, and otherwise every course whose directory or title
 * contains the query, ignoring case.
 */
export function matchCourses(courses, query) {
  const all = [...courses.values()];
  const exact = all.filter((c) => c.dir === query || c.id === query);
  if (exact.length) return exact;
  const q = String(query).toLowerCase();
  return all.filter((c) => c.dir.toLowerCase().includes(q) || String(c.title).toLowerCase().includes(q));
}

/**
 * For ids the tree does not have, whether they still exist upstream: each
 * lesson with its course, then each course. GETs only, one per id.
 * A 404 means deleted; any other failure is thrown to the caller.
 *
 * Returns { lessons: Map id -> { exists, courseId?, title? },
 *           courses: Map id -> { exists, title? } }.
 */
export async function resolveUnknownTargets(client, { lessonIds = [], courseIds = [] }, { concurrency = 6 } = {}) {
  const read = async (url) => {
    try {
      return (await client.get(url)).data?.data ?? null;
    } catch (err) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  };

  const lessons = new Map();
  await mapWithConcurrency([...new Set(lessonIds)], concurrency, async (id) => {
    const record = await read(`/lessons/${encodeURIComponent(id)}`);
    lessons.set(id, record
      ? { exists: true, courseId: record.attributes?.course_id ?? null, title: record.attributes?.title ?? null }
      : { exists: false });
  });

  const wantCourses = new Set(courseIds);
  for (const r of lessons.values()) if (r.courseId) wantCourses.add(r.courseId);
  const courses = new Map();
  await mapWithConcurrency([...wantCourses], concurrency, async (id) => {
    const record = await read(`/courses/${encodeURIComponent(id)}`);
    courses.set(id, record ? { exists: true, title: record.attributes?.title ?? null } : { exists: false });
  });

  return { lessons, courses };
}

/**
 * The ids in `events` that the local tree does not have, for
 * `resolveUnknownTargets`.
 */
export function unknownTargets(events, local) {
  const lessonIds = new Set();
  const courseIds = new Set();
  for (const e of events) {
    if (LESSON_TARGET_TYPES.includes(e.targetType)) {
      if (!local.lessons.has(e.targetId)) lessonIds.add(e.targetId);
    } else if (!local.courses.has(e.targetId)) {
      courseIds.add(e.targetId);
    }
  }
  return { lessonIds: [...lessonIds], courseIds: [...courseIds] };
}

function changeLabel(event) {
  if (!event.field) return event.action;
  return event.action === 'update' ? event.field : `${event.action} ${event.field}`;
}

function emptyCounts() {
  return Object.fromEntries(KINDS.map((k) => [k, 0]));
}

// Collapses a target's events into one line per kind of change, so twenty
// saves of one lesson's HTML read as "HTML ×20" with a first and last date.
function summariseChanges(events) {
  const byLabel = new Map();
  for (const e of events) {
    const label = changeLabel(e);
    const kind = classifyEvent(e);
    const c = byLabel.get(label) ?? { label, kind, count: 0, first: e.createdAt, last: e.createdAt };
    c.count += 1;
    if (e.createdAt < c.first) c.first = e.createdAt;
    if (e.createdAt > c.last) c.last = e.createdAt;
    if (e.actor) (c.actors ??= new Set()).add(e.actor);
    byLabel.set(label, c);
  }
  return [...byLabel.values()]
    .map((c) => (c.actors ? { ...c, actors: [...c.actors].sort() } : c))
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || b.last.localeCompare(a.last));
}

function countKinds(changes) {
  const counts = emptyCounts();
  for (const c of changes) counts[c.kind] += c.count;
  return counts;
}

const lastOf = (changes) => changes.reduce((max, c) => (c.last > max ? c.last : max), '');

// Most destructive first: anything with a content edit, then structure, then
// the rest; within that, the most recently touched.
function byConcern(a, b) {
  for (const k of ['content', 'structure']) {
    if (Boolean(a.counts[k]) !== Boolean(b.counts[k])) return a.counts[k] ? -1 : 1;
  }
  return b.last.localeCompare(a.last);
}

/**
 * Builds the report.
 *
 *   events     slim audit events (see slimEvent)
 *   local      readLocalTree's result
 *   resolved   resolveUnknownTargets's result, or empty maps
 *   courseIds  when set, only events attributable to these courses count;
 *              events on deleted objects, whose course is unknown, are
 *              dropped and counted in `unattributed`
 *
 * Returns { courses, deleted, totals, unattributed }. `courses` holds every
 * course with an event: local ones (`inTree`), ones only upstream, and
 * deleted ones (`existsUpstream` false), whose lessons can outlive them: a
 * course deleted in the dashboard leaves its lessons readable. `deleted`
 * holds lessons that no longer exist and are not in the tree, so no course
 * can be named for them.
 */
export function buildDriftReport({ events, local, resolved = { lessons: new Map(), courses: new Map() }, courseIds = null }) {
  const courseEvents = new Map(); // courseId -> { course: [], lessons: Map lessonId -> [] }
  const deletedEvents = new Map(); // targetId -> []
  let unattributed = 0;

  const bucket = (courseId) => {
    if (!courseEvents.has(courseId)) courseEvents.set(courseId, { course: [], lessons: new Map() });
    return courseEvents.get(courseId);
  };

  for (const e of events) {
    const isLesson = LESSON_TARGET_TYPES.includes(e.targetType);
    let courseId = null;
    if (isLesson) {
      courseId = local.lessons.get(e.targetId)?.courseId ?? resolved.lessons.get(e.targetId)?.courseId ?? null;
    } else if (local.courses.has(e.targetId) || resolved.courses.has(e.targetId)) {
      courseId = e.targetId;
    }

    if (courseIds && !(courseId && courseIds.has(courseId))) {
      if (!courseId) unattributed += 1;
      continue;
    }
    if (!courseId) {
      if (!deletedEvents.has(e.targetId)) deletedEvents.set(e.targetId, []);
      deletedEvents.get(e.targetId).push(e);
      continue;
    }

    const b = bucket(courseId);
    if (isLesson) {
      if (!b.lessons.has(e.targetId)) b.lessons.set(e.targetId, []);
      b.lessons.get(e.targetId).push(e);
    } else {
      b.course.push(e);
    }
  }

  const courses = [...courseEvents].map(([courseId, b]) => {
    const localCourse = local.courses.get(courseId);
    const lessons = [...b.lessons].map(([lessonId, evs]) => {
      const localLesson = local.lessons.get(lessonId);
      const upstream = resolved.lessons.get(lessonId);
      const changes = summariseChanges(evs);
      return {
        id: lessonId,
        title: localLesson?.title ?? upstream?.title ?? evs[0].targetName ?? lessonId,
        type: localLesson?.type ?? evs[0].targetType,
        inTree: Boolean(localLesson),
        existsUpstream: localLesson ? !evs.some((e) => e.action === 'delete') : Boolean(upstream?.exists),
        changes,
        counts: countKinds(changes),
        last: lastOf(changes)
      };
    }).sort(byConcern);
    const courseChanges = summariseChanges(b.course);
    const counts = emptyCounts();
    for (const x of [...lessons, { counts: countKinds(courseChanges) }]) for (const k of KINDS) counts[k] += x.counts[k];
    return {
      id: courseId,
      dir: localCourse?.dir ?? null,
      title: localCourse?.title ?? resolved.courses.get(courseId)?.title ?? b.course[0]?.targetName ?? courseId,
      inTree: Boolean(localCourse),
      existsUpstream: localCourse ? !b.course.some((e) => e.action === 'delete') : Boolean(resolved.courses.get(courseId)?.exists),
      changes: courseChanges,
      lessons,
      counts,
      last: [lastOf(courseChanges), ...lessons.map((l) => l.last)].sort().at(-1)
    };
  }).sort((a, b) => (a.inTree === b.inTree ? byConcern(a, b) : a.inTree ? -1 : 1));

  const deleted = [...deletedEvents].map(([id, evs]) => {
    const changes = summariseChanges(evs);
    return { id, targetType: evs[0].targetType, title: evs[0].targetName ?? id, changes, counts: countKinds(changes), last: lastOf(changes) };
  }).sort((a, b) => b.last.localeCompare(a.last));

  const totals = { events: 0, ...emptyCounts(), courses: courses.filter((c) => c.inTree).length };
  for (const x of [...courses, ...deleted]) {
    for (const k of KINDS) totals[k] += x.counts[k];
  }
  totals.events = KINDS.reduce((n, k) => n + totals[k], 0);

  return { courses, deleted, totals, unattributed };
}

/**
 * The report without anything that names a person, for --json and anywhere
 * else that might be kept: CI logs, files, the content repo.
 */
export function withoutActors(report) {
  const strip = (changes) => changes.map(({ actors, ...c }) => c);
  return {
    ...report,
    courses: report.courses.map((c) => ({ ...c, changes: strip(c.changes), lessons: c.lessons.map((l) => ({ ...l, changes: strip(l.changes) })) })),
    deleted: report.deleted.map((d) => ({ ...d, changes: strip(d.changes) }))
  };
}
