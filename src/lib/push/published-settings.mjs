/**
 * published-settings.mjs — the per-domain visibility `push:published-settings`
 * writes from published.json, for courses and paths.
 *
 * A course or path is published separately on each domain, and each publish
 * record carries its own visibility. `pull:slugs` (courses) and `pull:paths`
 * record them in each directory's published.json:
 *
 *   { "domains": { "<domain>": { "slug": …, "published_course_id": …,
 *                                "hidden": …, "strict_enforce_group_visibility": … } } }
 *
 * Both fields round-tripped on throwaway staging records on 2026-10-28, for a
 * published course and a published path, changing nothing else. The slug is
 * in the same file and is never written: changing it breaks every link to the
 * course.
 *
 * One effect reaches past the record written: **a path with no visible course
 * on a domain has its registration closed there** (`offer.registration_open`
 * false). Hiding a path's one course closed it on staging, and unhiding it
 * reopened it; on production, paths with some hidden courses stay open, and
 * the one path with no courses is closed. So hiding a path's last visible
 * course closes the path, which registrationWarnings() reports before the
 * write.
 */
import { boolean } from '#lib/push/settings.mjs';

export const PUBLISHED_SETTINGS = {
  hidden: boolean,
  strict_enforce_group_visibility: boolean
};

const KINDS = {
  course: { idKey: 'published_course_id', collection: 'published-courses' },
  path: { idKey: 'published_path_id', collection: 'published-paths' }
};

/** The key a target and its upstream record share. */
export const publishedKey = (domain, publishedId) => `${domain}/${publishedId}`;

/**
 * Builds planSettings() targets from local published.json files.
 *
 *   kind      'course' or 'path'
 *   locals    [{ dir, published }] — published is the parsed published.json
 *   upstream  Map publishedKey -> published record from the domain's list
 *   domains   when set, only these domains are considered
 */
export function publishedTargets({ kind, locals, upstream, domains = null }) {
  const { idKey, collection } = KINDS[kind];
  const targets = [];
  for (const { dir, published } of locals) {
    for (const [domain, entry] of Object.entries(published?.domains ?? {})) {
      if (domains && !domains.includes(domain)) continue;
      const key = publishedKey(domain, entry[idKey]);
      targets.push({
        id: key,
        label: `${dir} on ${domain}`,
        where: `${dir}/published.json (${domain})`,
        endpoint: `/domains/${domain}/${collection}/${entry[idKey]}`,
        local: entry,
        upstream: upstream.get(key)
      });
    }
  }
  return targets;
}

/**
 * Skilljar derives `offer.registration_open`; it is not written, and it moves
 * when a path's courses are hidden. Dropped from records before verifying,
 * so that effect is reported by registrationWarnings() instead of failing
 * the read-back.
 */
export function withoutDerived(record) {
  if (!record?.offer) return record;
  const { registration_open, ...offer } = record.offer;
  return { ...record, offer };
}

/**
 * Lists the paths a plan would leave with no visible course on a domain,
 * which closes registration on them.
 *
 *   changes      planSettings() changes against publishedTargets()
 *   courseLocals [{ dir, published }] — course published.json files
 *   pathLocals   [{ dir, published, courseIds }] — path published.json
 *                files, with the course ids from path-items.json
 *   upstream     Map publishedKey -> published record, before the writes
 */
export function registrationWarnings({ changes, courseLocals, pathLocals, upstream }) {
  const planned = new Map(changes.filter(c => c.field === 'hidden').map(c => [c.id, c.to]));
  const keyOf = new Map();
  for (const { published } of courseLocals) {
    for (const [domain, entry] of Object.entries(published?.domains ?? {})) {
      keyOf.set(`${domain} ${published.course_id}`, publishedKey(domain, entry.published_course_id));
    }
  }

  const visible = (domain, courseId, after) => {
    const key = keyOf.get(`${domain} ${courseId}`);
    if (!key || !upstream.has(key)) return false;
    const hidden = after && planned.has(key) ? planned.get(key) : upstream.get(key).hidden;
    return !hidden;
  };

  const warnings = [];
  for (const { dir, published, courseIds = [] } of pathLocals) {
    for (const domain of Object.keys(published?.domains ?? {})) {
      const before = courseIds.filter(id => visible(domain, id, false)).length;
      const after = courseIds.filter(id => visible(domain, id, true)).length;
      if (before > 0 && after === 0) {
        warnings.push(`${dir} on ${domain}: this run hides its last visible course, and Skilljar closes registration on a path with none`);
      }
    }
  }
  return warnings;
}
