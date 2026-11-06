import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { isSyncCommit, parseGitLog, parseSinceDate, pickSyncCommit, resolveSince } from '#lib/drift/since.mjs';
import { AUDIT_TARGET_TYPES, classifyEvent, fetchAuditEvents, slimEvent, splitWindows } from '#lib/drift/audit-events.mjs';
import { buildDriftReport, matchCourses, readLocalTree, resolveUnknownTargets, unknownTargets, withoutActors } from '#lib/drift/report.mjs';
import { formatDriftReport } from '#lib/drift/format.mjs';

const DAY = 86_400_000;

// --- since ---------------------------------------------------------------

test('a --since date always carries a timezone, defaulting to UTC', () => {
  assert.equal(parseSinceDate('2026-10-01'), '2026-10-01T00:00:00.000Z');
  assert.equal(parseSinceDate('2026-10-01T12:30'), '2026-10-01T12:30:00.000Z');
  assert.equal(parseSinceDate('2026-10-01T12:30:00+02:00'), '2026-10-01T10:30:00.000Z');
  assert.equal(parseSinceDate('HEAD~3'), null);
  assert.equal(parseSinceDate('59f6afa1'), null);
  assert.throws(() => parseSinceDate('2026-13-45'), /not a valid date/);
});

test('pull commits are recognised by subject, and link fixes are not', () => {
  for (const s of [
    'chore(content): sync Skilljar → courses/, paths/, quizzes/',
    'Sync Skilljar content (#312)',
    'sync: first pull with quiz support, backfilling lesson fields',
    'content: pull the 13 course descriptions, drop the deleted Untitled Course'
  ]) assert.ok(isSyncCommit(s), s);
  for (const s of [
    'chore: update links that have permanently moved (#374)',
    'content: attach videos to the Libraries Launchpad steps',
    'content: record the Skilljar modified_at after pushing #233',
    'chore: back-merge main into dev'
  ]) assert.ok(!isSyncCommit(s), s);
});

test('the since point is the newest pull, not the newest commit', () => {
  const commits = [
    { sha: 'c3', date: '2026-11-05T00:00:00.000Z', subject: 'content: fix a typo' },
    { sha: 'c2', date: '2026-11-04T00:00:00.000Z', subject: 'chore: update links that have permanently moved' },
    { sha: 'c1', date: '2026-11-01T00:00:00.000Z', subject: 'chore(content): sync Skilljar → courses/' },
    { sha: 'c0', date: '2026-10-01T00:00:00.000Z', subject: 'chore(content): sync Skilljar → courses/' }
  ];
  const picked = pickSyncCommit(commits);
  assert.equal(picked.sync.sha, 'c1');
  assert.equal(picked.latest.sha, 'c3');
  assert.equal(picked.localAfterSync, 2);
  assert.deepEqual(pickSyncCommit([]), { sync: null, latest: null, localAfterSync: 0 });
});

test('git log output is parsed into commits with UTC dates', () => {
  const out = 'abc\x1f2026-10-28T18:51:02+01:00\x1fchore: a\x1fb\ndef\x1f2026-10-01T00:00:00Z\x1fsync Skilljar\n';
  assert.deepEqual(parseGitLog(out), [
    { sha: 'abc', date: '2026-10-28T17:51:02.000Z', subject: 'chore: a\x1fb' },
    { sha: 'def', date: '2026-10-01T00:00:00.000Z', subject: 'sync Skilljar' }
  ]);
});

test('resolveSince takes a date, a ref, or the last pull, and only ever runs git log', async () => {
  const calls = [];
  const git = async (args) => {
    calls.push(args);
    if (args.includes('nope')) throw new Error('bad ref');
    if (args[1] === '-1') return 'r1\x1f2026-09-01T00:00:00Z\x1fsome commit\n';
    return 'c2\x1f2026-11-02T00:00:00Z\x1fcontent: edit\nc1\x1f2026-11-01T00:00:00Z\x1fSync Skilljar content\n';
  };
  assert.deepEqual(await resolveSince({ since: '2026-10-01', contentPath: '/x', git }), { since: '2026-10-01T00:00:00.000Z', source: 'date' });
  const ref = await resolveSince({ since: 'HEAD~2', contentPath: '/x', git });
  assert.equal(ref.source, 'ref');
  assert.equal(ref.since, '2026-09-01T00:00:00.000Z');
  const last = await resolveSince({ contentPath: '/x', git });
  assert.equal(last.source, 'last-sync');
  assert.equal(last.since, '2026-11-01T00:00:00.000Z');
  assert.equal(last.localAfterSync, 1);
  await assert.rejects(resolveSince({ since: 'nope', contentPath: '/x', git }), /neither a date/);
  assert.ok(calls.every((args) => args[0] === 'log'));

  const noSync = async () => 'c2\x1f2026-11-02T00:00:00Z\x1fcontent: edit\n';
  await assert.rejects(resolveSince({ contentPath: '/x', git: noSync }), /No pull commit/);
  const notRepo = async () => { throw new Error('not a git repository'); };
  await assert.rejects(resolveSince({ contentPath: '/x', git: notRepo }), /not in a git repository/);
});

