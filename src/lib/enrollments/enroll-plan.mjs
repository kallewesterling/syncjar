/**
 * enroll-plan.mjs — enrolling existing students in a course by email, and
 * deactivating those enrollments, through the v2 API. The pure half: which
 * course and published course, what each student's enrollment is now, what
 * a run would send, and how to read the responses and the read-back.
 * `enroll-run.mjs` does the I/O.
 *
 *   POST  /enrollments/   enroll up to 100 emails in one published course
 *   PATCH /enrollments/   update up to 100 enrollments by id; `active: false`
 *                         deactivates one
 *
 * Both report per row, with 200 when every row succeeded and 207 when some
 * failed. Enrollments belong to a published course, which is a course on
 * one domain, so a course published on two domains has two enrollments per
 * student and the run has to know which domain it means.
 *
 * The POST (new and re-enroll) and both PATCHes were tested live on
 * 2026-11-06 and 2026-11-09, the restoring PATCH by hand; a restore as this
 * module sends it has not yet been run (see the README).
 * `PATCH /enrollments/completion` is never used: it marks learners as having
 * completed a course they did not complete.
 */

export const ACTIONS = {
  add: { verb: 'enroll', past: 'enrolled', method: 'post' },
  remove: { verb: 'unenroll', past: 'deactivated', method: 'patch' }
};

// BATCH_MAX_ITEMS in the spec's descriptions of both endpoints.
export const ENROLL_BATCH_SIZE = 100;

// The write path has not been run against Skilljar. Until it has, a
// confirmed run needs this set to 1 as well as --confirm.
export const ENROLL_WRITES_ENV = 'SYNCJAR_ENROLL_WRITES';

export function writesUnlocked(env) {
  return env?.[ENROLL_WRITES_ENV] === '1';
}

/**
 * Parses --expires-at. Skilljar wants an ISO 8601 date-time in the future
 * and answers a past one with a 400 for the whole request. A bare date is
 * midnight UTC at the start of that day.
 *
 * @returns {{ iso: string } | { error: string }}
 */
export function parseExpiresAt(value, now) {
  const at = Date.parse(String(value ?? '').trim());
  if (!Number.isFinite(at)) return { error: `--expires-at "${value}" is not a date. Use ISO 8601, e.g. 2027-01-31 or 2027-01-31T17:00:00Z.` };
  if (at <= now) return { error: `--expires-at ${new Date(at).toISOString()} is not in the future.` };
  return { iso: new Date(at).toISOString() };
}

/**
 * Finds a course by v2 id, or by exact (case-insensitive) title, in the
 * list `GET /courses/` returned.
 *
 * @returns {{ course: object } | { error: string }}
 */
