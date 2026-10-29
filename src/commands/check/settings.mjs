/**
 * npm run check:settings
 *
 * Read-only. Reports the courses and paths whose settings differ from the
 * rest of the catalog: one value is the norm when it covers at least
 * --threshold of the records (default 90%), and every record off it is
 * listed. See src/lib/check/settings.mjs.
 *
 * Domains come from --domain, then SKILLJAR_DOMAINS, then every domain the
 * key can see. Costs one request each for courses, paths and the domain
 * list, plus a published-course and a published-path list per domain.
 *
 * Exits 0 unless --fail-on-outliers is passed and something was flagged.
 */
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { createSkilljarClient, failCleanly } from '#lib/skilljar/client.mjs';
import { fetchCourses, fetchPaths, fetchPublishedCourses, fetchPublishedPaths } from '#lib/skilljar/fetch.mjs';
import {
  DEFAULT_THRESHOLD,
  summarise,
  COURSE_FIELDS,
  PUBLISHED_COURSE_FIELDS,
  PATH_FIELDS,
  PUBLISHED_PATH_FIELDS
} from '#lib/check/settings.mjs';
import { ok, warn, skip, muted, heading } from '#lib/ui.mjs';

dotenv.config();

const argv = yargs(hideBin(process.argv))
  .option('domain', { type: 'array', string: true, default: [], description: 'Skilljar domain host (repeatable). Overrides SKILLJAR_DOMAINS' })
  .option('threshold', { type: 'number', default: DEFAULT_THRESHOLD, description: 'Share of records a value must cover to count as the norm' })
  .option('fail-on-outliers', { type: 'boolean', default: false, description: 'Exit 1 if any record is flagged' })
  .strict()
  .argv;

const show = (v) => JSON.stringify(v);
let flagged = 0;

function report(title, records, fields, labelOf) {
  console.log(heading(`\n${title}`) + muted(` — ${records.length} record(s)`));
  if (!records.length) return;
  for (const s of summarise(records, fields, labelOf, argv.threshold)) {
    if (s.status === 'uniform') {
      console.log(ok(`${s.field}: ${show(s.majority)} on all`));
    } else if (s.status === 'varies') {
      console.log(skip(`${s.field}: varies (${s.counts.map(([v, n]) => `${show(v)} ${n}`).join(', ')})`));
    } else {
      flagged += s.outliers.length;
      console.log(warn(`${s.field}: ${show(s.majority)} on ${s.counts[0][1]}, ${s.outliers.length} differ`));
      for (const o of s.outliers) console.log(`      ${chalk.yellow(show(o.value))}  ${o.label}`);
    }
  }
}

(async () => {
  const client = createSkilljarClient();

  let domains = argv.domain.length ? argv.domain
    : (process.env.SKILLJAR_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!domains.length) {
    try {
      domains = (await client.get('/domains', { params: { page_size: 100 } })).data.results.map(d => d.name);
    } catch (err) {
      failCleanly(err, 'Could not list domains.');
    }
  }

  report('Courses', await fetchCourses(client), COURSE_FIELDS, c => `${c.title} (${c.id})`);
  for (const domain of domains) {
    report(`Published courses on ${domain}`, await fetchPublishedCourses(client, domain), PUBLISHED_COURSE_FIELDS,
      p => `${p.course?.title ?? '?'} (${p.slug})`);
  }
  report('Paths', await fetchPaths(client), PATH_FIELDS, p => `${p.title} (${p.id})`);
  for (const domain of domains) {
    report(`Published paths on ${domain}`, await fetchPublishedPaths(client, domain), PUBLISHED_PATH_FIELDS,
      p => `${p.path?.title ?? '?'} (${p.slug})`);
  }

  console.log();
  console.log(flagged ? warn(chalk.bold(`${flagged} setting(s) differ from the norm.`)) : ok(chalk.bold('No outliers.')));
  if (flagged && argv['fail-on-outliers']) process.exitCode = 1;
})().catch(err => failCleanly(err, 'check:settings failed.'));
