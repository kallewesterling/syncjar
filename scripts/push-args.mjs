/**
 * push-args.mjs — the command line for `npm run push`.
 *
 * Separate from the script so it can be tested. It is here because of a bug
 * that a test would have caught immediately and a live run did not: the
 * option to force a full scan was declared as `no-skip`, and yargs reserves a
 * leading `--no-` for boolean negation. Passing `--no-skip` therefore set
 * `argv.skip = false` and left `argv['no-skip']` at its default, so the flag
 * silently did nothing — while the summary line went on advising people to
 * pass it.
 *
 * The obvious fix, turning negation off, is not available: `--no-diff` is a
 * documented flag and works precisely *because* of negation, since `diff`
 * defaults to true. So the option is named `--full-scan`, which is outside
 * the reserved namespace and reads better anyway, and `--no-skip` is still
 * honoured by reading where yargs actually put it.
 */
import yargs from 'yargs';
import { DEFAULT_ALLOWED_BRANCHES } from './branch-guard.mjs';
import { DEFAULT_STATE_FILE } from './push-state.mjs';

// Requests in flight during the scan. The client backs off on 429, so this is
// a throughput choice rather than a safety one; 6 sits below the 12 the pull
// already peaks at without complaint, and the scan is read-only besides.
export const DEFAULT_CONCURRENCY = 6;

/**
 * True when the caller asked for every course to be compared against
 * Skilljar, ignoring what was recorded as already in sync.
 *
 * Accepts both spellings. `--full-scan` is the real option. `--no-skip` was
 * the original name and is kept working, but it never arrives as
 * `argv['no-skip']`: yargs reads it as the negation of a `skip` option, so it
 * turns up as `argv.skip === false`. Checking for `false` specifically
 * matters — `skip` is undefined when the flag is absent, and `!undefined` is
 * true, which would force a full scan on every run.
 */
export function resolveFullScan(argv) {
  return argv['full-scan'] === true || argv.skip === false;
}

export function buildPushParser(args) {
  return yargs(args)
    .option('course', { type: 'string', describe: 'Course folder slug to sync' })
    .option('lesson', { type: 'string', describe: 'Lesson slug to sync' })
    .option('dry-run', { type: 'boolean', describe: 'Preview changes without syncing' })
    .option('force', { type: 'boolean', describe: 'Sync content-item changes without prompting' })
    .option('force-titles', { type: 'boolean', describe: 'Sync course/lesson title changes without prompting (separate from --force)' })
    .option('diff-only', { type: 'boolean', describe: 'Only show diffs, do not sync' })
    .option('diff', { type: 'boolean', default: true, describe: 'Show diffs before syncing' })
    .option('diff-style', {
      type: 'string',
      choices: ['auto', 'side-by-side', 'stacked'],
      default: 'auto',
      describe: 'Diff layout. auto uses two columns when the terminal is wide enough'
    })
    .option('concurrency', {
      type: 'number',
      default: DEFAULT_CONCURRENCY,
      describe: 'Read requests in flight during the scan phase'
    })
    .option('full-scan', {
      type: 'boolean',
      default: false,
      describe: 'Compare every course against Skilljar, even ones recorded as unchanged since the last push'
    })
    .option('state-file', {
      type: 'string',
      default: DEFAULT_STATE_FILE,
      describe: 'Where to record which courses were last verified in sync'
    })
    .option('add-last-updated', {
      type: 'boolean',
      default: false,
      describe: 'If set, updates the lesson description_html with today\'s date'
    })
    .option('allow-branch', {
      type: 'array',
      default: [],
      describe: `Also allow pushing from this content-repo branch (repeatable). Allowed by default: ${DEFAULT_ALLOWED_BRANCHES.join(', ')}`
    })
    .help();
}

/**
 * Parses `args` and returns yargs' object with `fullScan` resolved onto it,
 * so no caller has to remember which of the two spellings landed where.
 */
export function parsePushArgs(args) {
  const argv = buildPushParser(args).parseSync();
  argv.fullScan = resolveFullScan(argv);
  return argv;
}
