import test from 'node:test';
import assert from 'node:assert/strict';

import { ALL_DOMAINS, analyticsRow, checkDomains, sortRows, summarise } from '#lib/analytics/course-analytics.mjs';

const course = (id, title) => ({ id, attributes: { title, is_published: true, lesson_count: 4, modified_at: '2026-10-01T00:00:00Z' } });

test('domain names are matched case-insensitively and use Skilljar\'s spelling', () => {
  assert.deepEqual(checkDomains(['Courses.Example.com', 'courses.example.com', 'ix1ljpxex6xd', 'nope.example'], ['courses.example.com', 'test.example.com']), {
    valid: ['courses.example.com'],
    unknown: ['ix1ljpxex6xd', 'nope.example']
  });
});

test('a row rounds the rates and fills absent counts with zero', () => {
  assert.deepEqual(analyticsRow(course('c1', 'A'), ALL_DOMAINS, { enrollments: 3, completions: 1, completion_rate: 1 / 3, average_rating: null, rating_scale: 5 }), {
    course_id: 'c1', title: 'A', domain: ALL_DOMAINS, is_published: true, lesson_count: 4,
    enrollments: 3, completions: 1, completion_rate: 0.3333, certificates_issued: 0,
    average_rating: '', rating_count: 0, rating_scale: 5, course_modified_at: '2026-10-01T00:00:00Z'
  });
});

test('rows sort by title, with the all-domains row first in each course', () => {
  const rows = [['B', 'z.example'], ['A', 'b.example'], ['A', ALL_DOMAINS], ['B', ALL_DOMAINS], ['A', 'a.example']]
    .map(([t, d]) => analyticsRow(course(t, t), d, {}));
  assert.deepEqual(sortRows(rows).map((r) => `${r.title} ${r.domain}`), ['A (all)', 'A a.example', 'A b.example', 'B (all)', 'B z.example']);
});

test('per-domain enrollments that do not add up to the total are reported', () => {
  const rows = [
    analyticsRow(course('c1', 'A'), ALL_DOMAINS, { enrollments: 10 }),
    analyticsRow(course('c1', 'A'), 'a.example', { enrollments: 4 }),
    analyticsRow(course('c1', 'A'), 'b.example', { enrollments: 6 }),
    analyticsRow(course('c2', 'B'), ALL_DOMAINS, { enrollments: 5 }),
    analyticsRow(course('c2', 'B'), 'a.example', { enrollments: 1 }),
    analyticsRow(course('c2', 'B'), 'b.example', { enrollments: 1 })
  ];
  const { totals, mismatches } = summarise(rows, ['a.example', 'b.example']);
  assert.equal(totals.get(ALL_DOMAINS).enrollments, 15);
  assert.equal(totals.get('a.example').enrollments, 5);
  assert.deepEqual(mismatches, [{ course_id: 'c2', title: 'B', all: 5, sum: 2 }]);
  assert.deepEqual(summarise(rows.filter((r) => r.domain === ALL_DOMAINS), []).mismatches, []);
});
