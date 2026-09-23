/**
 * export-students.mjs — drop into syncjar's scripts/ directory.
 *
 * Exports the flat Skilljar student list to CSV. Hits /users only: no
 * per-user course or lesson calls, so it is one paginated sweep rather
 * than thousands of requests.
 *
 * Why not `npm run sync:users && npm run export:users`:
 *   1. sync-users.mjs fetches every user's published-courses AND every
 *      course's lessons. That is N x (1 + courses) requests. Slow, and it
 *      hammers an API that rate-limits.
 *   2. sync-users.mjs skips users whose per-user cache file already exists
 *      and does not add them to `processed` — so on any re-run,
 *      user-progress.json (which export-users-to-csv.mjs reads) contains
 *      only the users touched in that run. The CSV comes out silently
 *      partial. For an access audit that is the worst kind of bug: a
 *      missing row looks like a clean result.
 *
 * Usage:
 *   node scripts/export-students.mjs
 *   node scripts/export-students.mjs --domain chainguard.dev
 *   node scripts/export-students.mjs --out ./students.csv
 *
 * Read-only. Makes GET requests exclusively.
 */

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parse } from 'json2csv';
import chalk from 'chalk';
import { createSkilljarClient, failCleanly } from './skilljar-client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = yargs(hideBin(process.argv))
  .option('domain', {
    type: 'string',
    describe: 'Only include students whose email is at this domain'
  })
  .option('out', {
    type: 'string',
    describe: 'Output CSV path',
    default: path.join(__dirname, '..', 'public', 'data', 'students.csv')
  })
  .option('page-size', { type: 'number', default: 100 })
  .help()
  .argv;

const client = createSkilljarClient();

async function fetchAllUsers(pageSize) {
  const all = [];
  let page = 1;

  while (true) {
    let res;
    try {
      res = await client.get('/users', { params: { page, page_size: pageSize } });
    } catch (err) {
      failCleanly(err, `Failed fetching /users page ${page}`);
    }
    const data = res.data;

    if (Array.isArray(data?.results)) {
      all.push(...data.results);
    } else if (Array.isArray(data)) {
      all.push(...data);
      break;
    } else {
      console.warn(chalk.yellow(`! Unexpected response on page ${page}`));
      break;
    }

    process.stdout.write(`\rFetched ${all.length} students...`);

    if (!data.next) break;
    page += 1;
  }

  process.stdout.write('\n');
  return all;
}

const iso = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

const entries = await fetchAllUsers(argv.pageSize);

const seen = new Set();
let skippedDomain = 0;
let skippedNoEmail = 0;
const rows = [];

for (const entry of entries) {
  const u = entry.user ?? entry;
  const email = (u?.email || '').trim();

  if (!email || !email.includes('@')) {
    skippedNoEmail += 1;
    continue;
  }

  const domain = email.split('@')[1].toLowerCase();
  if (argv.domain && domain !== argv.domain.toLowerCase()) {
    skippedDomain += 1;
    continue;
  }

  const key = email.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);

  rows.push({
    skilljar_id: u.id || '',
    email,
    first_name: u.first_name || '',
    last_name: u.last_name || '',
    name: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
    domain,
    signed_up_at: iso(entry.signed_up_at ?? u.created),
    latest_activity: iso(entry.latest_activity),
    no_activity: !entry.latest_activity
  });
}

rows.sort((a, b) => a.email.localeCompare(b.email));

await fs.ensureDir(path.dirname(argv.out));
await fs.writeFile(argv.out, parse(rows));

console.log(chalk.green(`✓ ${rows.length} students written to ${argv.out}`));
console.log(`   ${entries.length} total records from the API`);
if (skippedDomain) console.log(`   ${skippedDomain} skipped (other domains)`);
if (skippedNoEmail) console.log(`   ${skippedNoEmail} skipped (no usable email)`);

const stale = rows.filter((r) => r.no_activity).length;
if (stale) {
  console.log(chalk.yellow(`   ${stale} have no recorded activity — useful corroboration when reviewing`));
}
