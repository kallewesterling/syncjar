/**
 * visibility.mjs — who can see which published course and path, per domain,
 * from the v2 API's records. The pure half; `check:visibility` does the I/O
 * (see `fetch.mjs`).
 *
 * The model, from the v2 spec's own descriptions:
 *
 * - `is_hidden` on a published course: "Hidden from the catalog; visible
 *   only to associated groups."
 * - A group's visibility override is an allowlist row (`is_visible: true`,
 *   "show despite default-hidden") or a blocklist row (`false`, "hide
 *   despite default-visible"). So on a hidden course only the allowlist
 *   matters, and on a visible one only the blocklist.
 * - A published path's group visibility is one list whose meaning flips:
 *   "allowed on a hidden path, blocked on a visible one".
 * - `strict_enforce_group_visibility`: "Block access for students the course
 *   is not visible to." So it decides whether a direct link still works for
 *   someone the record is not listed for. Without it, hiding only takes the
 *   record out of the catalog.
 *
 * Each record is then judged for one audience at a time: `EVERYONE` (anyone
 * in none of the record's groups, anonymous visitors included) and each
 * group. "Listed" means it shows in that audience's catalog; "can open"
 * means a direct link works.
 *
 * Not modelled, and reported as uncertain instead: `visibility_override_type`
 * CATEGORY (the spec names the mode but not its rules), a path's category
 * visibility, and a group that holds both an allow and a block row for one
 * course. A student in several groups presumably sees the union; the report
 * judges groups one at a time and does not claim that.
 */

export const EVERYONE = '(everyone)';

export const CSV_FIELDS = [
  'kind', 'title', 'slug', 'domain', 'audience', 'effective', 'listed_in_catalog', 'can_open',
  'restricted', 'is_hidden', 'strict_enforce_group_visibility', 'uncertain', 'published_id', 'object_id'
];

const byId = (records) => new Map(records.map((r) => [r.id, r]));
const titleOf = (included, type, id) => included.get(`${type}:${id}`)?.attributes?.title ?? '';

/**
 * One normalised catalog from the raw v2 reads:
 *
 * - `domains`, `groups`: `GET /domains/`, `GET /groups/`.
 * - `publishedCourses`, `publishedPaths`: the list reads, with `included`
 *   holding the `course` and `path` resources they were asked to include.
 * - `overridesByGroup`: group id → its `published-course-visibility` rows.
 * - `pathDetails`: published-path id → `{ items, groups, categories }`, its
 *   path items, group visibility and category visibility.
 */
export function buildCatalog({ domains, groups, publishedCourses, publishedPaths, included = [], overridesByGroup = {}, pathDetails = {} }) {
  const inc = new Map(included.map((r) => [`${r.type}:${r.id}`, r]));
  const domainName = new Map(domains.map((d) => [d.id, d.attributes?.name ?? d.id]));

  const courses = publishedCourses.map((pc) => {
    const a = pc.attributes ?? {};
    const courseId = pc.relationships?.course?.data?.id ?? null;
    const domainId = pc.relationships?.domain?.data?.id ?? null;
    return {
      kind: 'course',
      id: pc.id,
      objectId: courseId,
      title: titleOf(inc, 'courses', courseId) || a.slug || pc.id,
      courseFound: inc.has(`courses:${courseId}`),
      slug: a.slug ?? '',
      domainId,
      domain: domainName.get(domainId) ?? domainId ?? '',
      live: a.live !== false,
      hidden: Boolean(a.is_hidden),
      strict: Boolean(a.strict_enforce_group_visibility),
      overrideType: a.visibility_override_type ?? 'GROUP',
      allow: [],
      block: [],
      categories: []
    };
  });
  const courseById = byId(courses);

  const danglingOverrides = [];
  for (const g of groups) {
    for (const ov of overridesByGroup[g.id] ?? []) {
      const pcId = ov.attributes?.published_course_id;
      const visible = ov.attributes?.is_visible !== false;
      const course = courseById.get(pcId);
      if (!course) danglingOverrides.push({ groupId: g.id, publishedCourseId: pcId, isVisible: visible });
      else (visible ? course.allow : course.block).push(g.id);
    }
  }

  const paths = publishedPaths.map((pp) => {
    const a = pp.attributes ?? {};
    const pathId = pp.relationships?.path?.data?.id ?? null;
    const domainId = pp.relationships?.domain?.data?.id ?? null;
    const details = pathDetails[pp.id] ?? {};
    const groupIds = (details.groups ?? []).map((g) => g.id);
    const hidden = Boolean(a.is_hidden);
    return {
      kind: 'path',
      id: pp.id,
      objectId: pathId,
      title: titleOf(inc, 'paths', pathId) || a.slug || pp.id,
      slug: a.slug ?? '',
      domainId,
      domain: domainName.get(domainId) ?? domainId ?? '',
      live: true,
      hidden,
      strict: Boolean(a.strict_enforce_group_visibility),
      overrideType: a.visibility_override_type ?? 'GROUP',
      registrationStatus: a.registration_status ?? '',
      allow: hidden ? groupIds : [],
      block: hidden ? [] : groupIds,
      categories: (details.categories ?? []).map((c) => c.id),
      courseIds: (details.items ?? [])
        .slice()
        .sort((x, y) => (x.attributes?.order ?? 0) - (y.attributes?.order ?? 0))
        .map((item) => item.relationships?.published_course?.data?.id)
        .filter(Boolean)
    };
  });

  return {
    domains: domains.map((d) => ({ id: d.id, name: d.attributes?.name ?? d.id })),
    groups: groups.map((g) => ({ id: g.id, name: g.attributes?.name ?? g.id })),
    courses,
    paths,
    danglingOverrides
  };
}

