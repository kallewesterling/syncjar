import fs from 'fs-extra';
import path from 'path';
import { repoRoot } from '#lib/paths.mjs';
import { parse } from 'json2csv';

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
  const isChainguard = domain === 'chainguard.dev';
  const noActivity = !latest;

  return {
    '#': i + 1,
    'Student Name': name,
    'Email': email,
    'Open Tasks': 0,
    'Enrolled At': formatDate(enrolledAt),
    'Latest Activity': formatDate(latest),
    'Domain': domain,
    'Chainguard employee': isChainguard,
    'No activity': noActivity
  };
});

const csv = parse(rows);
await fs.writeFile(outputPath, csv);

console.log(`✓ CSV exported to ${outputPath}`);
