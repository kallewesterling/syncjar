import test from 'node:test';
import assert from 'node:assert/strict';

import { mapWithConcurrency } from '../scripts/concurrency.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('results keep input order, not completion order', async () => {
  // Earlier items finish later, so anything that collected results as they
  // resolved would come out reversed.
  const results = await mapWithConcurrency([30, 20, 10], 3, async (ms) => {
    await new Promise(resolve => setTimeout(resolve, ms));
    return ms;
  });
  assert.deepEqual(results, [30, 20, 10]);
});

test('never exceeds the limit, and does use all of it', async () => {
  let inFlight = 0;
  let peak = 0;

  await mapWithConcurrency([...Array(20).keys()], 4, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await tick();
    inFlight--;
    return n;
  });

  assert.equal(peak, 4);
  assert.equal(inFlight, 0);
});

test('a limit above the item count spawns no idle workers', async () => {
  let peak = 0;
  let inFlight = 0;
  await mapWithConcurrency([1, 2], 50, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await tick();
    inFlight--;
    return n;
  });
  assert.equal(peak, 2);
});

test('an empty list resolves to an empty list without calling fn', async () => {
  let calls = 0;
  const results = await mapWithConcurrency([], 4, async () => { calls++; });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test('fn receives the index alongside the item', async () => {
  const seen = await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, i) => `${i}:${item}`);
  assert.deepEqual(seen, ['0:a', '1:b', '2:c']);
});

// Callers write to disk or to a live LMS from these results. A rejection that
// resolved to a partial set would be indistinguishable from a complete one.
test('a rejection propagates rather than yielding a partial set', async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/
  );
});