// --- audit events --------------------------------------------------------

test('a range is split into contiguous windows of at most 90 days', () => {
  const since = '2026-01-01T00:00:00.000Z';
  assert.deepEqual(splitWindows(since, '2026-02-01T00:00:00.000Z'), [{ gte: since, lte: '2026-02-01T00:00:00.000Z' }]);
  const windows = splitWindows(since, new Date(Date.parse(since) + 200 * DAY).toISOString());
  assert.equal(windows.length, 3);
  assert.equal(windows[0].gte, since);
  for (let i = 0; i < windows.length; i++) {
    assert.ok(Date.parse(windows[i].lte) - Date.parse(windows[i].gte) <= 90 * DAY);
    if (i) assert.equal(windows[i].gte, windows[i - 1].lte);
  }
  assert.equal(windows.at(-1).lte, new Date(Date.parse(since) + 200 * DAY).toISOString());
  assert.equal(splitWindows(since, since).length, 1);
  assert.throws(() => splitWindows('2026-02-01T00:00:00Z', since), /after/);
});

const record = (id, created, type, targetId, action, field = null, name = 'X') => ({
  type: 'audit-events',
  id,
  attributes: {
    channel: null,
    user: { id: 'u1', username: 'someone@example.com' },
    client: { name: null },
    action,
    target: { type, id: targetId, display_name: name },
    field,
    old_value: null,
    new_value: null,
    request_id: null,
    endpoint: null,
    created_at: created
  }
});

test('an event keeps no actor unless asked to', () => {
  const r = record('e1', '2026-11-01T00:00:00Z', 'lesson', 'l1', 'update', 'HTML');
  assert.equal('actor' in slimEvent(r), false);
  assert.ok(!JSON.stringify(slimEvent(r)).includes('someone'));
  assert.equal(slimEvent(r, { keepActors: true }).actor, 'someone@example.com');
});

test('events are read per type and window, with zoned filters, no channel filter, deduplicated', async () => {
  const calls = [];
  const boundary = record('dup', '2026-04-01T00:00:00.000Z', 'lesson', 'l1', 'update', 'HTML');
  const client = {
    async get(url, { params }) {
      calls.push({ url, params });
      const data = params['filter[target_type]'] === 'lesson' ? [boundary, record(`e-${calls.length}`, params['filter[created_gte]'], 'lesson', 'l2', 'create')] : [];
      return { data: { data, links: { next: null } } };
    }
  };
  const events = await fetchAuditEvents(client, { since: '2026-01-01T00:00:00Z', until: '2026-06-01T00:00:00Z' });
  assert.equal(calls.length, AUDIT_TARGET_TYPES.length * 2);
  for (const { url, params } of calls) {
    assert.equal(url, '/audit-events/');
    assert.match(params['filter[created_gte]'], /Z$/);
    assert.match(params['filter[created_lte]'], /Z$/);
    assert.equal('filter[channel]' in params, false);
  }
  assert.equal(events.filter((e) => e.id === 'dup').length, 1);
  assert.deepEqual(events.map((e) => e.createdAt), [...events.map((e) => e.createdAt)].sort().reverse());
});

test('content edits are told apart from structure and settings', () => {
  const kind = (targetType, action, field = null) => classifyEvent({ targetType, action, field });
  assert.equal(kind('lesson', 'update', 'HTML'), 'content');
  assert.equal(kind('lesson', 'update', 'VIDEO'), 'content');
  assert.equal(kind('lesson', 'update', 'QUIZ'), 'content');
  assert.equal(kind('lesson', 'upload', 'downloadable_content'), 'content');
  assert.equal(kind('lesson', 'create'), 'structure');
  assert.equal(kind('section', 'reorder'), 'structure');
  assert.equal(kind('course', 'publish'), 'structure');
  assert.equal(kind('lesson', 'update', 'title'), 'settings');
  assert.equal(kind('lesson', 'add', 'description_html'), 'settings');
  assert.equal(kind('course', 'update', 'long_description_html'), 'settings');
});

