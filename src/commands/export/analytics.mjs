/**
 * syncjar export:analytics  (npm run export:analytics)
 *
 * Exports Skilljar's per-course analytics summary to CSV, through the v2
 * API: enrollments, completions, completion rate, certificates and ratings.
 * Needs SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET for an API client with
 * courses:read and analytics:read, and domains:read for --domain or
 * --by-domain.
 *
 *   syncjar export:analytics
 *   syncjar export:analytics --by-domain
 *   syncjar export:analytics --domain courses.example.com --out partner.csv
 *
 * Read-only. Makes GET requests exclusively. One request per course and
 * domain; any failure stops the export rather than writing a partial CSV.
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
import { ALL_DOMAINS, ANALYTICS_FIELDS, analyticsRow, checkDomains, sortRows, summarise } from '#lib/analytics/course-analytics.mjs';

const CONCURRENCY = 6;

const argv = yargs(hideBin(process.argv))
  .scriptName('syncjar export:analytics')
  .option('domain', { type: 'array', string: true, default: [], describe: 'Add a row per course for this domain name; repeatable' })
  .option('by-domain', { type: 'boolean', default: false, describe: 'Add a row per course for every domain' })
  .option('published-only', { type: 'boolean', default: false, describe: 'Leave out unpublished courses' })
  .option('out', { type: 'string', default: path.join(workRoot, 'public', 'data', 'course-analytics.csv'), describe: 'Output CSV path' })
  .strict()
  .help()
  .parse();

let client;
try {
  client = createSkilljarV2Client();
} catch (err) {
  console.error(fail(err.message));
  process.exit(1);
}
const v2Fail = (err, context) => failCleanly(err, context, { credentialsHint: V2_CREDENTIALS_HINT });

let domains = [];
if (argv.byDomain || argv.domain.length) {
  let known;
  try {
    known = (await listAllV2(client, '/domains/')).map((d) => d.attributes?.name).filter(Boolean);
  } catch (err) {
    v2Fail(err, 'Could not list domains (needs domains:read)');
  }
  if (argv.byDomain) domains = known;
  else {
    const { valid, unknown } = checkDomains(argv.domain, known);
    if (unknown.length) {
      console.error(fail(`Not a Skilljar domain: ${unknown.join(', ')}. Known: ${known.join(', ')}`));
      process.exit(1);
    }
    domains = valid;
  }
}

let courses;
try {
  courses = await listAllV2(client, '/courses/');
} catch (err) {
  v2Fail(err, 'Could not list courses');
}
if (argv.publishedOnly) courses = courses.filter((c) => c.attributes?.is_published);

const jobs = courses.flatMap((course) => [ALL_DOMAINS, ...domains].map((domain) => ({ course, domain })));
let done = 0;
const rows = await mapWithConcurrency(jobs, CONCURRENCY, async ({ course, domain }) => {
  try {
    const params = domain === ALL_DOMAINS ? {} : { 'filter[domains]': domain };
    const { data } = await client.get(`/analytics/courses/${encodeURIComponent(course.id)}`, { params });
    done += 1;
    if (process.stdout.isTTY) process.stdout.write(`\rRead ${done} of ${jobs.length}...`);
    return analyticsRow(course, domain, data.data?.attributes);
  } catch (err) {
    if (process.stdout.isTTY) process.stdout.write('\n');
    return v2Fail(err, `Could not read analytics for "${course.attributes?.title}"${domain === ALL_DOMAINS ? '' : ` on ${domain}`}`);
  }
});
if (process.stdout.isTTY) process.stdout.write('\n');

await fs.ensureDir(path.dirname(argv.out));
await fs.writeFile(argv.out, parse(sortRows(rows), { fields: ANALYTICS_FIELDS }));

const { totals, mismatches } = summarise(rows, domains);
console.log(ok(`${courses.length} courses${domains.length ? ` × ${domains.length + 1} views` : ''} written to ${argv.out}`));
for (const [domain, t] of totals) {
  console.log(muted(`   ${domain.padEnd(32)} ${String(t.enrollments).padStart(6)} enrollments  ${String(t.completions).padStart(6)} completions  ${String(t.certificates_issued).padStart(5)} certificates`));
}
if (mismatches.length) {
  console.log(warn(`${mismatches.length} courses' per-domain enrollments do not add up to their total, e.g. "${mismatches[0].title}": ${mismatches[0].sum} across domains, ${mismatches[0].all} overall.`));
}
