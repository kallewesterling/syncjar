import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENROLL_WRITES_ENV,
  choosePublishedCourse,
  deactivateBody,
  domainMembership,
  enrollBody,
  enrollmentState,
  finalResult,
  parseExpiresAt,
  planEnrollments,
  readBackMismatch,
  readBatchResult,
  resolveCourse,
  writesUnlocked
} from '#lib/enrollments/enroll-plan.mjs';
import { runEnroll } from '#lib/enrollments/enroll-run.mjs';

const NOW = Date.parse('2026-11-06T12:00:00Z');

test('the write path stays locked unless the env variable is exactly 1', () => {
  assert.equal(writesUnlocked({}), false);
  assert.equal(writesUnlocked({ [ENROLL_WRITES_ENV]: 'true' }), false);
  assert.equal(writesUnlocked({ [ENROLL_WRITES_ENV]: '1' }), true);
});

test('--expires-at must be a date in the future', () => {
  assert.deepEqual(parseExpiresAt('2027-01-31', NOW), { iso: '2027-01-31T00:00:00.000Z' });
  assert.match(parseExpiresAt('2026-01-01', NOW).error, /not in the future/);
  assert.match(parseExpiresAt('soon', NOW).error, /not a date/);
});

const course = (id, title) => ({ id, attributes: { title } });

test('a course is found by id or exact title, and an ambiguous title is refused', () => {
  const courses = [course('c1', 'Intro'), course('c2', 'Intro to Images'), course('c3', 'Dup'), course('c4', 'dup')];
  assert.equal(resolveCourse(courses, 'c2').course.id, 'c2');
  assert.equal(resolveCourse(courses, ' intro ').course.id, 'c1');
  assert.match(resolveCourse(courses, 'Dup').error, /2 courses are titled "Dup"\. .*c3, c4/);
  assert.match(resolveCourse(courses, 'Images').error, /No course .*"Intro to Images" \(c2\)/);
});

const pc = (id, domainId, extra = {}) => ({ id, attributes: { live: true, ...extra }, relationships: { course: { data: { id: 'c1' } }, domain: { data: { id: domainId } } } });
const domains = new Map([['d1', 'courses.example.com'], ['d2', 'staging.example.com']]);

test('a course on several domains needs --domain; on one, it is used', () => {
  assert.equal(choosePublishedCourse([pc('p1', 'd1')], domains).publishedCourse.id, 'p1');
  assert.match(choosePublishedCourse([pc('p1', 'd1'), pc('p2', 'd2')], domains).error, /published on 2 domains \(courses\.example\.com, staging\.example\.com\)\. Pass --domain/);
  const chosen = choosePublishedCourse([pc('p1', 'd1'), pc('p2', 'd2')], domains, 'STAGING.example.com');
  assert.deepEqual([chosen.publishedCourse.id, chosen.domain], ['p2', { id: 'd2', name: 'staging.example.com' }]);
  assert.match(choosePublishedCourse([pc('p1', 'd1')], domains, 'staging.example.com').error, /not published on staging\.example\.com/);
  assert.match(choosePublishedCourse([], domains).error, /not published on any domain/);
});

const row = (id, { pcId = 'p1', studentId = 's1', active = true, expiresAt = null, enrolledAt = '2026-01-01T00:00:00Z', progress = 'in_progress' } = {}) => ({
  id,
  attributes: { active, expires_at: expiresAt, enrolled_at: enrolledAt, progress_status: progress },
  relationships: { student: { data: { id: studentId } }, 'published-course': { data: { id: pcId } } }
});
const at = { studentId: 's1', publishedCourseId: 'p1', now: NOW };

test('an enrollment is read for this published course and student only', () => {
  assert.equal(enrollmentState([], at).state, 'not_enrolled');
  assert.equal(enrollmentState([row('e1', { pcId: 'p2' }), row('e2', { studentId: 's9' })], at).state, 'not_enrolled');
  const active = enrollmentState([row('e0', { active: false }), row('e1')], at);
  assert.deepEqual([active.state, active.enrollmentId, active.activeIds, active.progress], ['active', 'e1', ['e1'], 'in_progress']);
  assert.equal(enrollmentState([row('e1', { active: false })], at).state, 'deactivated');
  assert.equal(enrollmentState([row('e1', { active: false, expiresAt: '2026-06-01T00:00:00Z' })], at).state, 'expired');
});

