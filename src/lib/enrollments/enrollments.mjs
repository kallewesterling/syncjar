/**
 * enrollments.mjs — one CSV row per enrollment, from the v2 API
 * (`GET /v2/enrollments/`). The pure half, plus the one paginated read that
 * keeps `included`; the command `export:enrollments` does the rest of the I/O.
 *
 * An enrollment points at a **published course**, not a course: a course
 * published on two domains has two published-course ids, and
 * `filter[course.id]` takes the course id (a published-course id matches
 * nothing, silently). So the course of each row comes from the
 * published-course list, and its title from the course list. The domain
 * needs neither: each row carries `domain_name`.
 *
 * `include=student` puts each student once in `included`, however many of
 * the page's enrollments are theirs, so rows join to students by id. A row
 * whose student is missing from `included` is an error rather than a blank
 * email, because `--email-domain` filters on that email and a blank one
 * would drop the row without a trace.
 *
 * The API has no filter by email domain, so `--email-domain` is applied
 * here, to the included student's email. It matches the domain exactly,
 * case-insensitively, and not its subdomains: `example.com` does not match
 * `eu.example.com`. Name each subdomain wanted; a suffix match is how
 * `notexample.com` ends up in a partner's report.
 */
import { nextCursor, V2_PAGE_SIZE } from '#lib/skilljar/client-v2.mjs';

export const ENROLLMENT_FIELDS = [
  'enrollment_id', 'course_id', 'course_title', 'skilljar_domain',
  'student_id', 'student_email', 'student_first_name', 'student_last_name',
  'enrolled_at', 'completed_at', 'progress_status', 'success_status',
  'score', 'max_score', 'has_certificate', 'source', 'channel', 'active'
];

// Free text a learner typed: off unless asked for, as it may hold anything.
export const FEEDBACK_FIELDS = ['rating', 'rating_scale', 'feedback'];

/**
 * Every record of a cursor-paginated v2 list, with the `included` records of
 * every page. `listAllV2` keeps only `data`.
 */
export async function listAllWithIncluded(client, url, params = {}) {
  const data = [];
  const included = [];
  let cursor = null;
  do {
    const { data: page } = await client.get(url, {
      params: { ...params, 'page[size]': V2_PAGE_SIZE, ...(cursor ? { 'page[cursor]': cursor } : {}) }
    });
    data.push(...(page.data ?? []));
    included.push(...(page.included ?? []));
    cursor = nextCursor(page.links);
  } while (cursor);
  return { data, included };
}

/**
 * The courses each `--course` query picks: an exact id, or a case-insensitive
 * substring of the id or title, as `pull --course` matches. A query that
 * matches nothing is returned in `unmatched`, so the caller can refuse it
 * rather than export less than was asked for.
 */
export function matchCourses(queries, courses) {
  const matched = new Map();
  const unmatched = [];
  for (const raw of queries) {
    const q = String(raw).trim().toLowerCase();
    const hits = q ? courses.filter((c) => String(c.id).toLowerCase() === q
      || String(c.id).toLowerCase().includes(q)
      || String(c.attributes?.title ?? '').toLowerCase().includes(q)) : [];
    if (!hits.length) unmatched.push(raw);
    for (const c of hits) matched.set(c.id, c);
  }
  return { courses: [...matched.values()], unmatched };
}

