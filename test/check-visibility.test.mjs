import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVERYONE, buildCatalog, describe, effectiveOf, filterDomains, findings, groupEffects, groupNamer,
  isRestricted, labelOf, resolveGroup, viewFor, visibilityRows
} from '#lib/visibility/visibility.mjs';
import { fetchVisibilityInputs, listAllWithIncluded } from '#lib/visibility/fetch.mjs';

const domains = [
  { id: 'd1', attributes: { name: 'courses.example.com' } },
  { id: 'd2', attributes: { name: 'test.example.com' } }
];
const groups = [
  { id: 'gP', attributes: { name: 'Partners' } },
  { id: 'gE', attributes: { name: 'Employees' } }
];

function pc(id, { course = `c-${id}`, domain = 'd1', live = true, hidden = false, strict = false, type = 'GROUP' } = {}) {
  return {
    id,
    attributes: { slug: `slug-${id}`, live, is_hidden: hidden, strict_enforce_group_visibility: strict, visibility_override_type: type },
    relationships: { course: { data: { type: 'courses', id: course } }, domain: { data: { type: 'domains', id: domain } } }
  };
}
function pp(id, { path = `p-${id}`, domain = 'd1', hidden = false, strict = false, status = 'OPEN' } = {}) {
  return {
    id,
    attributes: { slug: `slug-${id}`, is_hidden: hidden, strict_enforce_group_visibility: strict, visibility_override_type: 'GROUP', registration_status: status },
    relationships: { path: { data: { type: 'paths', id: path } }, domain: { data: { type: 'domains', id: domain } } }
  };
}
const ov = (publishedCourseId, isVisible = true) => ({ attributes: { published_course_id: publishedCourseId, is_visible: isVisible } });
const items = (...ids) => ids.map((id, i) => ({ attributes: { order: (i + 1) * 10 }, relationships: { published_course: { data: { id } } } }));
const titles = (...ids) => ids.map((id) => ({ type: 'courses', id: `c-${id}`, attributes: { title: `Course ${id}` } }));

function catalogOf({ publishedCourses = [], publishedPaths = [], overridesByGroup = {}, pathDetails = {}, included } = {}) {
  return buildCatalog({
    domains, groups, publishedCourses, publishedPaths, overridesByGroup, pathDetails,
    included: included ?? titles(...publishedCourses.map((p) => p.id))
  });
}
const kinds = (fs) => fs.map((f) => f.kind).sort();

test('overrides land on their course as allow or block lists, and unknown targets are kept aside', () => {
  const cat = catalogOf({
    publishedCourses: [pc('a', { hidden: true }), pc('b')],
    overridesByGroup: { gP: [ov('a'), ov('gone')], gE: [ov('b', false)] }
  });
  const [a, b] = cat.courses;
  assert.deepEqual([a.allow, a.block, b.allow, b.block], [['gP'], [], [], ['gE']]);
  assert.equal(a.title, 'Course a');
  assert.equal(a.domain, 'courses.example.com');
  assert.deepEqual(cat.danglingOverrides, [{ groupId: 'gP', publishedCourseId: 'gone', isVisible: true }]);
});

test('a path\'s group list allows on a hidden path and blocks on a visible one', () => {
  const cat = catalogOf({
    publishedPaths: [pp('h', { hidden: true }), pp('v')],
    pathDetails: { h: { groups: [{ id: 'gP' }] }, v: { groups: [{ id: 'gE' }] } }
  });
  assert.deepEqual(cat.paths.map((p) => [p.allow, p.block]), [[['gP'], []], [[], ['gE']]]);
});

test('path items keep their order', () => {
  const cat = catalogOf({
    publishedPaths: [pp('x')],
    pathDetails: { x: { items: [...items('b', 'a')].reverse() } }
  });
  assert.deepEqual(cat.paths[0].courseIds, ['b', 'a']);
});