export function resolveCourse(courses, query) {
  const q = String(query ?? '').trim();
  const byId = courses.find((c) => c.id === q);
  if (byId) return { course: byId };
  const exact = courses.filter((c) => c.attributes?.title?.trim().toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return { course: exact[0] };
  if (exact.length > 1) {
    return { error: `${exact.length} courses are titled "${q}". Pass --course with one of their ids: ${exact.map((c) => c.id).join(', ')}` };
  }
  const near = courses
    .filter((c) => c.attributes?.title?.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 10)
    .map((c) => `"${c.attributes.title}" (${c.id})`);
  return { error: `No course has the id or title "${q}".${near.length ? ` Titles containing it: ${near.join(', ')}` : ''}` };
}

/**
 * Picks the published course to act on from the course's published-course
 * records. `domains` maps a domain id to its name. With `domainName`, it is
 * the record on that domain; without, the course must be published on
 * exactly one domain.
 *
 * @returns {{ publishedCourse: object, domain: { id: string, name: string } } | { error: string }}
 */
export function choosePublishedCourse(publishedCourses, domains, domainName) {
  const named = publishedCourses.map((pc) => {
    const id = pc.relationships?.domain?.data?.id;
    return { pc, domain: { id, name: domains.get(id) ?? id } };
  });
  const list = named.map((n) => n.domain.name).join(', ');
  if (!named.length) return { error: 'The course is not published on any domain, so nobody can be enrolled in it.' };
  if (domainName) {
    const matches = named.filter((n) => n.domain.name?.toLowerCase() === domainName.toLowerCase());
    if (matches.length === 1) return { publishedCourse: matches[0].pc, domain: matches[0].domain };
    if (matches.length > 1) return { error: `The course has ${matches.length} published-course records on ${domainName}; refusing to guess.` };
    return { error: `The course is not published on ${domainName}. It is published on: ${list}` };
  }
  if (named.length === 1) return { publishedCourse: named[0].pc, domain: named[0].domain };
  return { error: `The course is published on ${named.length} domains (${list}). Pass --domain with one of them.` };
}

/**
 * A student's enrollment in one published course, from the rows
 * `GET /enrollments/?filter[student.email]=…&filter[course.id]=…` returned.
 * Rows for other published courses (the same course on another domain) and,
 * defensively, for other students are dropped first.
 *
 * `state` is `not_enrolled`, `active`, `expired` (inactive and past its
 * `expires_at`) or `deactivated` (inactive otherwise). `activeIds` lists
 * the active rows' ids; more than one is a shape this run does not handle.
 */
export function enrollmentState(rows, { studentId, publishedCourseId, now }) {
  const mine = rows.filter((r) => r.relationships?.['published-course']?.data?.id === publishedCourseId
    && (!studentId || r.relationships?.student?.data?.id === studentId));
  if (!mine.length) return { state: 'not_enrolled', rows: [], activeIds: [] };

  const latest = [...mine].sort((a, b) => String(b.attributes?.enrolled_at).localeCompare(String(a.attributes?.enrolled_at)))[0];
  const active = mine.filter((r) => r.attributes?.active === true);
  const base = {
    rows: mine,
    activeIds: active.map((r) => r.id),
    enrollmentId: (active[0] ?? latest).id,
    expiresAt: (active[0] ?? latest).attributes?.expires_at ?? '',
    progress: (active[0] ?? latest).attributes?.progress_status ?? ''
  };
  if (active.length) return { ...base, state: 'active' };
  const expiry = Date.parse(latest.attributes?.expires_at ?? '');
  return { ...base, state: Number.isFinite(expiry) && expiry <= now ? 'expired' : 'deactivated' };
}

/** Whether a student holds an active membership of the domain. */
export function domainMembership(memberships, domainId) {
  const mine = memberships.filter((m) => m.relationships?.domain?.data?.id === domainId);
  if (!mine.length) return 'not_member';
  return mine.some((m) => m.attributes?.active === true) ? 'member' : 'inactive_member';
}

/**
 * Decides, per student found by email, whether the run sends them and why
 * not otherwise. Each `students` entry is `{ email, id, name, inactive,
 * enrollment, domain }`, where `enrollment` is from `enrollmentState` and
 * `domain` from `domainMembership` (add only).
 *
 * Add sends students with no enrollment (a POST). A student whose
 * enrollment is deactivated is skipped unless `deactivated` says what to
 * do: `reenroll` POSTs them, which in Skilljar creates a new enrollment with
 * its own, empty progress and keeps the old one as history (every published
 * course has `unique_progress_per_enrollment`); `restore` PATCHes the old
 * enrollment back to active with its progress, which needs it to be their
 * only one. Expired enrollments are skipped, as are deactivated accounts and
 * students who are not members of the domain, since what Skilljar does with
 * each has not been established. Remove sends students with exactly one
 * active enrollment.
 *
 * @param {{ deactivated?: 'reenroll' | 'restore' | null }} [options]
 * @returns {{ send: object[], skipped: object[] }}  skipped rows carry `result`
 */
export function planEnrollments(action, students, { deactivated = null } = {}) {
  const send = [];
  const skipped = [];
  const skipAs = (s, result) => skipped.push({ ...s, result });
  for (const s of students) {
    const { state, activeIds, rows } = s.enrollment;
    if (action === 'add') {
      if (s.inactive) skipAs(s, 'skipped_inactive_account');
      else if (state === 'active') skipAs(s, 'skipped_already_enrolled');
      else if (state === 'expired') skipAs(s, 'skipped_expired');
      else if (state === 'deactivated' && !deactivated) skipAs(s, 'skipped_deactivated');
      else if (state === 'deactivated' && deactivated === 'restore' && (rows?.length ?? 1) > 1) skipAs(s, 'skipped_several_enrollments');
      else if (s.domain !== 'member') skipAs(s, `skipped_domain_${s.domain}`);
      else send.push({ ...s, intent: state === 'not_enrolled' ? 'enroll' : deactivated });
    } else if (state === 'active' && activeIds.length === 1) send.push({ ...s, intent: 'deactivate' });
    else if (state === 'active') skipAs(s, 'skipped_several_active_enrollments');
    else skipAs(s, state === 'not_enrolled' ? 'skipped_not_enrolled' : 'skipped_already_inactive');
  }
  return { send, skipped };
}

/** The body of `POST /enrollments/`. */
export function enrollBody(publishedCourseId, emails, expiresAt) {
  return {
    published_course_id: publishedCourseId,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    data: emails.map((email) => ({ type: 'enrollments', attributes: { email } }))
  };
}

/** The body of `PATCH /enrollments/` that deactivates each enrollment. */
export function deactivateBody(enrollmentIds) {
  return { data: enrollmentIds.map((id) => ({ type: 'enrollments', id, attributes: { active: false } })) };
}

/**
 * The body of `PATCH /enrollments/` that restores each enrollment in place,
 * keeping its id, `enrolled_at` and progress.
 */
export function restoreBody(enrollmentIds) {
  return { data: enrollmentIds.map((id) => ({ type: 'enrollments', id, attributes: { active: true } })) };
}

/** The pointer index in a failed item's `source`, e.g. `/data/3/attributes/email` → 3. */
function pointerIndex(item) {
  const match = item?.error?.source?.pointer?.match(/^\/data\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Matches each sent student to their item in a batch response. The spec
 * says items come back in request order, so position is used when the
 * counts agree; otherwise a failed item's pointer, a succeeded add's
 * student id, or a PATCH item's enrollment id. `action` is `add` for a
 * POST, and `remove` or `restore` for a PATCH.
 */
function matchItems(action, sent, body) {
  const items = Array.isArray(body?.data) ? body.data : [];
  const sameLength = items.length === sent.length;
  const found = new Map();
  items.forEach((item, i) => {
    const at = pointerIndex(item);
    if (at != null && sent[at] && !found.has(sent[at].email)) found.set(sent[at].email, item);
    const key = action === 'add'
      ? item?.result?.relationships?.student?.data?.id
      : item?.id ?? item?.result?.id;
    const byKey = key == null ? null : sent.find((s) => (action === 'add' ? s.id : s.enrollment.enrollmentId) === key);
    if (byKey && !found.has(byKey.email)) found.set(byKey.email, item);
    if (sameLength && !found.has(sent[i].email)) found.set(sent[i].email, item);
  });
  return found;
}

/**
 * Turns one batch response into a row per student sent. A student with no
 * matching item is a failure: a 200 alone is not evidence that a write
 * happened. Succeeded rows are only provisional until the read-back.
 */
export function readBatchResult(action, sent, body) {
  const items = matchItems(action, sent, body);
  return sent.map((s) => {
    const item = items.get(s.email);
    const row = { email: s.email, enrollment_id: '', response: '', error: '' };
    if (!item) return { ...row, response: 'missing', error: 'no result for this student in the response' };
    if (item.status === 'failed') {
      const code = item.error?.code ?? 'unknown';
      return { ...row, response: code === 'already_enrolled' ? 'already_enrolled' : 'failed', error: [code, item.error?.detail].filter(Boolean).join(': ') };
    }
    if (item.status === 'succeeded') {
      return { ...row, response: 'succeeded', enrollment_id: item.result?.id ?? item.id ?? '' };
    }
    return { ...row, response: 'failed', error: `unexpected item status: ${item.status}` };
  });
}

/**
 * Whether what was read back is what the run meant to leave behind. A new
 * enrollment must be active, with the requested expiry if one was given. A
 * restore must leave the enrollment it targeted as the only active one. A
 * re-enroll must leave one active enrollment that is not the old one, with
 * the old one still inactive. A remove wants the enrollment it targeted to
 * be inactive.
 *
 * @returns {string|null}  why it is not, or null when it is
 */
export function readBackMismatch(action, student, after, { expiresAt } = {}) {
  const oldId = student.enrollment.enrollmentId;
  const old = after.rows.find((r) => r.id === oldId);
  if (action === 'add' && student.intent === 'restore') {
    if (!old) return 'the enrollment was not found on read-back';
    if (old.attributes?.active !== true) return 'read back as still inactive';
    const others = after.activeIds.filter((a) => a !== oldId);
    if (others.length) return `another active enrollment appeared: ${others.join(', ')}`;
    return null;
  }
  if (action === 'add' && student.intent === 'reenroll') {
    if (after.activeIds.length !== 1) return `read back with ${after.activeIds.length} active enrollments, expected 1`;
    if (after.activeIds[0] === oldId) return 'the old enrollment was reactivated, not a new one created';
    if (old && old.attributes?.active !== false) return 'the old enrollment is no longer inactive';
  }
  if (action === 'add') {
    if (after.state !== 'active') return `read back as ${after.state}, expected active`;
    if (after.activeIds.length > 1) return `read back with ${after.activeIds.length} active enrollments`;
    if (expiresAt && Date.parse(after.expiresAt) !== Date.parse(expiresAt)) {
      return `read back with expires_at ${after.expiresAt || 'none'}, expected ${expiresAt}`;
    }
    return null;
  }
  const target = after.rows.find((r) => r.id === student.enrollment.enrollmentId);
  if (!target) return 'the enrollment was not found on read-back';
  if (target.attributes?.active !== false) return 'read back as still active';
  return null;
}

/**
 * The audit row's final `result`, from the planned intent, the batch
 * response and the read-back. Only a verified read-back counts as done.
 */
export function finalResult(action, intent, response, mismatch, readBackError) {
  if (readBackError) return 'unverified';
  if (mismatch) return 'failed';
  if (response === 'already_enrolled') return 'already_enrolled';
  if (response !== 'succeeded') return 'failed_but_landed';
  if (action === 'add') return { reenroll: 're-enrolled', restore: 'restored' }[intent] ?? 'enrolled';
  return 'deactivated';
}

export const SUCCESS_RESULTS = new Set(['enrolled', 're-enrolled', 'restored', 'deactivated', 'already_enrolled']);

export const AUDIT_FIELDS = [
  'email', 'student_id', 'name', 'course_id', 'course_title', 'published_course_id', 'domain', 'action',
  'enrollment_id', 'before', 'progress_before', 'expires_at_before', 'after', 'expires_at_after',
  'response', 'result', 'error'
];
