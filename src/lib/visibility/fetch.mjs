/**
 * fetch.mjs — the v2 reads `check:visibility` needs, all GETs. Exports
 * functions only; nothing runs on import.
 *
 * Scopes: `domains:read`, `student-groups:read`, `published-courses:read`
 * and `paths:read`. The published-course list is read with
 * `include=course,domain`; the published-path list accepts only
 * `include=path` (`domain` is a 400), and its domain comes from the
 * relationship linkage, which is there without the include.
 *
 * Costs one list read each for domains, groups, published courses and
 * published paths, one override list per group, and three reads per
 * published path (items, group visibility, category visibility).
 */
import { mapWithConcurrency } from '#lib/concurrency.mjs';
import { listAllV2, nextCursor, V2_PAGE_SIZE } from '#lib/skilljar/client-v2.mjs';

/**
 * Like `listAllV2`, but keeps the `included` resources of every page.
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
 * Everything `buildCatalog` takes. A rejection carries what was being read
 * on `err.visibilityStage`, for the command's failure message.
 */
export async function fetchVisibilityInputs(client, { concurrency = 6 } = {}) {
  let stage = '';
  try {
    stage = 'Could not list domains (needs domains:read)';
    const domains = await listAllV2(client, '/domains/');

    stage = 'Could not list groups (needs student-groups:read)';
    const groups = await listAllV2(client, '/groups/');

    stage = 'Could not list published courses (needs published-courses:read)';
    const courses = await listAllWithIncluded(client, '/published-courses/', { include: 'course,domain' });

    stage = 'Could not list published paths (needs paths:read)';
    const paths = await listAllWithIncluded(client, '/published-paths/', { include: 'path' });

    stage = 'Could not read a group\'s course visibility overrides (needs student-groups:read)';
    const overrideLists = await mapWithConcurrency(groups, concurrency, (g) =>
      listAllV2(client, `/groups/${encodeURIComponent(g.id)}/relationships/published-course-visibility/`));
    const overridesByGroup = Object.fromEntries(groups.map((g, i) => [g.id, overrideLists[i]]));

    stage = 'Could not read a published path\'s items or visibility (needs paths:read)';
    const details = await mapWithConcurrency(paths.data, concurrency, async (pp) => {
      const base = `/published-paths/${encodeURIComponent(pp.id)}`;
      const items = await listAllV2(client, `${base}/path-items/`);
      const groupRefs = await listAllV2(client, `${base}/relationships/group-visibility/`);
      const categories = await listAllV2(client, `${base}/relationships/category-visibility/`);
      return { items, groups: groupRefs, categories };
    });
    const pathDetails = Object.fromEntries(paths.data.map((pp, i) => [pp.id, details[i]]));

    return {
      domains,
      groups,
      publishedCourses: courses.data,
      publishedPaths: paths.data,
      included: [...courses.included, ...paths.included],
      overridesByGroup,
      pathDetails
    };
  } catch (err) {
    err.visibilityStage = stage;
    throw err;
  }
}