test('the four combinations of hidden and strict, per audience', () => {
  const cat = catalogOf({
    publishedCourses: [
      pc('hs', { hidden: true, strict: true }),
      pc('h', { hidden: true }),
      pc('s', { strict: true }),
      pc('open')
    ],
    overridesByGroup: { gP: [ov('hs'), ov('h')], gE: [ov('s', false), ov('open', false)] }
  });
  const eff = (r, a) => effectiveOf(r, viewFor(r, a));
  const [hs, h, s, open] = cat.courses;
  assert.deepEqual([EVERYONE, 'gP', 'gE'].map((a) => eff(hs, a)), ['blocked', 'listed', 'blocked']);
  assert.deepEqual([EVERYONE, 'gP', 'gE'].map((a) => eff(h, a)), ['link-only', 'listed', 'link-only']);
  assert.deepEqual([EVERYONE, 'gP', 'gE'].map((a) => eff(s, a)), ['listed', 'listed', 'blocked']);
  assert.deepEqual([EVERYONE, 'gP', 'gE'].map((a) => eff(open, a)), ['listed', 'listed', 'link-only']);
});

test('an unpublished course is unpublished for everyone, overrides or not', () => {
  const cat = catalogOf({ publishedCourses: [pc('u', { live: false })], overridesByGroup: { gP: [ov('u')] } });
  const [u] = cat.courses;
  assert.equal(effectiveOf(u, viewFor(u, 'gP')), 'unpublished');
  assert.match(describe(u, groupNamer(cat.groups)), /Not live on courses\.example\.com, so nobody can see it\. Its 1 group override\(s\) \(Partners\)/);
});

test('the plain-words summary names who can see the record', () => {
  const cat = catalogOf({
    publishedCourses: [pc('hs', { hidden: true, strict: true }), pc('h', { hidden: true }), pc('s', { strict: true }), pc('open')],
    overridesByGroup: { gP: [ov('hs'), ov('h'), ov('open')], gE: [ov('hs')] }
  });
  const say = (i) => describe(cat.courses[i], groupNamer(cat.groups));
  assert.equal(say(0), 'Only members of Partners and Employees can see this course on courses.example.com. Everyone else is blocked, even with a direct link.');
  assert.match(say(1), /only for members of Partners\. Strict enforcement is off, so anyone else can still open it/);
  assert.match(say(2), /Strict enforcement is on but has nothing to enforce/);
  assert.equal(say(3), 'Visible to everyone on courses.example.com. The allowlist override for Partners has no effect, because the course is not hidden.');
});

test('CATEGORY mode and category rules are reported as not modelled', () => {
  const cat = catalogOf({
    publishedCourses: [pc('c', { type: 'CATEGORY', hidden: true })],
    publishedPaths: [pp('p')],
    pathDetails: { p: { categories: [{ id: 'cat1' }] } }
  });
  assert.match(describe(cat.courses[0], groupNamer(cat.groups)), /CATEGORY, which this report does not model/);
  assert.match(describe(cat.paths[0], groupNamer(cat.groups)), /1 group-category visibility rule\(s\)/);
  assert.equal(isRestricted(cat.paths[0]), true);
});

test('restricted means hidden, strict, or carrying any group rule', () => {
  const cat = catalogOf({ publishedCourses: [pc('plain'), pc('blocked')], overridesByGroup: { gE: [ov('blocked', false)] } });
  assert.deepEqual(cat.courses.map(isRestricted), [false, true]);
});

test('findings: overrides on missing or unpublished courses, and on deleted courses', () => {
  const cat = catalogOf({
    publishedCourses: [pc('u', { live: false }), pc('del', { live: false })],
    overridesByGroup: { gP: [ov('u'), ov('del'), ov('nowhere')] },
    included: titles('u')
  });
  const fs = findings(cat);
  assert.deepEqual(kinds(fs), ['override-missing-course', 'override-unpublished-course', 'override-unpublished-course']);
  assert.doesNotMatch(fs.find((f) => f.title === 'Course u').message, /deleted/);
  assert.match(fs.find((f) => f.title === 'slug-del').message, /slug-del on courses\.example\.com, which is not live and whose course no longer exists \(deleted\)/);
});

