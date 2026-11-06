/**
 * syncjar export:enrollments  (npm run export:enrollments)
 *
 * Exports Skilljar enrollments to CSV through the v2 API, one row per
 * enrollment: course, domain, student, dates, progress, score, certificate
 * and source. Needs SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET for an API
 * client with enrollments:read, published-courses:read and courses:read;
 * domains:read for --domain, and analytics:read for the cross-check
 * (skip it with --no-check). Whether include=student also needs
 * students:read is untested.
 *
 *   syncjar export:enrollments
 *   syncjar export:enrollments --course "intro" --email-domain example.com
 *   syncjar export:enrollments --domain courses.example.com --completed-only --since 2026-07-01
 *
 * The CSV holds names and email addresses, so it goes to public/data/, which
 * is gitignored. Delete it when done; it regenerates in one command.
 *
 * Read-only. Makes GET requests exclusively. Every read happens before the
 * CSV is written, and any failure stops the export rather than writing a
 * partial one.
 */
import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parse } from 'json2csv';
import { workRoot } from '#lib/paths.mjs';
import { mapWithConcurrency } from '#lib/concurrency.mjs';
import { failCleanly } from '#lib/skilljar/client.mjs';
import { createSkilljarV2Client, listAllV2, V2_CREDENTIALS_HINT } from '#lib/skilljar/client-v2.mjs';
import { fail, muted, ok, warn } from '#lib/ui.mjs';
import { checkDomains } from '#lib/analytics/course-analytics.mjs';
import {
  ENROLLMENT_FIELDS, FEEDBACK_FIELDS, canCrossCheck, courseByPublishedCourse, crossCheck,
  enrollmentQueries, enrollmentRows, filterByEmailDomain, listAllWithIncluded, matchCourses,
  normaliseEmailDomain, parseSince, sortRows, summarise
} from '#lib/enrollments/enrollments.mjs';

const CONCURRENCY = 3;

const argv = yargs(hideBin(process.argv))
  .scriptName('syncjar export:enrollments')
  .option('course', { type: 'array', string: true, default: [], describe: 'Only this course: id or part of the title, case-insensitive; repeatable' })
  .option('domain', { type: 'array', string: true, default: [], describe: 'Only enrollments on this Skilljar domain name; repeatable' })
  .option('email-domain', { type: 'array', string: true, default: [], describe: 'Only students whose email is at this domain (exact, not subdomains); repeatable' })
  .option('email', { type: 'array', string: true, default: [], describe: 'Only this student, by email; repeatable' })
  .option('completed-only', { type: 'boolean', default: false, describe: 'Only completed enrollments' })
  .option('since', { type: 'string', describe: 'Only enrollments made on or after this date (YYYY-MM-DD, UTC)' })
  .option('include-feedback', { type: 'boolean', default: false, describe: 'Add rating and the free-text feedback' })
  .option('check', { type: 'boolean', default: true, describe: 'Cross-check counts against the analytics summary (--no-check to skip)' })
  .option('out', { type: 'string', default: path.join(workRoot, 'public', 'data', 'enrollments.csv'), describe: 'Output CSV path' })
  .strict()
  .help()
  .parse();

const emailDomains = [];
for (const raw of argv.emailDomain) {
  const d = normaliseEmailDomain(raw);
  if (!d) {
    console.error(fail(`--email-domain "${raw}" is not a domain, e.g. example.com`));
    process.exit(1);
  }
  if (!emailDomains.includes(d)) emailDomains.push(d);
}
const emails = argv.email.map((e) => String(e).trim()).filter(Boolean);
if (emails.some((e) => !e.includes('@'))) {
  console.error(fail('--email takes a full email address.'));
  process.exit(1);
}
let since = null;
if (argv.since) {
  try {
    since = parseSince(argv.since);
  } catch (err) {
    console.error(fail(err.message));
    process.exit(1);
  }
}

let client;
try {
  client = createSkilljarV2Client();
} catch (err) {
  console.error(fail(err.message));
  process.exit(1);
}
const v2Fail = (err, context) => failCleanly(err, context, { credentialsHint: V2_CREDENTIALS_HINT });

let domains = [];
if (argv.domain.length) {
  let known;
  try {
    known = (await listAllV2(client, '/domains/')).map((d) => d.attributes?.name).filter(Boolean);
  } catch (err) {
    v2Fail(err, 'Could not list domains (needs domains:read)');
  }
  const { valid, unknown } = checkDomains(argv.domain, known);
  if (unknown.length) {
    console.error(fail(`Not a Skilljar domain: ${unknown.join(', ')}. Known: ${known.join(', ')}`));
    process.exit(1);
  }
  domains = valid;
}

