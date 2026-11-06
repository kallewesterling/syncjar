/**
 * syncjar check:drift  (npm run check:drift)
 *
 * Lists the lessons and courses edited in the Skilljar dashboard since the
 * last pull, from the v2 audit log. A push overwrites Skilljar with the local
 * tree, so any content edit listed here is one a push would destroy: pull
 * first. Timestamps cannot answer this (see CLAUDE.md on `modified_at`); the
 * audit log can, because it records dashboard actions and not API writes.
 *
 *   syncjar check:drift                       since the last pull commit
 *   syncjar check:drift --since 2026-10-01    since a date (UTC)
 *   syncjar check:drift --since HEAD~5        since a commit in the content repo
 *   syncjar check:drift --course launchpad    only matching local courses
 *   syncjar check:drift --json                machine-readable, no actors
 *
 * Needs SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET for an API client with
 * audit:read, plus lessons:read and courses:read to place events on objects
 * the local tree does not have.
 *
 * Read-only: GET requests and `git log`, nothing else.
 *
 * Exits 0 when nothing was edited, 2 when something was, 1 on an error.
 */
import 'dotenv/config';
import path from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { workRoot } from '#lib/paths.mjs';
import { failCleanly } from '#lib/skilljar/client.mjs';
import { createSkilljarV2Client, V2_CREDENTIALS_HINT } from '#lib/skilljar/client-v2.mjs';
import { fail, muted, ok, warn } from '#lib/ui.mjs';
import { resolveSince } from '#lib/drift/since.mjs';
import { AUDIT_TARGET_TYPES, fetchAuditEvents, splitWindows } from '#lib/drift/audit-events.mjs';
import { buildDriftReport, matchCourses, readLocalTree, resolveUnknownTargets, unknownTargets, withoutActors } from '#lib/drift/report.mjs';
import { describeSince, formatDriftReport, shortTime } from '#lib/drift/format.mjs';

const EXIT_DRIFT = 2;

const argv = yargs(hideBin(process.argv))
  .scriptName('syncjar check:drift')
  .option('since', { type: 'string', describe: 'A date (YYYY-MM-DD, UTC) or a git ref in the content repo. Default: the last pull commit' })
  .option('course', { type: 'array', string: true, default: [], describe: 'Only courses whose directory, id or title matches; repeatable' })
  .option('json', { type: 'boolean', default: false, describe: 'Print the report as JSON, without actors' })
  .option('show-actors', { type: 'boolean', default: false, describe: 'Name who made each edit. Terminal only' })
  .strict()
  .help()
  .parse();

// Progress goes to stderr so that --json output stays parseable.
const say = (line) => (argv.json ? console.error(line) : console.log(line));
const stop = (message) => {
  console.error(fail(message));
  process.exit(1);
};

if (argv.showActors && (argv.json || !process.stdout.isTTY)) {
  stop('--show-actors prints dashboard usernames, so it only runs in an interactive terminal and never with --json. Leave it off in CI and in anything that is saved.');
}

const contentPath = path.resolve(process.env.COURSE_CONTENT_PATH || path.join(workRoot, 'local-skilljar'));
if (!(await fs.pathExists(contentPath))) stop(`No course content at ${contentPath}. Set COURSE_CONTENT_PATH.`);

const local = await readLocalTree(contentPath);
if (!local.courses.size) stop(`No course directories with a details.json under ${contentPath}.`);

let courseIds = null;
if (argv.course.length) {
  courseIds = new Set();
  for (const query of argv.course) {
    const matched = matchCourses(local.courses, query);
    if (!matched.length) stop(`--course "${query}" matches no local course.`);
    for (const c of matched) courseIds.add(c.id);
  }
}

let sinceInfo;
try {
  sinceInfo = await resolveSince({ since: argv.since, contentPath });
} catch (err) {
  stop(err.message);
}
const until = new Date().toISOString();
if (sinceInfo.since > until) stop(`The since point ${sinceInfo.since} is in the future.`);

let client;
try {
  client = createSkilljarV2Client();
} catch (err) {
  stop(err.message);
}
const v2Fail = (err, context) => failCleanly(err, context, { credentialsHint: V2_CREDENTIALS_HINT });

const windows = splitWindows(sinceInfo.since, until).length;
say(muted(`Reading the audit log: ${AUDIT_TARGET_TYPES.join(', ')} events, ${windows} window(s) of at most 90 days…`));

let events;
try {
  events = await fetchAuditEvents(client, { since: sinceInfo.since, until, keepActors: argv.showActors });
} catch (err) {
  v2Fail(err, 'Could not read the audit log (the API client needs audit:read)');
}

let resolved;
try {
  resolved = await resolveUnknownTargets(client, unknownTargets(events, local));
} catch (err) {
  v2Fail(err, 'Could not look up lessons or courses missing from the local tree (needs lessons:read and courses:read)');
}

const report = buildDriftReport({ events, local, resolved, courseIds });
const drifted = report.totals.events > 0;

if (argv.json) {
  console.log(JSON.stringify({
    since: sinceInfo.since,
    sinceSource: sinceInfo.source,
    sinceCommit: sinceInfo.commit ? { sha: sinceInfo.commit.sha, date: sinceInfo.commit.date, subject: sinceInfo.commit.subject } : null,
    until,
    contentPath,
    courseFilter: courseIds ? [...courseIds] : null,
    ...withoutActors(report)
  }, null, 2));
  process.exit(drifted ? EXIT_DRIFT : 0);
}

console.log(chalk.bold('\nDashboard edits'));
for (const line of describeSince(sinceInfo)) console.log(muted(`  ${line}`));
if (courseIds) console.log(muted(`  limited to ${courseIds.size} course(s) matching --course`));

for (const line of formatDriftReport(report, { showActors: argv.showActors })) console.log(line);

console.log('');
if (report.unattributed) {
  console.log(muted(`${report.unattributed} event(s) on deleted lessons or courses were left out: with --course they cannot be placed in a course.`));
}
if (!drifted) {
  console.log(ok(`No dashboard edits since ${shortTime(sinceInfo.since)} UTC. The local tree has not been overtaken.`));
  process.exit(0);
}

const t = report.totals;
const summary = `${t.events} dashboard edit(s) since ${shortTime(sinceInfo.since)} UTC: ${t.content} content, ${t.structure} structure, ${t.settings} settings, across ${t.courses} local course(s).`;
console.log(warn(chalk.bold(summary)));
if (t.content) {
  console.log(warn('A push would overwrite the content edits above. Pull into a clean working tree first and review the diff: it shows the dashboard edits, and also any local edits not yet pushed, as reverted.'));
} else {
  console.log(muted('No lesson content was edited, but a pull would still bring these changes into the tree.'));
}
if (sinceInfo.source === 'last-sync' && sinceInfo.localAfterSync) {
  console.log(muted('If one of the later commits already recorded these edits, rerun with --since <that commit> to start from it.'));
}
process.exit(EXIT_DRIFT);
