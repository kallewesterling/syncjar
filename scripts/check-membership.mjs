/**
 * check-membership.mjs — drop into syncjar's scripts/
 *
 * Read-only. Reports, for one or more users, whether they are currently a
 * member of a group and whether their domain-user records are active.
 *
 * Purpose: a group with a live email-domain rule re-adds matching users.
 * Skilljar's docs say such rules add users "when they register", which suggests
 * removals of existing members should stick — but that is not stated explicitly
 * anywhere, and if the rule re-evaluates periodically then group removals get
 * silently undone. That is the dangerous case: it looks remediated and isn't.
 *
 * So: remove one user, wait, run this. If they're back in the group, the rule
 * re-evaluates and must be changed before a bulk run is worth doing.
 *
 * Usage:
 *   node scripts/check-membership.mjs --group <group-id> \
 *     --domain <your-domain> --email someone@example.com
 *
 *   # or check everyone from a CSV
 *   node scripts/check-membership.mjs --group <group-id> \
 *     --in public/data/deactivate-candidates.csv
 */

import fs from 'fs-extra';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { createSkilljarClient } from './skilljar-client.mjs';

const argv = yargs(hideBin(process.argv))
  .option('group', { type: 'array', default: [] })
  .option('domain', { type: 'array', default: [] })
  .option('email', { type: 'array', default: [], describe: 'Email(s) to check' })
  .option('in', { type: 'string', describe: 'CSV with skilljar_id + email columns' })
  .check((a) => {
    if (!a.email.length && !a.in) throw new Error('Pass --email or --in.');
    if (!a.group.length && !a.domain.length) throw new Error('Pass --group or --domain.');
    return true;
  })
  .help()
  .argv;

const client = createSkilljarClient();

const err = (e) => `HTTP ${e?.response?.status ?? '-'}${e?.response?.data?.detail ? ` — ${e.response.data.detail}` : ''}`;

// Resolve emails to ids
let targets = [];
if (argv.in) {
  const lines = (await fs.readFile(argv.in, 'utf8')).split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(',').map((h) => h.trim().toLowerCase());
  const i = header.indexOf('skilljar_id');
  const e = header.indexOf('email');
  targets = lines.map((l) => { const c = l.split(','); return { id: c[i]?.trim(), email: c[e]?.trim() }; })
                 .filter((t) => t.id && t.email);
}
for (const email of argv.email) {
  try {
    const res = await client.get('/users', { params: { email, page_size: 5 } });
    const hit = (res.data?.results || []).map((r) => r.user ?? r)
      .find((u) => (u?.email || '').toLowerCase() === email.toLowerCase());
    if (hit) targets.push({ id: hit.id, email: hit.email });
    else console.log(chalk.yellow(`⚠️  no user found for ${email}`));
  } catch (e) {
    console.log(chalk.red(`✗ lookup failed for ${email}: ${err(e)}`));
  }
}

if (!targets.length) { console.log('Nothing to check.'); process.exit(0); }

console.log();
for (const t of targets) {
  const bits = [];

  for (const g of argv.group) {
    try {
      await client.get(`/groups/${g}/users/${t.id}`);
      bits.push(chalk.red(`group ${g}: MEMBER`));
    } catch (e) {
      if (e?.response?.status === 404) bits.push(chalk.green(`group ${g}: not a member`));
      else bits.push(chalk.yellow(`group ${g}: ${err(e)}`));
    }
  }

  for (const d of argv.domain) {
    try {
      const res = await client.get(`/domains/${d}/users/${t.id}`);
      const active = res.data?.active;
      bits.push(active ? chalk.red(`${d}: ACTIVE`) : chalk.green(`${d}: inactive`));
    } catch (e) {
      if (e?.response?.status === 404) bits.push(chalk.green(`${d}: no record`));
      else bits.push(chalk.yellow(`${d}: ${err(e)}`));
    }
  }

  console.log(`${t.email.padEnd(45)} ${bits.join('  |  ')}`);
}

console.log(chalk.gray('\nRed = still has access. Green = does not.\n'));
