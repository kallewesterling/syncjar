/**
 * audit-events.mjs — reading the v2 audit log for dashboard edits.
 *
 * `GET /v2/audit-events/` (scope `audit:read`) records dashboard actions
 * only: API writes, v1 or v2, are not in it. That is what makes it useful
 * here, since a push's own writes cannot show up as drift.
 *
 * Its constraints, observed on 2026-11-06:
 *
 * - One query may span at most 90 days; a longer one is a 422. Datetimes
 *   must carry a timezone, or that is a 422 too.
 * - An unknown `filter[target_type]` value returns no rows rather than an
 *   error, so the types below are the ones actually seen, not guesses.
 * - `channel` was null on every event before July 2025 and `"dashboard"`
 *   after, so filtering on it would drop a year of history.
 * - `old_value` and `new_value` are cut at 100 characters: the log says an
 *   edit happened, it cannot say what the content now is.
 * - `user` carries the dashboard user's id and username, which are personal
 *   data. Nothing here keeps them unless asked to (`keepActors`).
 */
import { listAllV2 } from '#lib/skilljar/client-v2.mjs';

export const MAX_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

// `section` targets are lessons of type SECTION: their ids are lesson ids in
// lessons-meta.json.
export const LESSON_TARGET_TYPES = ['lesson', 'section'];
export const COURSE_TARGET_TYPES = ['course'];
export const AUDIT_TARGET_TYPES = [...LESSON_TARGET_TYPES, ...COURSE_TARGET_TYPES];

/**
 * Splits [since, until] into consecutive windows of at most `maxDays`,
 * oldest first. Adjacent windows share their boundary instant, since both
 * filters are inclusive; `fetchAuditEvents` drops the duplicate.
 */
export function splitWindows(since, until, maxDays = MAX_WINDOW_DAYS) {
  const start = Date.parse(since);
  const end = Date.parse(until);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('splitWindows needs two valid dates.');
  if (start > end) throw new Error(`The since point ${since} is after ${until}.`);
  const windows = [];
  let from = start;
  do {
    const to = Math.min(end, from + maxDays * DAY_MS);
    windows.push({ gte: new Date(from).toISOString(), lte: new Date(to).toISOString() });
    from = to;
  } while (from < end);
  return windows;
}

/**
 * The fields of an audit event that `check:drift` uses. `actor` is only set
 * with `keepActors`, so a report built without it cannot leak a username.
 */
export function slimEvent(record, { keepActors = false } = {}) {
  const a = record.attributes ?? {};
  const slim = {
    id: record.id,
    createdAt: a.created_at,
    action: a.action,
    field: a.field ?? null,
    targetType: a.target?.type,
    targetId: a.target?.id,
    targetName: a.target?.display_name ?? null
  };
  if (keepActors) slim.actor = a.user?.username ?? a.user?.id ?? null;
  return slim;
}

/**
 * Every lesson, section and course event between `since` and `until`,
 * newest first, deduplicated by event id.
 */
export async function fetchAuditEvents(client, { since, until, keepActors = false, targetTypes = AUDIT_TARGET_TYPES, onWindow } = {}) {
  const windows = splitWindows(since, until);
  const byId = new Map();
  for (const type of targetTypes) {
    for (const w of windows) {
      const records = await listAllV2(client, '/audit-events/', {
        'filter[target_type]': type,
        'filter[created_gte]': w.gte,
        'filter[created_lte]': w.lte
      });
      for (const r of records) byId.set(r.id, slimEvent(r, { keepActors }));
      onWindow?.({ type, ...w, count: records.length });
    }
  }
  return [...byId.values()].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
}

// Lesson fields that are the lesson's content: what `push` overwrites (HTML),
// or content items the local tree records but push cannot write.
const CONTENT_FIELDS = new Set(['HTML', 'VIDEO', 'QUIZ', 'downloadable_content']);
const STRUCTURE_ACTIONS = new Set(['create', 'delete', 'reorder', 'clone', 'publish', 'unpublish']);

/**
 * Sorts an event into one of three kinds, in order of how much a push could
 * destroy:
 *
 *   content    a lesson's HTML, video, quiz or download changed
 *   structure  something was created, deleted, reordered or (un)published
 *   settings   titles, descriptions and flags
 */
export function classifyEvent(event) {
  if (LESSON_TARGET_TYPES.includes(event.targetType)) {
    if (event.action === 'upload' || CONTENT_FIELDS.has(event.field)) return 'content';
  }
  if (STRUCTURE_ACTIONS.has(event.action)) return 'structure';
  return 'settings';
}