// --- local tree and report -----------------------------------------------

async function makeTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncjar-drift-'));
  await fs.outputJson(path.join(root, 'Course-A', 'details.json'), { id: 'cA', title: 'Course A' });
  await fs.outputJson(path.join(root, 'Course-A', 'lessons-meta.json'), [
    { id: 'l1', title: 'One', type: 'MODULAR', content_items: [] },
    { id: 's1', title: 'Section', type: 'SECTION', content_items: [] }
  ]);
  await fs.outputJson(path.join(root, 'Course-B', 'details.json'), { id: 'cB', title: 'Course B: Launchpad' });
  await fs.outputJson(path.join(root, 'Course-B', 'lessons-meta.json'), [{ id: 'l2', title: 'Two', type: 'MODULAR', content_items: [] }]);
  await fs.ensureDir(path.join(root, 'not-a-course'));
  await fs.outputJson(path.join(root, 'course-urls.json'), {});
  return root;
}

test('the local tree is indexed by course and lesson id', async () => {
  const root = await makeTree();
  try {
    const local = await readLocalTree(root);
    assert.deepEqual([...local.courses.keys()], ['cA', 'cB']);
    assert.deepEqual(local.lessons.get('s1'), { id: 's1', courseId: 'cA', title: 'Section', type: 'SECTION', order: null });
    assert.deepEqual(matchCourses(local.courses, 'Course-A').map((c) => c.id), ['cA']);
    assert.deepEqual(matchCourses(local.courses, 'cB').map((c) => c.id), ['cB']);
    assert.deepEqual(matchCourses(local.courses, 'launchpad').map((c) => c.id), ['cB']);
    assert.deepEqual(matchCourses(local.courses, 'course').map((c) => c.id), ['cA', 'cB']);
    assert.deepEqual(matchCourses(local.courses, 'zzz'), []);
  } finally {
    await fs.remove(root);
  }
});