test('findings: hidden and strict with no allowed group means nobody can see it', () => {
  const cat = catalogOf({ publishedCourses: [pc('x', { hidden: true, strict: true })], publishedPaths: [pp('p', { hidden: true, strict: true })] });
  assert.deepEqual(kinds(findings(cat)), ['nobody-can-see', 'nobody-can-see']);
});

test('findings: overrides that have no effect, conflicts, and link-only courses', () => {
  const cat = catalogOf({
    publishedCourses: [pc('vis'), pc('hid', { hidden: true }), pc('both', { hidden: true, strict: true }), pc('lonely', { hidden: true })],
    overridesByGroup: { gP: [ov('vis'), ov('hid', false), ov('both'), ov('both', false)], gE: [ov('hid')] }
  });
  assert.deepEqual(kinds(findings(cat)), ['link-only', 'override-conflict', 'override-no-effect', 'override-no-effect', 'override-no-effect']);
});

test('findings: a path nobody but a group can see any course of', () => {
  const cat = catalogOf({
    publishedCourses: [pc('a', { hidden: true, strict: true }), pc('b', { hidden: true })],
    publishedPaths: [pp('p')],
    overridesByGroup: { gP: [ov('a')] },
    pathDetails: { p: { items: items('a', 'b') } }
  });
  const fs = findings(cat);
  const closed = fs.find((f) => f.kind === 'path-no-visible-course');
  assert.match(closed.message, /listed for \(everyone\) and Employees, but none of its 2 course\(s\) is\. A path with no visible course has its registration closed\. For a group, that registration closes too is inferred/);
  assert.deepEqual(closed.groupIds, ['gE']);
  assert.match(fs.find((f) => f.kind === 'restricted-course-in-path').message, /listed for Partners, but 1 of its 2 course\(s\) is not: "Course b", though a direct link still opens it/);
});

test('findings: restricted courses inside an open path are grouped per audience', () => {
  const cat = catalogOf({
    publishedCourses: [pc('open'), pc('a', { hidden: true, strict: true }), pc('b', { hidden: true, strict: true })],
    publishedPaths: [pp('p')],
    overridesByGroup: { gP: [ov('a'), ov('b')] },
    pathDetails: { p: { items: items('open', 'a', 'b') } }
  });
  const fs = findings(cat).filter((f) => f.kind === 'restricted-course-in-path');
  assert.equal(fs.length, 1);
  assert.match(fs[0].message, /listed for \(everyone\) and Employees, but 2 of its 3 course\(s\) are not: "Course a" and "Course b"\. Strict enforcement blocks them from opening these\./);
});

test('findings: path items that are missing, unpublished or closed', () => {
  const cat = catalogOf({
    publishedCourses: [pc('u', { live: false }), pc('ok')],
    publishedPaths: [pp('p', { status: 'CLOSED' })],
    pathDetails: { p: { items: items('u', 'ok', 'gone') } }
  });
  assert.deepEqual(kinds(findings(cat)), ['path-course-missing', 'path-course-unpublished', 'path-registration-closed']);
});

test('a group\'s effects: what it unlocks and what it is kept from', () => {
  const cat = catalogOf({
    publishedCourses: [pc('a', { hidden: true }), pc('b', { strict: true }), pc('c')],
    overridesByGroup: { gP: [ov('a'), ov('b', false)] }
  });
  const { unlocks, keptFrom } = groupEffects(cat, 'gP');
  assert.deepEqual([unlocks.map((x) => x.record.id), keptFrom.map((x) => x.record.id)], [['a'], ['b']]);
  assert.deepEqual(groupEffects(cat, 'gE'), { unlocks: [], keptFrom: [] });
});

