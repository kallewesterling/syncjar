import fs from 'fs-extra';
import path from 'path';
import { repoRoot } from '#lib/paths.mjs';
import { parse } from 'json2csv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('internal-domain', {
    type: 'string',
    default: process.env.SYNCJAR_INTERNAL_DOMAIN,
    describe: 'Email domain whose users count as internal (env: SYNCJAR_INTERNAL_DOMAIN)'
  })
  .help()
  .argv;

const internalDomain = argv.internalDomain?.toLowerCase();

const inputPath = path.join(repoRoot, 'public', 'data', 'user-progress.json');
const outputPath = path.join(repoRoot, 'public', 'data', 'user-report.csv');

const users = await fs.readJson(inputPath);

const rows = users.map((user, i) => {
  const name = user.name || `${user.first_name || ''} ${user.last_name || ''}`.trim();
  const email = user.email;
  const enrolledAt = new Date(user.signed_up_at || user.created);
  const latest = user.latest_activity ? new Date(user.latest_activity) : null;

  const formatDate = d =>
    d ? `${d.getFullYear()}-${d.toLocaleString('default', { month: 'short' })}-${d.getDate()}` : '';

  const domain = email.split('@')[1];
  const isInternal = Boolean(internalDomain) && domain?.toLowerCase() === internalDomain;
  const noActivity = !latest;

  return {
    '#': i + 1,
    'Student Name': name,
    'Email': email,
    'Open Tasks': 0,
    'Enrolled At': formatDate(enrolledAt),
    'Latest Activity': formatDate(latest),
    'Domain': domain,
    'Internal user': isInternal,
    'No activity': noActivity
  };
});

const csv = parse(rows);
await fs.writeFile(outputPath, csv);

console.log(`✓ CSV exported to ${outputPath}`);
