/**
 * settings.mjs — find the courses and paths whose settings differ from the
 * rest, for `check:settings`.
 *
 * Several settings are the same on every course in a catalog, and nobody
 * edits them on purpose: a course that differs is usually a mistake made in
 * the dashboard. Rather than hardcode what the right values are, which
 * differ between organisations, the norm is read from the catalog itself:
 * when one value covers at least `threshold` of the records, every record
 * with another value is an outlier. A setting that is genuinely split, such
 * as `hidden`, is reported as varying, not flagged.
 */

/** Outlier threshold: the share of records the majority value must cover. */
export const DEFAULT_THRESHOLD = 0.9;

/**
 * Summarises one field across records.
 *
 *   records    the objects to compare
 *   field      { name, get(record) } — `get` returns the comparable value
 *   labelOf    (record) => how to name a record in the report
 *
 * Returns `{ field, status, counts, majority, outliers }`, where status is
 * 'uniform' (one value), 'outliers' (a majority at or over the threshold and
 * some records off it), or 'varies'. `counts` is `[[value, n]]`, commonest
 * first, and `outliers` is `[{ label, value }]`.
 */
export function summariseField(records, { name, get }, labelOf, threshold = DEFAULT_THRESHOLD) {
  const byValue = new Map();
  for (const record of records) {
    const key = JSON.stringify(get(record) ?? null);
    if (!byValue.has(key)) byValue.set(key, []);
    byValue.get(key).push(record);
  }
  const counts = [...byValue.entries()]
    .map(([value, list]) => [JSON.parse(value), list.length])
    .sort((a, b) => b[1] - a[1]);

  if (counts.length <= 1) {
    return { field: name, status: 'uniform', counts, majority: counts[0]?.[0] ?? null, outliers: [] };
  }

  const [majority, top] = counts[0];
  // A tie has no majority to be an outlier from.
  if (top / records.length < threshold || counts[1][1] === top) {
    return { field: name, status: 'varies', counts, majority: null, outliers: [] };
  }

  const majorityKey = JSON.stringify(majority);
  const outliers = [];
  for (const [key, list] of byValue) {
    if (key === majorityKey) continue;
    for (const record of list) outliers.push({ label: labelOf(record), value: JSON.parse(key) });
  }
  return { field: name, status: 'outliers', counts, majority, outliers };
}

const flag = (name) => ({ name, get: (r) => r[name] ?? null });
const isSet = (name) => ({ name: `${name} (set)`, get: (r) => Boolean(r[name]) });

/** Course-object settings, from `GET /courses`. */
export const COURSE_FIELDS = [
  flag('enforce_sequential_navigation'),
  flag('display_course_and_lesson_time'),
  flag('display_manual_course_time'),
  flag('course_and_lesson_time_format')
];

/** Per-domain settings, from `GET /domains/{d}/published-courses`. */
export const PUBLISHED_COURSE_FIELDS = [
  flag('hidden'),
  flag('strict_enforce_group_visibility'),
  flag('registration_required'),
  flag('restrict_access_start_end_dates'),
  flag('allow_self_service_reenroll'),
  flag('unique_progress_per_enrollment'),
  flag('require_all_prerequisites'),
  flag('timezone'),
  isSet('registration_starts_at'),
  isSet('registration_ends_at'),
  { name: 'offer.registration_open', get: (r) => r.offer?.registration_open ?? null },
  { name: 'offer.price', get: (r) => (r.offer?.price ? `${r.offer.price.amount} ${r.offer.price.currency_code}` : null) }
];

/** Path settings, from `GET /paths`. */
export const PATH_FIELDS = [
  flag('course_name_singular'),
  flag('course_name_plural')
];

/** Per-domain settings, from `GET /domains/{d}/published-paths`. */
export const PUBLISHED_PATH_FIELDS = [
  flag('hidden'),
  flag('strict_enforce_group_visibility'),
  flag('unique_progress_per_enrollment'),
  { name: 'offer.registration_open', get: (r) => r.offer?.registration_open ?? null }
];

/** Summarises every field; returns one summary per field, in field order. */
export function summarise(records, fields, labelOf, threshold = DEFAULT_THRESHOLD) {
  return fields.map(field => summariseField(records, field, labelOf, threshold));
}
