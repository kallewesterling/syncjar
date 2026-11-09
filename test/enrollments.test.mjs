import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENROLLMENT_FIELDS, FEEDBACK_FIELDS, canCrossCheck, courseByPublishedCourse, crossCheck, emailDomainOf,
  enrollmentQueries, enrollmentRows, filterByEmailDomain, listAllWithIncluded, matchCourses,
  normaliseEmailDomain, parseSince, sortRows, summarise
} from '#lib/enrollments/enrollments.mjs';

const course = (id, title) => ({ id, attributes: { title } });
const pc = (id, courseId) => ({ id, relationships: { course: { data: { type: 'courses', id: courseId } } } });
const student = (id, email) => ({ type: 'students', id, attributes: { email, first_name: 'F', last_name: 'L' } });
const enrollment = (id, studentId, pcId, attributes = {}) => ({
  id,
  attributes: { enrolled_at: '2026-01-01T00:00:00Z', progress_status: 'in_progress', has_certificate: false, domain_name: 'courses.example.com', feedback: 'free text', rating: 4, ...attributes },
  relationships: { student: { data: { type: 'students', id: studentId } }, 'published-course': { data: { type: 'published-courses', id: pcId } } }
});

test('--course matches an id or part of a title, case-insensitively, and reports misses', () => {
  const courses = [course('abc123', 'Intro to Containers'), course('def456', 'Securing the Supply Chain'), course('ghi789', 'Containers in Depth')];
  const { courses: hits, unmatched } = matchCourses(['containers', 'DEF456', 'nothing'], courses);
  assert.deepEqual(hits.map((c) => c.id), ['abc123', 'ghi789', 'def456']);
  assert.deepEqual(unmatched, ['nothing']);
  assert.deepEqual(matchCourses([' '], courses).unmatched, [' ']);
});

test('email domains normalise, and match exactly rather than by suffix', () => {
  assert.equal(normaliseEmailDomain('@Example.COM '), 'example.com');
  assert.equal(normaliseEmailDomain('example'), null);
  assert.equal(normaliseEmailDomain('a@example.com'), null);
  assert.equal(emailDomainOf('X@Example.com'), 'example.com');
  assert.equal(emailDomainOf('nope'), '');
  const rows = ['a@example.com', 'b@EXAMPLE.com', 'c@eu.example.com', 'd@notexample.com', 'e@other.com'].map((student_email) => ({ student_email }));
  assert.deepEqual(filterByEmailDomain(rows, ['example.com']).map((r) => r.student_email), ['a@example.com', 'b@EXAMPLE.com']);
  assert.equal(filterByEmailDomain(rows, []).length, 5);
});

test('--since becomes a timestamp with an offset, and rejects non-dates', () => {
  assert.equal(parseSince('2026-07-01'), '2026-07-01T00:00:00.000Z');
  assert.equal(parseSince('2026-07-01T12:30:00'), '2026-07-01T12:30:00.000Z');
  assert.equal(parseSince('2026-07-01T12:30:00+02:00'), '2026-07-01T10:30:00.000Z');
  assert.throws(() => parseSince('last week'), /not a date/);
  assert.throws(() => parseSince('2026-13-45'), /not a date/);
});

test('one read per course and per email, with the shared filters on each', () => {
  assert.deepEqual(enrollmentQueries({}), [{ include: 'student' }]);
  const qs = enrollmentQueries({ courseIds: ['c1', 'c2'], emails: ['A@x.com', 'a@x.com', 'b@x.com'], domains: ['d1', 'd2'], completedOnly: true, since: '2026-07-01T00:00:00.000Z' });
  assert.equal(qs.length, 4);
  assert.deepEqual(qs[0], {
    include: 'student', 'filter[domains]': 'd1,d2', 'filter[progress_status]': 'completed',
    'filter[enrolled_gte]': '2026-07-01T00:00:00.000Z', 'filter[course.id]': 'c1', 'filter[student.email]': 'a@x.com'
  });
  assert.deepEqual(qs.map((q) => `${q['filter[course.id]']} ${q['filter[student.email]']}`), ['c1 a@x.com', 'c1 b@x.com', 'c2 a@x.com', 'c2 b@x.com']);
});

test('rows join to deduplicated students and map published courses to courses', () => {
  const byPc = courseByPublishedCourse([pc('p1', 'c1'), pc('p2', 'c1'), pc('p3', 'c2')], [course('c1', 'A'), course('c2', 'B')]);
  assert.deepEqual(byPc.get('p2'), { id: 'c1', title: 'A' });
  const records = [enrollment('e1', 's1', 'p1'), enrollment('e2', 's1', 'p3', { progress_status: 'completed', has_certificate: true }), enrollment('e1', 's1', 'p1'), enrollment('e3', 's2', 'p9')];
  const { rows, unknownPublishedCourses } = enrollmentRows(records, [student('s1', 'a@x.com'), student('s2', 'b@x.com'), { type: 'purchases', id: 's1' }], byPc);
  assert.deepEqual(rows.map((r) => [r.enrollment_id, r.course_id, r.course_title, r.student_email]), [['e1', 'c1', 'A', 'a@x.com'], ['e2', 'c2', 'B', 'a@x.com'], ['e3', '', '', 'b@x.com']]);
  assert.deepEqual(unknownPublishedCourses, ['p9']);
  assert.deepEqual(Object.keys(rows[0]), ENROLLMENT_FIELDS);
  assert.equal(rows[0].skilljar_domain, 'courses.example.com');
});