test('domain membership must be active and on the target domain', () => {
  const m = (domainId, active) => ({ attributes: { active }, relationships: { domain: { data: { id: domainId } } } });
  assert.equal(domainMembership([m('d1', true)], 'd1'), 'member');
  assert.equal(domainMembership([m('d1', false)], 'd1'), 'inactive_member');
  assert.equal(domainMembership([m('d2', true)], 'd1'), 'not_member');
});

const student = (email, state, extra = {}) => ({
  email, id: `id-${email}`, name: '', inactive: false, domain: 'member',
  enrollment: { state, activeIds: state === 'active' ? ['e'] : [], enrollmentId: state === 'not_enrolled' ? undefined : 'e' },
  ...extra
});

test('an add sends only students with no enrollment, unless --reactivate', () => {
  const students = [
    student('new@x.com', 'not_enrolled'),
    student('on@x.com', 'active'),
    student('off@x.com', 'deactivated'),
    student('old@x.com', 'expired'),
    student('acct@x.com', 'not_enrolled', { inactive: true }),
    student('away@x.com', 'not_enrolled', { domain: 'not_member' })
  ];
  const plain = planEnrollments('add', students);
  assert.deepEqual(plain.send.map((s) => [s.email, s.intent]), [['new@x.com', 'enroll']]);
  assert.deepEqual(plain.skipped.map((s) => s.result), [
    'skipped_already_enrolled', 'skipped_deactivated', 'skipped_expired', 'skipped_inactive_account', 'skipped_domain_not_member'
  ]);
  const re = planEnrollments('add', students, { reactivate: true });
  assert.deepEqual(re.send.map((s) => s.intent), ['enroll', 'reactivate', 'reactivate']);
});

test('a remove sends only students with exactly one active enrollment', () => {
  const two = student('two@x.com', 'active');
  two.enrollment.activeIds = ['e1', 'e2'];
  const { send, skipped } = planEnrollments('remove', [student('on@x.com', 'active'), student('none@x.com', 'not_enrolled'), student('off@x.com', 'expired'), two]);
  assert.deepEqual(send.map((s) => [s.email, s.intent]), [['on@x.com', 'deactivate']]);
  assert.deepEqual(skipped.map((s) => s.result), ['skipped_not_enrolled', 'skipped_already_inactive', 'skipped_several_active_enrollments']);
});

test('request bodies follow the spec', () => {
  assert.deepEqual(enrollBody('p1', ['a@x.com'], null), { published_course_id: 'p1', data: [{ type: 'enrollments', attributes: { email: 'a@x.com' } }] });
  assert.equal(enrollBody('p1', ['a@x.com'], '2027-01-31T00:00:00.000Z').expires_at, '2027-01-31T00:00:00.000Z');
  assert.deepEqual(deactivateBody(['e1']), { data: [{ type: 'enrollments', id: 'e1', attributes: { active: false } }] });
});

test('batch items are matched by position, pointer or id, and a missing one is a failure', () => {
  const sent = [student('a@x.com', 'not_enrolled'), student('b@x.com', 'not_enrolled'), student('c@x.com', 'not_enrolled')];
  const body = {
    data: [
      { status: 'failed', id: null, error: { code: 'already_enrolled', source: { pointer: '/data/1/attributes/email' } } },
      { status: 'succeeded', id: 'e-a', result: { id: 'e-a', relationships: { student: { data: { id: 'id-a@x.com' } } } } }
    ]
  };
  assert.deepEqual(readBatchResult('add', sent, body).map((r) => [r.email, r.response, r.enrollment_id]), [
    ['a@x.com', 'succeeded', 'e-a'],
    ['b@x.com', 'already_enrolled', ''],
    ['c@x.com', 'missing', '']
  ]);
  const removed = readBatchResult('remove', [student('a@x.com', 'active')], { data: [{ status: 'failed', id: 'e', error: { code: 'not_found', detail: 'gone' } }] });
  assert.deepEqual([removed[0].response, removed[0].error], ['failed', 'not_found: gone']);
});

