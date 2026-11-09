/**
 * course-analytics.mjs — Skilljar's per-course summary from the v2 API
 * (`GET /v2/analytics/courses/{id}`), as CSV rows. The pure half; the
 * command `export:analytics` does the I/O.
 *
 * The summary is aggregate only: enrollments, completions, completion rate,
 * certificates and ratings. There is nothing per student, per lesson or per
 * quiz in it.
 *
 * `filter[domains]` takes domain **names** (`courses.example.com`), comma
 * separated, not the domain ids `GET /v2/domains/` returns. An id, or a
 * name that is not a domain, is not an error: it returns zeros. So every
 * name is checked against the domain list before it is used.
 */

export const ALL_DOMAINS = '(all)';

export const ANALYTICS_FIELDS = [
  'course_id', 'title', 'domain', 'is_published', 'lesson_count',
  'enrollments', 'completions', 'completion_rate', 'certificates_issued',
  'average_rating', 'rating_count', 'rating_scale', 'course_modified_at'
];

const round = (n, places = 4) => (n == null ? '' : Math.round(n * 10 ** places) / 10 ** places);

/**
 * Sorts the domain names asked for into ones Skilljar has and ones it
 * does not. Matching is case-insensitive, and the returned names use
 * Skilljar's spelling.
 */
export function checkDomains(requested, known) {
  const byLower = new Map(known.map((name) => [name.toLowerCase(), name]));
  const valid = [];
  const unknown = [];
  for (const name of requested) {
    const match = byLower.get(String(name).trim().toLowerCase());
    if (match) { if (!valid.includes(match)) valid.push(match); }
    else unknown.push(name);
  }
  return { valid, unknown };
}

/** One CSV row from a v2 course and its analytics attributes. */
export function analyticsRow(course, domain, attributes) {
  const a = attributes ?? {};
  return {
    course_id: course.id,
    title: course.attributes?.title ?? '',
    domain,
    is_published: course.attributes?.is_published ?? '',
    lesson_count: course.attributes?.lesson_count ?? '',
    enrollments: a.enrollments ?? 0,
    completions: a.completions ?? 0,
    completion_rate: round(a.completion_rate),
    certificates_issued: a.certificates_issued ?? 0,
    average_rating: round(a.average_rating, 2),
    rating_count: a.rating_count ?? 0,
    rating_scale: a.rating_scale ?? '',
    course_modified_at: course.attributes?.modified_at ?? ''
  };
}

/** Rows sorted by title, the all-domains row first within each course. */
export function sortRows(rows) {
  return [...rows].sort((x, y) => x.title.localeCompare(y.title)
    || (x.domain === ALL_DOMAINS ? -1 : y.domain === ALL_DOMAINS ? 1 : x.domain.localeCompare(y.domain)));
}

/**
 * Totals per domain, and for each course whose per-domain enrollments do
 * not add up to its all-domains figure, the difference. A student enrolled
 * through two domains may be counted in both, so a mismatch is a thing to
 * report rather than an error.
 */
export function summarise(rows, domains) {
  const totals = new Map();
  for (const r of rows) {
    const t = totals.get(r.domain) ?? { enrollments: 0, completions: 0, certificates_issued: 0 };
    t.enrollments += r.enrollments;
    t.completions += r.completions;
    t.certificates_issued += r.certificates_issued;
    totals.set(r.domain, t);
  }
  const mismatches = [];
  if (domains.length) {
    const byCourse = new Map();
    for (const r of rows) {
      const c = byCourse.get(r.course_id) ?? { title: r.title, all: null, sum: 0 };
      if (r.domain === ALL_DOMAINS) c.all = r.enrollments;
      else c.sum += r.enrollments;
      byCourse.set(r.course_id, c);
    }
    for (const [id, c] of byCourse) if (c.all != null && c.all !== c.sum) mismatches.push({ course_id: id, title: c.title, all: c.all, sum: c.sum });
  }
  return { totals, mismatches };
}