/** `Example.COM`, `@example.com` → `example.com`; null when it is not a domain. */
export function normaliseEmailDomain(value) {
  const d = String(value ?? '').trim().toLowerCase().replace(/^@/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

/** The domain of an email address, lowercased, or '' when there is none. */
export function emailDomainOf(email) {
  const at = String(email ?? '').lastIndexOf('@');
  return at < 0 ? '' : String(email).slice(at + 1).trim().toLowerCase();
}

/**
 * A `--since` value as the timestamp the API wants. It rejects a timestamp
 * with no offset (a 422), so a bare date is read as UTC midnight and a bare
 * date-time as UTC. Throws on anything that is not a date.
 */
export function parseSince(value) {
  const s = String(value ?? '').trim();
  const withZone = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z`
    : /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s) ? `${s}Z`
      : s;
  const d = new Date(withZone);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s) || Number.isNaN(d.getTime())) {
    throw new Error(`--since "${value}" is not a date. Use YYYY-MM-DD or an ISO 8601 timestamp.`);
  }
  return d.toISOString();
}

/**
 * The list reads one export makes: one per course asked for (or one sweep of
 * the whole organisation) times one per email asked for, since
 * `filter[course.id]` and `filter[student.email]` each take a single value.
 * Domains, completion and date are filters on every read.
 */
export function enrollmentQueries({ courseIds = [], emails = [], domains = [], completedOnly = false, since = null }) {
  const shared = { include: 'student' };
  if (domains.length) shared['filter[domains]'] = domains.join(',');
  if (completedOnly) shared['filter[progress_status]'] = 'completed';
  if (since) shared['filter[enrolled_gte]'] = since;
  const courseList = courseIds.length ? courseIds : [null];
  const emailList = emails.length ? [...new Set(emails.map((e) => String(e).trim().toLowerCase()))] : [null];
  return courseList.flatMap((courseId) => emailList.map((email) => ({
    ...shared,
    ...(courseId ? { 'filter[course.id]': courseId } : {}),
    ...(email ? { 'filter[student.email]': email } : {})
  })));
}

/**
 * Published-course id → `{ id, title }` of its course, from the
 * published-course and course lists.
 */
export function courseByPublishedCourse(publishedCourses, courses) {
  const titles = new Map(courses.map((c) => [c.id, c.attributes?.title ?? '']));
  const map = new Map();
  for (const pc of publishedCourses) {
    const id = pc.relationships?.course?.data?.id;
    if (id) map.set(pc.id, { id, title: titles.get(id) ?? '' });
  }
  return map;
}

/**
 * CSV rows from enrollment records and the students `included` with them.
 * Rows are deduplicated by enrollment id, since two reads can overlap.
 * `unknownPublishedCourses` lists published-course ids that are not in the
 * published-course list; their rows are kept with a blank course.
 */
export function enrollmentRows(records, included, coursesByPc, { includeFeedback = false } = {}) {
  const students = new Map(included.filter((r) => r.type === 'students').map((s) => [s.id, s.attributes ?? {}]));
  const seen = new Set();
  const unknown = new Set();
  const rows = [];
  for (const e of records) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const a = e.attributes ?? {};
    const studentId = e.relationships?.student?.data?.id;
    const student = students.get(studentId);
    if (!student) throw new Error(`Enrollment ${e.id} came back without its student (include=student). Nothing was written.`);
    const pcId = e.relationships?.['published-course']?.data?.id;
    const course = coursesByPc.get(pcId);
    if (!course) unknown.add(pcId);
    const row = {
      enrollment_id: e.id,
      course_id: course?.id ?? '',
      course_title: course?.title ?? '',
      skilljar_domain: a.domain_name ?? '',
      student_id: studentId,
      student_email: student.email ?? '',
      student_first_name: student.first_name ?? '',
      student_last_name: student.last_name ?? '',
      enrolled_at: a.enrolled_at ?? '',
      completed_at: a.completed_at ?? '',
      progress_status: a.progress_status ?? '',
      success_status: a.success_status ?? '',
      score: a.score ?? '',
      max_score: a.max_score ?? '',
      has_certificate: a.has_certificate ?? '',
      source: a.source ?? '',
      channel: a.channel ?? '',
      active: a.active ?? ''
    };
    if (includeFeedback) {
      row.rating = a.rating ?? '';
      row.rating_scale = a.rating_scale ?? '';
      row.feedback = a.feedback ?? '';
    }
    rows.push(row);
  }
  return { rows, unknownPublishedCourses: [...unknown] };
}

/** Rows whose student email is at one of `domains` (already normalised). */
export function filterByEmailDomain(rows, domains) {
  if (!domains.length) return rows;
  const wanted = new Set(domains);
  return rows.filter((r) => wanted.has(emailDomainOf(r.student_email)));
}

/** Rows by course title, then enrolment time, then email. */
export function sortRows(rows) {
  return [...rows].sort((x, y) => x.course_title.localeCompare(y.course_title)
    || String(x.enrolled_at).localeCompare(String(y.enrolled_at))
    || x.student_email.localeCompare(y.student_email));
}

/** Per course id: `{ title, enrollments, completions, certificates }`. */
export function summarise(rows) {
  const byCourse = new Map();
  for (const r of rows) {
    const c = byCourse.get(r.course_id) ?? { title: r.course_title, enrollments: 0, completions: 0, certificates: 0 };
    c.enrollments += 1;
    if (r.progress_status === 'completed') c.completions += 1;
    if (r.has_certificate === true) c.certificates += 1;
    byCourse.set(r.course_id, c);
  }
  return byCourse;
}

/**
 * Whether the analytics summary counts the same set of enrollments as the
 * export. It is filtered by domain and nothing else, so an export narrowed
 * by student or by date cannot be compared with it.
 */
export function canCrossCheck({ emails = [], emailDomains = [], since = null }) {
  return !emails.length && !emailDomains.length && !since;
}

/**
 * Courses whose exported counts differ from `GET /v2/analytics/courses/{id}`.
 * `analytics` maps course id → its attributes. With `completedOnly` the
 * export holds completions alone, so enrolments are not compared.
 */
export function crossCheck(summary, analytics, { completedOnly = false } = {}) {
  const mismatches = [];
  for (const [courseId, a] of analytics) {
    const s = summary.get(courseId) ?? { enrollments: 0, completions: 0, certificates: 0 };
    const expected = {
      ...(completedOnly ? {} : { enrollments: a?.enrollments ?? 0 }),
      completions: a?.completions ?? 0,
      ...(completedOnly ? {} : { certificates: a?.certificates_issued ?? 0 })
    };
    const diffs = Object.entries(expected).filter(([k, v]) => s[k] !== v).map(([k, v]) => ({ field: k, exported: s[k], analytics: v }));
    if (diffs.length) mismatches.push({ course_id: courseId, diffs });
  }
  return mismatches;
}