/** True when the record's visibility rules leave the GROUP model. */
export function isUncertain(record) {
  return record.overrideType !== 'GROUP' || record.categories.length > 0;
}

/**
 * Whether a record is listed in one audience's catalog, and whether a direct
 * link opens it for them. An unpublished course is neither, for anyone.
 */
export function viewFor(record, audience) {
  if (!record.live) return { listed: false, canOpen: false };
  const listed = audience === EVERYONE
    ? !record.hidden
    : record.hidden ? record.allow.includes(audience) : !record.block.includes(audience);
  return { listed, canOpen: record.strict ? listed : true };
}

/** `listed`, `link-only`, `blocked` or `unpublished`. */
export function effectiveOf(record, view) {
  if (!record.live) return 'unpublished';
  if (view.listed) return 'listed';
  return view.canOpen ? 'link-only' : 'blocked';
}

/**
 * Hidden, strict, or carrying any group or category rule. A record that is
 * none of these is visible to everyone and has nothing to report.
 */
export function isRestricted(record) {
  return record.hidden || record.strict || record.allow.length > 0 || record.block.length > 0 || record.categories.length > 0;
}

const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * The record's effect in one or two plain sentences. `nameOf` maps a group id
 * to its name.
 */
export function describe(record, nameOf) {
  const thing = record.kind === 'course' ? 'course' : 'path';
  const on = `on ${record.domain}`;
  const allow = list(record.allow.map(nameOf));
  const block = list(record.block.map(nameOf));
  const parts = [];

  if (!record.live) {
    const n = record.allow.length + record.block.length;
    return `Not live ${on}, so nobody can see it.${n ? ` Its ${n} group override(s) (${list([...record.allow, ...record.block].map(nameOf))}) do nothing unless it is published again.` : ''}`;
  }

  if (record.hidden && record.strict) {
    parts.push(record.allow.length
      ? `Only members of ${allow} can see this ${thing} ${on}. Everyone else is blocked, even with a direct link.`
      : `Nobody can see this ${thing} ${on}: it is hidden, strict enforcement is on, and no group is allowed.`);
  } else if (record.hidden) {
    parts.push(record.allow.length
      ? `Listed in the catalog ${on} only for members of ${allow}. Strict enforcement is off, so anyone else can still open it with a direct link.`
      : `Hidden from the catalog ${on} for everyone. Strict enforcement is off, so anyone can still open it with a direct link.`);
  } else if (record.strict) {
    parts.push(record.block.length
      ? `Visible to everyone ${on} except members of ${block}, who are blocked even with a direct link.`
      : `Visible to everyone ${on}. Strict enforcement is on but has nothing to enforce: the ${thing} is not hidden and no group is blocked.`);
  } else {
    parts.push(record.block.length
      ? `Visible to everyone ${on}, but taken out of the catalog for members of ${block}. Strict enforcement is off, so they can still open it with a direct link.`
      : `Visible to everyone ${on}.`);
  }

  if (record.kind === 'course') {
    if (!record.hidden && record.allow.length) parts.push(`The allowlist override for ${allow} has no effect, because the course is not hidden.`);
    if (record.hidden && record.block.length) parts.push(`The blocklist override for ${block} has no effect, because the course is already hidden.`);
  }
  if (record.overrideType !== 'GROUP') parts.push(`Its visibility_override_type is ${record.overrideType}, which this report does not model, so the group rules above may not be the ones in force.`);
  if (record.categories.length) parts.push(`It also has ${record.categories.length} group-category visibility rule(s), which this report does not model.`);
  return parts.join(' ');
}