test('only a read-back that matches the intent counts as done', () => {
  const after = (state, extra = {}) => ({ state, activeIds: state === 'active' ? ['e'] : [], rows: [], expiresAt: '', ...extra });
  const s = student('a@x.com', 'active');
  assert.equal(readBackMismatch('add', s, after('active')), null);
  assert.match(readBackMismatch('add', s, after('not_enrolled')), /expected active/);
  assert.match(readBackMismatch('add', s, after('active', { expiresAt: null }), { expiresAt: '2027-01-31T00:00:00.000Z' }), /expires_at none/);
  assert.equal(readBackMismatch('add', s, after('active', { expiresAt: '2027-01-31T00:00:00Z' }), { expiresAt: '2027-01-31T00:00:00.000Z' }), null);
  assert.equal(readBackMismatch('remove', s, after('deactivated', { rows: [{ id: 'e', attributes: { active: false } }] })), null);
  assert.match(readBackMismatch('remove', s, after('active', { rows: [{ id: 'e', attributes: { active: true } }] })), /still active/);

  assert.equal(finalResult('add', 'enroll', 'succeeded', null), 'enrolled');
  assert.equal(finalResult('add', 'reactivate', 'succeeded', null), 'reactivated');
  assert.equal(finalResult('add', 'enroll', 'succeeded', 'read back as not_enrolled'), 'failed');
  assert.equal(finalResult('add', 'enroll', 'failed', null), 'failed_but_landed');
  assert.equal(finalResult('remove', 'deactivate', 'succeeded', null, 'HTTP 500'), 'unverified');
});

/**
 * A v2 client stand-in backed by a store of enrollments, so a write changes
 * what the read-back sees. `land: false` answers writes with success but
 * changes nothing.
 */
function fakeClient({ students, enrollments = [], memberships = {}, publishedCourses = [pc('p1', 'd1')], land = true, onWrite }) {
  const calls = [];
  const store = enrollments.map((e) => structuredClone(e));
  const byEmail = new Map(Object.entries(students));
  let next = 1;
  return {
    calls,
    store,
    async get(url, { params = {} } = {}) {
      calls.push(['GET', url, params]);
      if (url === '/courses/') return { data: { data: [course('c1', 'Intro'), course('c2', 'Other')], links: {} } };
      if (url === '/domains/') return { data: { data: [...domains].map(([id, name]) => ({ id, attributes: { name } })), links: {} } };
      if (url === '/published-courses/') return { data: { data: publishedCourses.filter((p) => p.relationships.course.data.id === params['filter[course]']), links: {} } };
      if (url === '/students/') {
        const s = byEmail.get(params['filter[email]']);
        return { data: { data: s ? [s] : [] } };
      }
      if (url === '/enrollments/') {
        const s = byEmail.get(params['filter[student.email]']);
        assert.equal(params['filter[course.id]'], 'c1');
        return { data: { data: s ? store.filter((e) => e.relationships.student.data.id === s.id) : [], links: {} } };
      }
      const m = url.match(/^\/students\/(.+)\/relationships\/domain-memberships\/$/);
      if (m) return { data: { data: memberships[m[1]] ?? [{ attributes: { active: true }, relationships: { domain: { data: { id: 'd1' } } } }], links: {} } };
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body) {
      calls.push(['POST', url, body]);
      if (onWrite) return onWrite('post', body);
      const data = body.data.map(({ attributes: { email } }) => {
        const s = byEmail.get(email);
        const id = `e${next++}`;
        if (land) store.push(row(id, { pcId: body.published_course_id, studentId: s.id, expiresAt: body.expires_at ?? null }));
        return { status: 'succeeded', id, result: { id, attributes: { active: true }, relationships: { student: { data: { id: s.id } } } } };
      });
      return { status: 200, data: { data } };
    },
    async patch(url, body) {
      calls.push(['PATCH', url, body]);
      if (onWrite) return onWrite('patch', body);
      const data = body.data.map(({ id, attributes }) => {
        const e = store.find((x) => x.id === id);
        if (land) e.attributes.active = attributes.active;
        return { status: 'succeeded', id, result: { id, attributes: { active: attributes.active } } };
      });
      return { status: 200, data: { data } };
    }
  };
}

