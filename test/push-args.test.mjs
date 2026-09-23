import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePushArgs, resolveFullScan, DEFAULT_CONCURRENCY } from '../scripts/push-args.mjs';

// --- the bug this module exists for ---------------------------------------

// `--no-skip` was declared as an option named `no-skip`, but yargs reserves a
// leading `--no-` for boolean negation: the flag landed on `argv.skip` and
// `argv['no-skip']` stayed at its default, so the documented way to force a
// real comparison silently did nothing.
test('--full-scan forces a full scan', () => {
  assert.equal(parsePushArgs(['--full-scan']).fullScan, true);
});

test('--no-skip still forces a full scan, wherever yargs puts it', () => {
  assert.equal(parsePushArgs(['--no-skip']).fullScan, true);
});

test('neither flag means skipping stays enabled', () => {
  assert.equal(parsePushArgs([]).fullScan, false);
  assert.equal(parsePushArgs(['--dry-run']).fullScan, false);
});

// `skip` is undefined when the flag is absent, and `!undefined` is true — so
// a `!argv.skip` test would force a full scan on every run and quietly undo
// the whole feature.
test('an absent skip flag is not mistaken for --no-skip', () => {
  assert.equal(resolveFullScan({}), false);
  assert.equal(resolveFullScan({ skip: undefined }), false);
  assert.equal(resolveFullScan({ skip: false }), true);
  assert.equal(resolveFullScan({ 'full-scan': false }), false);
});

// --- the negation that must keep working ----------------------------------

// The tempting fix for the above is to turn boolean negation off. It is not
// available: --no-diff is documented and works *because* of negation, since
// `diff` defaults to true. This pins that so the fix cannot be "simplified"
// into breaking it.
test('--no-diff still turns diffs off', () => {
  assert.equal(parsePushArgs([]).diff, true);
  assert.equal(parsePushArgs(['--no-diff']).diff, false);
});

// --- the rest of the surface ----------------------------------------------

test('defaults are what the script expects', () => {
  const argv = parsePushArgs([]);
  assert.equal(argv.concurrency, DEFAULT_CONCURRENCY);
  assert.equal(argv['diff-style'], 'auto');
  assert.equal(argv['add-last-updated'], false);
  assert.deepEqual(argv['allow-branch'], []);
  assert.ok(argv['state-file']);
});

test('course, lesson and state-file take values', () => {
  const argv = parsePushArgs(['--course', 'Crush-Your-CVEs', '--lesson', '10-x', '--state-file', '/tmp/s.json']);
  assert.equal(argv.course, 'Crush-Your-CVEs');
  assert.equal(argv.lesson, '10-x');
  assert.equal(argv['state-file'], '/tmp/s.json');
});

test('diff-style only accepts the layouts that exist', () => {
  assert.equal(parsePushArgs(['--diff-style', 'stacked'])['diff-style'], 'stacked');
  assert.equal(parsePushArgs(['--diff-style', 'side-by-side'])['diff-style'], 'side-by-side');
});

test('--allow-branch is repeatable', () => {
  assert.deepEqual(
    parsePushArgs(['--allow-branch', 'a', '--allow-branch', 'b'])['allow-branch'],
    ['a', 'b']
  );
});

test('force and force-titles stay independent', () => {
  const argv = parsePushArgs(['--force']);
  assert.equal(argv.force, true);
  assert.notEqual(argv['force-titles'], true);
});