test('unknown targets are looked up with GETs; a 404 means deleted and anything else is thrown', async () => {
  const urls = [];
  const client = {
    async get(url) {
      urls.push(url);
      if (url === '/lessons/new') return { data: { data: { id: 'new', attributes: { course_id: 'cA', title: 'New' } } } };
      if (url === '/lessons/orphan') return { data: { data: { id: 'orphan', attributes: { course_id: 'gone', title: 'Orphan' } } } };
      if (url === '/courses/cA') return { data: { data: { id: 'cA', attributes: { title: 'Course A' } } } };
      if (url === '/lessons/boom') { const e = new Error('x'); e.response = { status: 500 }; throw e; }
      const e = new Error('x'); e.response = { status: 404 }; throw e;
    }
  };
  const r = await resolveUnknownTargets(client, { lessonIds: ['new', 'orphan', 'dead'], courseIds: ['cX'] });
  assert.deepEqual(r.lessons.get('new'), { exists: true, courseId: 'cA', title: 'New' });
  assert.deepEqual(r.lessons.get('dead'), { exists: false });
  assert.deepEqual(r.courses.get('gone'), { exists: false });
  assert.deepEqual(r.courses.get('cX'), { exists: false });
  assert.ok(urls.every((u) => /^\/(lessons|courses)\//.test(u)));
  await assert.rejects(resolveUnknownTargets(client, { lessonIds: ['boom'] }));
});

const ev = (id, createdAt, targetType, targetId, action, field = null, extra = {}) =>
  ({ id, createdAt, targetType, targetId, action, field, targetName: extra.name ?? targetId, ...extra });

function sampleReport({ courseIds = null, actors = false } = {}) {
  const local = {
    courses: new Map([['cA', { id: 'cA', dir: 'Course-A', title: 'Course A' }], ['cB', { id: 'cB', dir: 'Course-B', title: 'Course B' }]]),
    lessons: new Map([
      ['l1', { id: 'l1', courseId: 'cA', title: 'One', type: 'MODULAR' }],
      ['s1', { id: 's1', courseId: 'cA', title: 'Section', type: 'SECTION' }],
      ['l2', { id: 'l2', courseId: 'cB', title: 'Two', type: 'MODULAR' }]
    ])
  };
  const who = actors ? { actor: 'someone@example.com' } : {};
  const events = [
    ev('1', '2026-11-03T00:00:00Z', 'lesson', 'l1', 'update', 'HTML', who),
    ev('2', '2026-11-01T00:00:00Z', 'lesson', 'l1', 'update', 'HTML', who),
    ev('3', '2026-11-02T00:00:00Z', 'lesson', 'l1', 'update', 'title'),
    ev('4', '2026-11-02T00:00:00Z', 'section', 's1', 'update', 'title'),
    ev('5', '2026-11-04T00:00:00Z', 'course', 'cB', 'update', 'short_description'),
    ev('6', '2026-11-02T00:00:00Z', 'lesson', 'new', 'create'),
    ev('7', '2026-11-02T00:00:00Z', 'lesson', 'dead', 'delete', null, { name: 'Dead lesson' }),
    ev('8', '2026-11-02T00:00:00Z', 'lesson', 'orphan', 'update', 'HTML'),
    ev('9', '2026-11-02T00:00:00Z', 'course', 'gone', 'delete', null, { name: 'Gone course' })
  ];
  const resolved = {
    lessons: new Map([['new', { exists: true, courseId: 'cA', title: 'New' }], ['dead', { exists: false }], ['orphan', { exists: true, courseId: 'gone', title: 'Orphan' }]]),
    courses: new Map([['gone', { exists: false }]])
  };
  return { report: buildDriftReport({ events, local, resolved, courseIds }), events, local };
}

test('unknownTargets lists ids the tree lacks', () => {
  const { events, local } = sampleReport();
  assert.deepEqual(unknownTargets(events, local), { lessonIds: ['new', 'dead', 'orphan'], courseIds: ['gone'] });
});

test('events are grouped by course and lesson, collapsed by field, content first', () => {
  const { report } = sampleReport();
  const [a, b] = report.courses.filter((c) => c.inTree);
  assert.equal(a.id, 'cA');
  assert.deepEqual(a.counts, { content: 2, structure: 1, settings: 2 });
  const one = a.lessons.find((l) => l.id === 'l1');
  assert.deepEqual(one.changes.map((c) => [c.label, c.kind, c.count]), [['HTML', 'content', 2], ['title', 'settings', 1]]);
  assert.equal(one.changes[0].first, '2026-11-01T00:00:00Z');
  assert.equal(one.changes[0].last, '2026-11-03T00:00:00Z');
  assert.equal(a.lessons[0].id, 'l1', 'a lesson with a content edit leads');
  const added = a.lessons.find((l) => l.id === 'new');
  assert.deepEqual([added.inTree, added.existsUpstream, added.title], [false, true, 'New']);
  assert.equal(a.lessons.find((l) => l.id === 's1').type, 'SECTION');
  assert.equal(b.id, 'cB');
  assert.deepEqual(b.changes.map((c) => c.label), ['short_description']);

  const gone = report.courses.find((c) => c.id === 'gone');
  assert.deepEqual([gone.inTree, gone.existsUpstream, gone.title, gone.lessons.length], [false, false, 'Gone course', 1]);
  assert.deepEqual(report.deleted.map((d) => [d.id, d.title]), [['dead', 'Dead lesson']]);
  assert.deepEqual(report.totals, { events: 9, content: 3, structure: 3, settings: 3, courses: 2 });
  assert.equal(report.unattributed, 0);
});

test('--course keeps only that course and counts what could not be placed', () => {
  const { report } = sampleReport({ courseIds: new Set(['cB']) });
  assert.deepEqual(report.courses.map((c) => c.id), ['cB']);
  assert.deepEqual(report.deleted, []);
  assert.equal(report.totals.events, 1);
  assert.equal(report.unattributed, 1);
});

test('no events is no drift', () => {
  const { local } = sampleReport();
  const report = buildDriftReport({ events: [], local });
  assert.deepEqual(report.totals, { events: 0, content: 0, structure: 0, settings: 0, courses: 0 });
});

test('actors are printed only on request and never survive withoutActors', () => {
  const { report } = sampleReport({ actors: true });
  assert.ok(!formatDriftReport(report).join('\n').includes('someone@example.com'));
  assert.ok(formatDriftReport(report, { showActors: true }).join('\n').includes('someone@example.com'));
  assert.ok(!JSON.stringify(withoutActors(report)).includes('someone@example.com'));
});

test('the text report names deleted and never-pulled objects for what they are', () => {
  const { report } = sampleReport();
  const text = formatDriftReport(report).join('\n');
  assert.match(text, /course "Gone course" \(gone\) was deleted upstream, 1 of its lessons still read back/);
  assert.match(text, /lesson "Dead lesson" \(dead\) no longer exists upstream/);
  assert.match(text, /New \(not in the local tree\)/);
});