const studentsFor = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [
  `p${i}@example.com`, { id: `s${i}`, attributes: { first_name: 'P', last_name: String(i), is_inactive: false } }
]));

function harness({ argv, answer, env = { [ENROLL_WRITES_ENV]: '1' }, ...client }) {
  const fake = fakeClient(client);
  const lines = [];
  const written = {};
  const prompts = [];
  const deps = {
    client: fake,
    env,
    log: (l) => lines.push(l),
    prompt: async (q) => { prompts.push(q); return answer; },
    readFile: async () => { throw new Error('no file'); },
    writeFile: async (p, text) => { written[p] = text; },
    now: () => NOW
  };
  const args = { course: 'c1', email: [], confirm: false, auditDir: '/audit', ...argv };
  return { run: (action) => runEnroll(action, args, deps), client: fake, lines, written, prompts, out: () => lines.join('\n') };
}

const writes = (client) => client.calls.filter(([m]) => m !== 'GET');

test('--confirm without the env variable refuses before making any request', async () => {
  const h = harness({ argv: { email: ['p0@example.com'], confirm: true }, students: studentsFor(1), env: {} });
  assert.equal(await h.run('add'), 1);
  assert.deepEqual(h.client.calls, []);
  assert.match(h.out(), /locked: its write path has not yet been verified/);
});

test('a dry run reads everything, skips unknown emails, and writes nothing', async () => {
  const h = harness({ argv: { course: 'intro', email: ['P0@example.com', 'p1@example.com', 'nobody@example.com'] }, students: studentsFor(2), enrollments: [row('e9', { studentId: 's1' })], env: {} });
  assert.equal(await h.run('add'), 0);
  assert.deepEqual(writes(h.client), []);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.written, {});
  const out = h.out();
  assert.match(out, /ENROLL {2}1 students in "Intro" on courses\.example\.com/);
  assert.match(out, /1 emails have no Skilljar account and are skipped \(nobody is created\): nobody@example\.com/);
  assert.match(out, /1 students are already enrolled \(active\): p1@example\.com/);
  assert.match(out, /enroll {5}p0@example\.com/);
  assert.match(out, /DRY RUN/);
});

test('a course on two domains is refused without --domain, before any student is read', async () => {
  const h = harness({ argv: { email: ['p0@example.com'] }, students: studentsFor(1), publishedCourses: [pc('p1', 'd1'), pc('p2', 'd2')] });
  assert.equal(await h.run('add'), 1);
  assert.match(h.out(), /Pass --domain/);
  assert.ok(!h.client.calls.some(([, url]) => url === '/students/'));
});

test('an unknown --domain is refused', async () => {
  const h = harness({ argv: { email: ['p0@example.com'], domain: 'nope.example.com' }, students: studentsFor(1) });
  assert.equal(await h.run('add'), 1);
  assert.match(h.out(), /Not a Skilljar domain: nope\.example\.com/);
});

test('an add to an unpublished course is refused', async () => {
  const h = harness({ argv: { email: ['p0@example.com'] }, students: studentsFor(1), publishedCourses: [pc('p1', 'd1', { live: false })] });
  assert.equal(await h.run('add'), 1);
  assert.match(h.out(), /unpublished on courses\.example\.com/);
});

test('a confirmation that does not match aborts before any write', async () => {
  const h = harness({ argv: { email: ['p0@example.com'], confirm: true }, students: studentsFor(1), answer: 'enroll 2' });
  assert.equal(await h.run('add'), 1);
  assert.deepEqual(h.prompts, ['Type "enroll 1" to proceed: ']);
  assert.deepEqual(writes(h.client), []);
  assert.deepEqual(h.written, {});
});

