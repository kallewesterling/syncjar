import test from 'node:test';
import assert from 'node:assert/strict';

import { summariseField, PUBLISHED_COURSE_FIELDS } from '#lib/check/settings.mjs';

const field = { name: 'tz', get: (r) => r.tz };
const label = (r) => r.name;
const rows = (spec) => Object.entries(spec).flatMap(([value, n]) =>
  Array.from({ length: n }, (_, i) => ({ name: `${value}-${i}`, tz: JSON.parse(value) })));

test('one value everywhere is uniform', () => {
  const s = summariseField(rows({ '"LA"': 5 }), field, label);
  assert.equal(s.status, 'uniform');
  assert.equal(s.majority, 'LA');
});

test('a value covering the threshold makes the rest outliers', () => {
  const s = summariseField(rows({ '"LA"': 66, null: 1 }), field, label);
  assert.equal(s.status, 'outliers');
  assert.equal(s.majority, 'LA');
  assert.deepEqual(s.outliers, [{ label: 'null-0', value: null }]);
});

// The point of reading the norm from the data: a genuinely split setting
// such as `hidden` must not be reported as 7 mistakes.
test('a split below the threshold varies and flags nothing', () => {
  const s = summariseField(rows({ false: 60, true: 7 }), field, label);
  assert.equal(s.status, 'varies');
  assert.deepEqual(s.outliers, []);
  assert.deepEqual(s.counts, [[false, 60], [true, 7]]);
});

test('the threshold is adjustable', () => {
  assert.equal(summariseField(rows({ false: 60, true: 7 }), field, label, 0.85).status, 'outliers');
});

test('a tie is never an outlier report', () => {
  assert.equal(summariseField(rows({ false: 1, true: 1 }), field, label, 0.5).status, 'varies');
});

test('a missing value counts as null rather than crashing', () => {
  const s = summariseField([{ name: 'a' }, { name: 'b', tz: null }], field, label);
  assert.equal(s.status, 'uniform');
  assert.equal(s.majority, null);
});

test('registration dates and the offer are compared as set/unset and readable values', () => {
  const get = (name) => PUBLISHED_COURSE_FIELDS.find(f => f.name === name).get;
  assert.equal(get('registration_starts_at (set)')({ registration_starts_at: '2030-01-01T00:00:00Z' }), true);
  assert.equal(get('registration_starts_at (set)')({ registration_starts_at: null }), false);
  assert.equal(get('offer.price')({ offer: { price: { amount: '0.00', currency_code: 'USD' } } }), '0.00 USD');
  assert.equal(get('offer.registration_open')({}), null);
});