/**
 * Likely mistakes. Each is `{ severity, kind, domain, title, message,
 * groupIds }`: `problem` for something that is almost certainly not meant,
 * `note` for something that may be deliberate.
 */
export function findings(catalog) {
  const out = [];
  const nameOf = groupNamer(catalog.groups);
  const courseById = byId(catalog.courses);
  const audiences = [EVERYONE, ...catalog.groups.map((g) => g.id)];
  const audienceName = (a) => (a === EVERYONE ? EVERYONE : nameOf(a));
  const add = (severity, kind, record, message, groupIds = []) =>
    out.push({ severity, kind, domain: record?.domain ?? '', title: record?.title ?? '', message, groupIds });

  for (const d of catalog.danglingOverrides) {
    add('problem', 'override-missing-course', null,
      `${nameOf(d.groupId)} has an ${d.isVisible ? 'allowlist' : 'blocklist'} override on published course ${d.publishedCourseId}, which no domain lists any more (deleted).`,
      [d.groupId]);
  }

  for (const c of catalog.courses) {
    const groupIds = [...c.allow, ...c.block];
    if (!c.live && groupIds.length) {
      add('problem', 'override-unpublished-course', c,
        `${list(groupIds.map(nameOf))} ${groupIds.length > 1 ? 'have overrides' : 'has an override'} on ${labelOf(c)} on ${c.domain}, which is not live` +
        (c.courseFound ? '' : ' and whose course no longer exists (deleted)') + '. The override does nothing.',
        groupIds);
      continue;
    }
    if (!c.live) continue;
    if (c.hidden && c.strict && !c.allow.length) {
      add('problem', 'nobody-can-see', c, `${labelOf(c)} is hidden with strict enforcement and no allowed group: nobody can see or open it on ${c.domain}.`);
    }
    for (const id of c.allow.filter((g) => c.block.includes(g))) {
      add('problem', 'override-conflict', c, `${nameOf(id)} has both an allowlist and a blocklist override on "${c.title}" on ${c.domain}. Which wins is not documented.`, [id]);
    }
    if (!c.hidden && c.allow.length) {
      add('note', 'override-no-effect', c, `"${c.title}" on ${c.domain} is not hidden, so its allowlist override for ${list(c.allow.map(nameOf))} has no effect.`, c.allow);
    }
    if (c.hidden && c.block.length) {
      add('note', 'override-no-effect', c, `"${c.title}" on ${c.domain} is already hidden, so its blocklist override for ${list(c.block.map(nameOf))} has no effect.`, c.block);
    }
    if (c.hidden && !c.strict && !c.allow.length) {
      add('note', 'link-only', c, `${labelOf(c)} is hidden from everyone on ${c.domain} but open to anyone with a direct link.`);
    }
  }

  for (const p of catalog.paths) {
    if (p.hidden && p.strict && !p.allow.length && !p.categories.length) {
      add('problem', 'nobody-can-see', p, `Path ${labelOf(p)} is hidden with strict enforcement and no allowed group: nobody can see or open it on ${p.domain}.`);
    }
    if (p.registrationStatus && p.registrationStatus !== 'OPEN') {
      add('problem', 'path-registration-closed', p, `Path "${p.title}" on ${p.domain} reports registration_status ${p.registrationStatus}.`);
    }

    const items = p.courseIds.map((id) => ({ id, course: courseById.get(id) }));
    for (const { id, course } of items) {
      if (!course) add('problem', 'path-course-missing', p, `Path "${p.title}" on ${p.domain} includes published course ${id}, which no domain lists.`);
      else if (!course.live) add('problem', 'path-course-unpublished', p, `Path "${p.title}" on ${p.domain} includes ${labelOf(course)}, which is not live.`);
      else if (course.domainId !== p.domainId) add('problem', 'path-course-other-domain', p, `Path "${p.title}" on ${p.domain} includes "${course.title}" as published on ${course.domain}.`);
    }
    const known = items.filter((i) => i.course);
    if (!known.length) continue;

    const seesPath = audiences.filter((a) => viewFor(p, a).listed);
    const closed = seesPath.filter((a) => known.every((i) => !viewFor(i.course, a).listed));
    if (closed.length) {
      const everyone = closed.includes(EVERYONE);
      add('problem', 'path-no-visible-course', p,
        `Path "${p.title}" on ${p.domain} is listed for ${list(closed.map(audienceName))}, but none of its ${known.length} course(s) is.` +
        (everyone ? ' A path with no visible course has its registration closed.' : '') +
        (closed.some((a) => a !== EVERYONE) ? ' For a group, that registration closes too is inferred, not observed.' : ''),
        closed.filter((a) => a !== EVERYONE));
    }

    const unseen = new Map();
    for (const { course } of known) {
      if (!course.live) continue;
      const missing = seesPath.filter((a) => !closed.includes(a) && !viewFor(course, a).listed);
      if (!missing.length) continue;
      const key = `${missing.join(',')}|${course.strict}`;
      if (!unseen.has(key)) unseen.set(key, { missing, strict: course.strict, courses: [] });
      unseen.get(key).courses.push(course);
    }
    for (const { missing, strict, courses } of unseen.values()) {
      add('problem', 'restricted-course-in-path', p,
        `Path "${p.title}" on ${p.domain} is listed for ${list(missing.map(audienceName))}, but ${courses.length} of its ${known.length} course(s) ${courses.length > 1 ? 'are' : 'is'} not: ` +
        `${list(courses.map((c) => `"${c.title}"`))}` +
        (strict ? '. Strict enforcement blocks them from opening ' + (courses.length > 1 ? 'these.' : 'it.') : ', though a direct link still opens ' + (courses.length > 1 ? 'them.' : 'it.')),
        missing.filter((a) => a !== EVERYONE));
    }
  }

  return out;
}

