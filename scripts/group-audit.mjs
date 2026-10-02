/**
 * group-audit.mjs — drop into syncjar's scripts/
 *
 * Read-only. Answers "who is in this Skilljar group who is not on the
 * roster?" and writes a CSV that feeds straight into revoke-access.mjs.
 *
 * It recomputes against the roster on every run instead of working from a
 * saved candidate list, so it also catches anyone who has left since the last
 * audit. It is meant to be re-run.
 *
 * The roster is a CSV with an `email` column, one row per person who should
 * keep access. Anyone added to the organisation after the roster was built
 * looks like a departure, so a roster older than --max-age-days gets a
 * warning.
 *
 * Usage:
 *   node scripts/group-audit.mjs --group <group-id> --roster ./roster.csv
 *   node scripts/group-audit.mjs --group <group-id> --roster ./roster.csv \
 *        --out public/data/to-remove.csv
 *
 * Then, after reading the output:
 *   node scripts/revoke-access.mjs --in public/data/group-audit-<group-id>.csv \
 *        --group <group-id>
 */

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { createSkilljarClient } from './skilljar-client.mjs';
import { fetchGroupMembers } from './skilljar-fetch.mjs';
import { parseRoster, toMembers, membersNotOnRoster, toRevokeCsv } from './group-audit-diff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = yargs(hideBin(process.argv))
  .option('group', { type: 'string', demandOption: true, describe: 'Student group id to audit' })
  .option('roster', { type: 'string', demandOption: true, describe: 'CSV of people who should keep access (needs an email column)' })
  .option('out', { type: 'string', describe: 'Output CSV path (default: public/data/group-audit-<group>.csv)' })
  .option('max-age-days', { type: 'number', default: 14, describe: 'Warn when the roster file is older than this' })
  .help()
  .argv;

const out = argv.out ?? path.join(__dirname, '..', 'public', 'data', `group-audit-${argv.group}.csv`);

// --- roster ---------------------------------------------------------------

if (!(await fs.pathExists(argv.roster))) {
  console.error(chalk.red(`✗ Roster not found: ${argv.roster}`));
  process.exit(1);
}

let roster;
try {
  roster = parseRoster(await fs.readFile(argv.roster, 'utf8'));
} catch (err) {
  console.error(chalk.red(`✗ ${argv.roster}: ${err.message}`));
  process.exit(1);
}

const ageDays = (Date.now() - (await fs.stat(argv.roster)).mtimeMs) / 86_400_000;
console.log(`Roster: ${roster.size} people, ${ageDays.toFixed(0)} days old`);
if (ageDays > argv.maxAgeDays) {
  console.warn(chalk.yellow(
    `\n  Roster is older than ${argv.maxAgeDays} days. Anyone added since it was\n` +
    `  built will look departed and show up below as a false positive.\n` +
    `  Refresh it before acting.\n`
  ));
}

// --- group membership -----------------------------------------------------

const client = createSkilljarClient();
const members = toMembers(await fetchGroupMembers(client, argv.group));

// --- diff -----------------------------------------------------------------

const stale = membersNotOnRoster(members, roster);
const noId = stale.filter((m) => !m.id).length;

await fs.ensureDir(path.dirname(out));
await fs.writeFile(out, toRevokeCsv(stale));

console.log(`Group ${argv.group}: ${members.length} members`);
console.log(`  ${members.length - stale.length} on the roster, ${stale.length} not`);
if (noId) console.log(chalk.yellow(`  ${noId} have no user id; revoke-access will skip them`));
console.log(chalk.green(`\n✓ Written: ${out}`));
console.log('\nRead it before acting. To preview the removal:');
console.log(`  node scripts/revoke-access.mjs --in "${out}" --group ${argv.group}`);
console.log(chalk.gray('\nrevoke-access --reactivate covers domains only. Group re-adds are manual,'));
console.log(chalk.gray('so its audit CSV is the record if anything needs undoing.\n'));