test('CSV rows: one per record and audience, everyone first', () => {
  const cat = catalogOf({ publishedCourses: [pc('a', { hidden: true, strict: true })], overridesByGroup: { gP: [ov('a')] } });
  const rows = visibilityRows(cat, [EVERYONE, 'gP']);
  assert.deepEqual(rows.map((r) => [r.audience, r.effective, r.listed_in_catalog, r.can_open]), [
    [EVERYONE, 'blocked', false, false],
    ['Partners', 'listed', true, true]
  ]);
  assert.equal(rows[0].domain, 'courses.example.com');
});

test('--group matches an id or a name ignoring case', () => {
  const cat = catalogOf();
  assert.equal(resolveGroup(cat.groups, 'gE').group.name, 'Employees');
  assert.equal(resolveGroup(cat.groups, ' partners ').group.id, 'gP');
  assert.deepEqual(resolveGroup(cat.groups, 'nope'), { group: null, ambiguous: false });
  assert.deepEqual(resolveGroup([{ id: '1', name: 'A' }, { id: '2', name: 'a' }], 'A'), { group: null, ambiguous: true });
});

test('--domain keeps one domain\'s records, and labels fall back to the slug', () => {
  const cat = filterDomains(catalogOf({ publishedCourses: [pc('a'), pc('b', { domain: 'd2' })] }), ['test.example.com']);
  assert.deepEqual(cat.courses.map((c) => c.id), ['b']);
  assert.equal(labelOf(cat.courses[0]), '"Course b" (slug-b)');
  assert.equal(labelOf({ title: 'slug-x', slug: 'slug-x' }), 'slug-x');
});

function fakeClient(pages) {
  const calls = [];
  return {
    calls,
    async get(url, { params } = {}) {
      calls.push({ url, params });
      const list = pages[url];
      if (!list) throw Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } });
      const at = params?.['page[cursor]'] ? Number(params['page[cursor]']) : 0;
      const next = at + 1 < list.length ? `/v2${url}?page%5Bcursor%5D=${at + 1}` : null;
      return { data: { ...list[at], links: { next } } };
    }
  };
}

test('listAllWithIncluded keeps every page\'s data and included', async () => {
  const client = fakeClient({ '/x/': [{ data: [1], included: ['a'] }, { data: [2], included: ['b'] }] });
  assert.deepEqual(await listAllWithIncluded(client, '/x/', { include: 'course' }), { data: [1, 2], included: ['a', 'b'] });
  assert.equal(client.calls[0].params.include, 'course');
});

test('fetchVisibilityInputs makes only reads, and names the stage that failed', async () => {
  const client = fakeClient({
    '/domains/': [{ data: domains }],
    '/groups/': [{ data: groups }],
    '/published-courses/': [{ data: [pc('a')], included: titles('a') }],
    '/published-paths/': [{ data: [pp('p')] }],
    '/groups/gP/relationships/published-course-visibility/': [{ data: [ov('a')] }],
    '/groups/gE/relationships/published-course-visibility/': [{ data: [] }],
    '/published-paths/p/path-items/': [{ data: items('a') }],
    '/published-paths/p/relationships/group-visibility/': [{ data: [] }],
    '/published-paths/p/relationships/category-visibility/': [{ data: [] }]
  });
  const inputs = await fetchVisibilityInputs(client);
  assert.deepEqual(Object.keys(client), ['calls', 'get']);
  assert.equal(client.calls.find((c) => c.url === '/published-paths/').params.include, 'path');
  assert.deepEqual(buildCatalog(inputs).courses[0].allow, ['gP']);

  const broken = fakeClient({ '/domains/': [{ data: domains }], '/groups/': [{ data: groups }] });
  await assert.rejects(fetchVisibilityInputs(broken), (err) => err.visibilityStage === 'Could not list published courses (needs published-courses:read)');
});