test('feedback is left out unless asked for', () => {
  const byPc = courseByPublishedCourse([pc('p1', 'c1')], [course('c1', 'A')]);
  const [plain] = enrollmentRows([enrollment('e1', 's1', 'p1')], [student('s1', 'a@x.com')], byPc).rows;
  assert.ok(!('feedback' in plain) && !('rating' in plain));
  const [withFeedback] = enrollmentRows([enrollment('e1', 's1', 'p1')], [student('s1', 'a@x.com')], byPc, { includeFeedback: true }).rows;
  assert.deepEqual(Object.keys(withFeedback), [...ENROLLMENT_FIELDS, ...FEEDBACK_FIELDS]);
  assert.equal(withFeedback.feedback, 'free text');
});

test('an enrollment without its included student stops the export', () => {
  assert.throws(() => enrollmentRows([enrollment('e1', 's1', 'p1')], [], new Map()), /without its student/);
});

test('rows sort by course title, then enrolment time, then email', () => {
  const rows = [
    { course_title: 'B', enrolled_at: '2026-01-01', student_email: 'a' },
    { course_title: 'A', enrolled_at: '2026-02-01', student_email: 'a' },
    { course_title: 'A', enrolled_at: '2026-01-01', student_email: 'b' },
    { course_title: 'A', enrolled_at: '2026-01-01', student_email: 'a' }
  ];
  assert.deepEqual(sortRows(rows).map((r) => `${r.course_title} ${r.enrolled_at} ${r.student_email}`),
    ['A 2026-01-01 a', 'A 2026-01-01 b', 'A 2026-02-01 a', 'B 2026-01-01 a']);
});

test('the cross-check compares counts per course, including courses with no rows', () => {
  const rows = [
    { course_id: 'c1', course_title: 'A', progress_status: 'completed', has_certificate: true },
    { course_id: 'c1', course_title: 'A', progress_status: 'in_progress', has_certificate: false },
    { course_id: 'c2', course_title: 'B', progress_status: 'completed', has_certificate: false }
  ];
  const summary = summarise(rows);
  assert.deepEqual(summary.get('c1'), { title: 'A', enrollments: 2, completions: 1, certificates: 1 });
  const analytics = new Map([
    ['c1', { enrollments: 2, completions: 1, certificates_issued: 1 }],
    ['c2', { enrollments: 3, completions: 1, certificates_issued: 0 }],
    ['c3', { enrollments: 0, completions: 0, certificates_issued: 0 }],
    ['c4', { enrollments: 1, completions: 0, certificates_issued: 0 }]
  ]);
  assert.deepEqual(crossCheck(summary, analytics), [
    { course_id: 'c2', diffs: [{ field: 'enrollments', exported: 1, analytics: 3 }] },
    { course_id: 'c4', diffs: [{ field: 'enrollments', exported: 0, analytics: 1 }] }
  ]);
  assert.deepEqual(crossCheck(summary, analytics, { completedOnly: true }), []);
});

test('the cross-check only runs when the export is not narrowed by student or date', () => {
  assert.equal(canCrossCheck({}), true);
  assert.equal(canCrossCheck({ emails: ['a@x.com'] }), false);
  assert.equal(canCrossCheck({ emailDomains: ['x.com'] }), false);
  assert.equal(canCrossCheck({ since: '2026-01-01T00:00:00.000Z' }), false);
});

test('the paginated read keeps every page\'s included records', async () => {
  const pages = [
    { data: [{ id: 'e1' }], included: [{ id: 's1' }], links: { next: 'https://api.skilljar.com/v2/enrollments/?page%5Bcursor%5D=abc' } },
    { data: [{ id: 'e2' }], included: [{ id: 's2' }], links: { next: null } }
  ];
  const calls = [];
  const client = { get: async (url, { params }) => { calls.push({ url, params }); return { data: pages[calls.length - 1] }; } };
  const { data, included } = await listAllWithIncluded(client, '/enrollments/', { include: 'student' });
  assert.deepEqual(data.map((r) => r.id), ['e1', 'e2']);
  assert.deepEqual(included.map((r) => r.id), ['s1', 's2']);
  assert.equal(calls[1].params['page[cursor]'], 'abc');
  assert.equal(calls[0].params['page[size]'], 100);
});