test('a confirmed add sends batches of 100, reads every enrollment back, and audits every email', async () => {
  const students = studentsFor(150);
  const h = harness({ argv: { email: [...Object.keys(students), 'ghost@example.com'], confirm: true, expiresAt: '2027-01-31' }, students, answer: 'enroll 150' });
  assert.equal(await h.run('add'), 0);

  assert.deepEqual(writes(h.client).map(([m, url, body]) => [m, url, body.published_course_id, body.expires_at, body.data.length]), [
    ['POST', '/enrollments/', 'p1', '2027-01-31T00:00:00.000Z', 100],
    ['POST', '/enrollments/', 'p1', '2027-01-31T00:00:00.000Z', 50]
  ]);
  assert.ok(!h.client.calls.some(([, url]) => url.includes('completion')));
  const [[auditPath, csv]] = Object.entries(h.written);
  assert.match(auditPath, /^\/audit\/enroll-add-audit-2026-11-06T12-00-00-000Z\.csv$/);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 1 + 151);
  assert.match(lines[0], /^"email","student_id","name","course_id","course_title","published_course_id","domain","action","enrollment_id","before"/);
  assert.match(csv, /"p0@example.com","s0","P 0","c1","Intro","p1","courses.example.com","add","e1","not_enrolled","","","active","2027-01-31T00:00:00.000Z","succeeded","enrolled",""/);
  assert.match(csv, /"ghost@example.com",,,"c1","Intro","p1","courses.example.com","add",,,,,,,,"skipped_no_account"/);
  assert.match(h.out(), /150 enrolled/);
  assert.match(h.out(), /It holds names and email addresses/);
});

test('a 200 that did not land is a failure, found by the read-back', async () => {
  const h = harness({ argv: { email: ['p0@example.com'], confirm: true }, students: studentsFor(1), answer: 'enroll 1', land: false });
  assert.equal(await h.run('add'), 1);
  const csv = Object.values(h.written)[0];
  assert.match(csv, /"not_enrolled","","","not_enrolled","","succeeded","failed","read back as not_enrolled, expected active"/);
});

test('a batch that fails as a whole stops the run; the rest are not attempted, and the failed one is still read back', async () => {
  const students = studentsFor(150);
  const onWrite = () => { throw Object.assign(new Error('500'), { response: { status: 500, data: { errors: [{ detail: 'boom' }] } } }); };
  const h = harness({ argv: { email: Object.keys(students), confirm: true }, students, answer: 'enroll 150', onWrite });
  assert.equal(await h.run('add'), 1);
  assert.equal(writes(h.client).length, 1);
  const csv = Object.values(h.written)[0];
  assert.equal((csv.match(/"request_failed","failed"/g) ?? []).length, 100);
  assert.equal((csv.match(/"not_attempted","not_attempted"/g) ?? []).length, 50);
  assert.match(h.out(), /Stopped after a batch failed: HTTP 500 — boom/);
});

test('a confirmed remove deactivates the active enrollment by id and reads it back', async () => {
  const enrollments = [row('e1', { studentId: 's0', progress: 'completed' }), row('e2', { studentId: 's1', active: false })];
  const h = harness({ argv: { email: ['p0@example.com', 'p1@example.com', 'p2@example.com'], confirm: true }, students: studentsFor(3), enrollments, answer: 'unenroll 1' });
  assert.equal(await h.run('remove'), 0);
  assert.deepEqual(writes(h.client), [['PATCH', '/enrollments/', { data: [{ type: 'enrollments', id: 'e1', attributes: { active: false } }] }]]);
  assert.ok(!h.client.calls.some(([, url]) => url.includes('domain-memberships')));
  const csv = Object.values(h.written)[0];
  assert.match(csv, /"p0@example.com","s0","P 0",.*"remove","e1","active","completed","","deactivated","","succeeded","deactivated",""/);
  assert.match(csv, /"p1@example.com",.*"skipped_already_inactive"/);
  assert.match(csv, /"p2@example.com",.*"skipped_not_enrolled"/);
});

test('an enrollment read that ignores its filters is refused rather than walked', async () => {
  const h = harness({ argv: { email: ['p0@example.com'] }, students: studentsFor(1) });
  const get = h.client.get;
  h.client.get = async (url, opts) => {
    const res = await get(url, opts);
    if (url === '/enrollments/') res.data.links = { next: 'https://api.skilljar.com/v2/enrollments/?page[cursor]=x' };
    return res;
  };
  assert.equal(await h.run('remove'), 1);
  assert.match(h.out(), /Could not read the students' enrollments: .*filters were not applied/);
});