/**
 * `"Title" (slug)`, or the slug alone when no title was read: the include
 * returns none for some unpublished copies, whose title falls back to it.
 */
export function labelOf(record) {
  return record.title && record.title !== record.slug ? `"${record.title}" (${record.slug})` : record.slug || record.id;
}

export function groupNamer(groups) {
  const names = new Map(groups.map((g) => [g.id, g.name]));
  return (id) => names.get(id) ?? `unknown group ${id}`;
}

/**
 * What one group changes relative to everyone else, per record: what it
 * unlocks (listed or openable for the group and not for everyone) and what it
 * is kept from (the reverse).
 */
export function groupEffects(catalog, groupId) {
  const unlocks = [];
  const keptFrom = [];
  for (const r of [...catalog.courses, ...catalog.paths]) {
    if (!r.live) continue;
    const g = viewFor(r, groupId);
    const e = viewFor(r, EVERYONE);
    if ((g.listed && !e.listed) || (g.canOpen && !e.canOpen)) unlocks.push({ record: r, view: g });
    else if ((!g.listed && e.listed) || (!g.canOpen && e.canOpen)) keptFrom.push({ record: r, view: g });
  }
  return { unlocks, keptFrom };
}

/** One row per record and audience, every record included. */
export function visibilityRows(catalog, audiences) {
  const nameOf = groupNamer(catalog.groups);
  const rows = [];
  for (const r of [...catalog.courses, ...catalog.paths]) {
    for (const a of audiences) {
      const view = viewFor(r, a);
      rows.push({
        kind: r.kind,
        title: r.title,
        slug: r.slug,
        domain: r.domain,
        audience: a === EVERYONE ? EVERYONE : nameOf(a),
        effective: effectiveOf(r, view),
        listed_in_catalog: view.listed,
        can_open: view.canOpen,
        restricted: isRestricted(r),
        is_hidden: r.hidden,
        strict_enforce_group_visibility: r.strict,
        uncertain: isUncertain(r),
        published_id: r.id,
        object_id: r.objectId ?? ''
      });
    }
  }
  return rows.sort((x, y) => x.domain.localeCompare(y.domain) || x.kind.localeCompare(y.kind)
    || x.title.localeCompare(y.title) || (x.audience === EVERYONE ? -1 : y.audience === EVERYONE ? 1 : x.audience.localeCompare(y.audience)));
}

/**
 * The group a `--group` value names: its id, or its name ignoring case.
 */
export function resolveGroup(groups, query) {
  const q = String(query).trim();
  const byGroupId = groups.find((g) => g.id === q);
  if (byGroupId) return { group: byGroupId };
  const named = groups.filter((g) => g.name.toLowerCase() === q.toLowerCase());
  return named.length === 1 ? { group: named[0] } : { group: null, ambiguous: named.length > 1 };
}

/**
 * The catalog narrowed to some domain names. Groups and dangling overrides
 * are kept: they belong to no domain.
 */
export function filterDomains(catalog, names) {
  if (!names.length) return catalog;
  const keep = (r) => names.includes(r.domain);
  return { ...catalog, domains: catalog.domains.filter((d) => names.includes(d.name)), courses: catalog.courses.filter(keep), paths: catalog.paths.filter(keep) };
}