let allCourses;
let publishedCourses;
try {
  allCourses = await listAllV2(client, '/courses/');
} catch (err) {
  v2Fail(err, 'Could not list courses (needs courses:read)');
}
try {
  publishedCourses = await listAllV2(client, '/published-courses/');
} catch (err) {
  v2Fail(err, 'Could not list published courses (needs published-courses:read)');
}

let selected = allCourses;
if (argv.course.length) {
  const { courses, unmatched } = matchCourses(argv.course, allCourses);
  if (unmatched.length) {
    console.error(fail(`No course matched --course ${unmatched.map((q) => `"${q}"`).join(', ')}`));
    process.exit(1);
  }
  selected = courses;
  console.log(muted(`${selected.length} course${selected.length === 1 ? '' : 's'} selected: ${selected.map((c) => c.attributes?.title).join('; ')}`));
}

const queries = enrollmentQueries({
  courseIds: argv.course.length ? selected.map((c) => c.id) : [],
  emails, domains, completedOnly: argv.completedOnly, since
});

let pages = 0;
const reads = await mapWithConcurrency(queries, CONCURRENCY, async (params) => {
  try {
    const result = await listAllWithIncluded(client, '/enrollments/', params);
    pages += 1;
    if (process.stdout.isTTY) process.stdout.write(`\rRead ${pages} of ${queries.length} enrollment lists...`);
    return result;
  } catch (err) {
    if (process.stdout.isTTY) process.stdout.write('\n');
    return v2Fail(err, 'Could not list enrollments (needs enrollments:read, and possibly students:read for include=student)');
  }
});
if (process.stdout.isTTY) process.stdout.write('\n');

let built;
try {
  built = enrollmentRows(
    reads.flatMap((r) => r.data),
    reads.flatMap((r) => r.included),
    courseByPublishedCourse(publishedCourses, allCourses),
    { includeFeedback: argv.includeFeedback }
  );
} catch (err) {
  console.error(fail(err.message));
  process.exit(1);
}
const rows = sortRows(filterByEmailDomain(built.rows, emailDomains));
const summary = summarise(rows);

let mismatches = null;
if (argv.check && canCrossCheck({ emails, emailDomains, since })) {
  const params = domains.length ? { 'filter[domains]': domains.join(',') } : {};
  const analytics = new Map(await mapWithConcurrency(selected, CONCURRENCY, async (course) => {
    try {
      const { data } = await client.get(`/analytics/courses/${encodeURIComponent(course.id)}`, { params });
      return [course.id, data.data?.attributes];
    } catch (err) {
      return v2Fail(err, `Could not read analytics for "${course.attributes?.title}" (needs analytics:read; --no-check skips it)`);
    }
  }));
  mismatches = crossCheck(summary, analytics, { completedOnly: argv.completedOnly });
}

const fields = argv.includeFeedback ? [...ENROLLMENT_FIELDS, ...FEEDBACK_FIELDS] : ENROLLMENT_FIELDS;
await fs.ensureDir(path.dirname(argv.out));
await fs.writeFile(argv.out, parse(rows, { fields }));

const total = { enrollments: 0, completions: 0, certificates: 0 };
console.log(ok(`${rows.length} enrollments written to ${argv.out}`));
if (emailDomains.length) console.log(muted(`   ${built.rows.length - rows.length} of ${built.rows.length} read left out by --email-domain`));
for (const c of [...summary.values()].sort((x, y) => x.title.localeCompare(y.title))) {
  total.completions += c.completions;
  total.certificates += c.certificates;
  console.log(muted(`   ${(c.title || '(unknown course)').slice(0, 48).padEnd(48)} ${String(c.enrollments).padStart(6)} enrollments  ${String(c.completions).padStart(6)} completions  ${String(c.certificates).padStart(5)} certificates`));
}
console.log(muted(`   ${'Total'.padEnd(48)} ${String(rows.length).padStart(6)} enrollments  ${String(total.completions).padStart(6)} completions  ${String(total.certificates).padStart(5)} certificates`));

if (built.unknownPublishedCourses.length) {
  console.log(warn(`${built.unknownPublishedCourses.length} published course(s) the published-course list does not have; their rows have a blank course.`));
}
if (mismatches === null) {
  if (argv.check) console.log(muted('   Not cross-checked against analytics: it cannot be filtered by student or date.'));
} else if (mismatches.length) {
  const titles = new Map(selected.map((c) => [c.id, c.attributes?.title]));
  console.log(warn(`${mismatches.length} course(s) do not match the analytics summary:`));
  for (const m of mismatches.slice(0, 10)) {
    console.log(muted(`   ${titles.get(m.course_id)}: ${m.diffs.map((d) => `${d.field} ${d.exported} exported, ${d.analytics} in analytics`).join('; ')}`));
  }
} else {
  console.log(ok(`Counts match the analytics summary for all ${selected.length} course(s).`));
}
console.log(warn('This file holds names and email addresses. Delete it when you are done; it regenerates in one command.'));
