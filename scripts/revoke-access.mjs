/**
 * revoke-access.mjs — drop into syncjar's scripts/
 *
 * Revokes Skilljar access for a reviewed list of users. Two independent
 * actions, both REVERSIBLE, neither of which deletes anything:
 *
 *   --domain <name>   PATCH /v1/domains/{domain}/users/{user_id} {"active": false}
 *                     Revokes that user's access to that training domain.
 *                     Mirrors the dashboard's "Revoke Access" column.
 *
 *   --group <id>      DELETE /v1/groups/{group_id}/users/{user_id}
 *                     Removes the user from a student group. This is what
 *                     actually withdraws group-gated content visibility.
 *
 * There is NO account-level deactivate in the v1 API. PATCH /v1/users/{id}
 * only accepts email/first_name/last_name. The only account-level destructive
 * operation is POST /v1/users/{id}/anonymize, which is IRREVERSIBLE PII
 * erasure — this script never calls it.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --confirm.
 *
 * Usage:
 *   # see what would happen
 *   node scripts/revoke-access.mjs --in deactivate-candidates.csv \
 *        --domain <your-domain>
 *
 *   # actually do it
 *   node scripts/revoke-access.mjs --in deactivate-candidates.csv \
 *        --domain <your-domain> --confirm
 *
 *   # undo
 *   node scripts/revoke-access.mjs --in deactivate-candidates.csv \
 *        --domain <your-domain> --reactivate --confirm
 *
 * Every run writes an audit CSV recording the prior state of each record,
 * so a mistaken run can be reversed precisely rather than wholesale.
 */

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parse } from 'json2csv';
import chalk from 'chalk';
import readline from 'node:readline/promises';
import { createSkilljarClient } from './skilljar-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = yargs(hideBin(process.argv))
  .option('in', { type: 'string', demandOption: true, describe: 'CSV of users to act on (needs skilljar_id + email)' })
  .option('domain', { type: 'array', default: [], describe: 'Training domain(s) to revoke access on' })
  .option('group', { type: 'array', default: [], describe: 'Student group id(s) to remove users from' })
  .option('reactivate', { type: 'boolean', default: false, describe: 'Set active=true instead (domains only)' })
  .option('limit', { type: 'number', describe: 'Only act on the first N users. Use --limit 1 to test on one person.' })
  .option('only-email', { type: 'string', describe: 'Act on this single email address only (must be present in --in)' })
  .option('confirm', { type: 'boolean', default: false, describe: 'Actually write. Without this it is a dry run.' })
  .option('audit-dir', { type: 'string', default: path.join(__dirname, '..', 'public', 'data') })
  .check((a) => {
    if (!a.domain.length && !a.group.length) throw new Error('Pass at least one --domain or --group.');
    if (a.reactivate && a.group.length) throw new Error('--reactivate applies to --domain only; re-add to groups deliberately.');
    return true;
  })
  .help()
  .argv;

const client = createSkilljarClient();

// Never let a raw axios error print: it includes the Authorization header,
// which exposes the API key.
function describe(err) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  let detail = '';
  if (typeof body === 'string' && body.length < 200) detail = body;
  else if (body?.detail) detail = String(body.detail);
  else if (!status) detail = err?.code || err?.message || 'unknown error';
  return `HTTP ${status ?? '-'}${detail ? ` — ${detail}` : ''}`;
}

const rows = (await fs.readFile(argv.in, 'utf8')).split(/\r?\n/).filter(Boolean);
const header = rows.shift().split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
const idIdx = header.indexOf('skilljar_id');
const emailIdx = header.indexOf('email');
if (idIdx === -1 || emailIdx === -1) {
  console.error(chalk.red('✗ Input CSV must have skilljar_id and email columns.'));
  process.exit(1);
}

let targets = rows.map((line) => {
  // naive split is fine: ids and emails never contain commas
  const cells = line.split(',');
  return { id: cells[idIdx]?.trim(), email: cells[emailIdx]?.trim() };
}).filter((t) => t.id && t.email);

if (argv.onlyEmail) {
  const wanted = argv.onlyEmail.trim().toLowerCase();
  targets = targets.filter((t) => t.email.toLowerCase() === wanted);
  if (!targets.length) {
    console.error(chalk.red(`✗ ${argv.onlyEmail} is not in ${argv.in}. Refusing to act on someone not on the reviewed list.`));
    process.exit(1);
  }
}
if (argv.limit != null) targets = targets.slice(0, argv.limit);

const missingId = targets.filter((t) => !t.id).length;
const verb = argv.reactivate ? 'REACTIVATE' : 'REVOKE';

console.log(chalk.bold(`\n${verb}  ${targets.length} users`));
if (argv.domain.length) console.log(`  domains: ${argv.domain.join(', ')}`);
if (argv.group.length) console.log(`  groups:  ${argv.group.join(', ')}`);
if (missingId) console.log(chalk.yellow(`  ${missingId} rows skipped (no skilljar_id)`));
const totalOps = targets.length * (argv.domain.length + argv.group.length);
console.log(`  ${totalOps} API calls\n`);

const BASE = 'https://api.skilljar.com/v1';

/**
 * Preflight: actually GET one record per domain and per group before doing
 * anything. A dry run that only prints strings proves nothing about whether
 * the paths are right — this catches a wrong path, a bad id, or a dead key
 * before we start iterating over 110 people.
 */
async function preflight() {
  const checks = [];

  // Validate the DOMAIN itself, not one user's record on it. A specific
  // user/domain pair legitimately 404s when that user never signed up to
  // that domain, which is common and is not an error.
  for (const d of argv.domain) {
    const url = `/domains/${d}`;
    try {
      const res = await client.get(url);
      checks.push({ ok: true, what: `domain ${d}`, note: `reachable (${res.data?.name ?? 'ok'})` });
    } catch (err) {
      checks.push({ ok: false, what: `domain ${d}`, note: describe(err), url: BASE + url });
    }
  }

  for (const g of argv.group) {
    const url = `/groups/${g}`;
    try {
      const res = await client.get(url);
      checks.push({ ok: true, what: `group ${g}`, note: `reachable (${res.data?.name ?? 'ok'})` });
    } catch (err) {
      checks.push({ ok: false, what: `group ${g}`, note: describe(err), url: BASE + url });
    }
  }

  console.log(chalk.bold('Preflight (live GETs, no writes):'));
  for (const c of checks) {
    console.log(c.ok ? chalk.green(`  ✓ ${c.what} — ${c.note}`)
                     : chalk.red(`  ✗ ${c.what} — ${c.note}\n      ${c.url}`));
  }
  console.log();
  return checks.every((c) => c.ok);
}

const preflightOk = await preflight();
if (!preflightOk) {
  console.log(chalk.red('Preflight failed. Fix the above before running with --confirm.'));
  console.log(chalk.gray('A 404 here usually means a wrong path or a stale id, not a permissions problem.\n'));
  process.exit(1);
}

if (!argv.confirm) {
  console.log(chalk.cyan('DRY RUN — nothing will be written. Re-run with --confirm to apply.\n'));
  for (const t of targets.slice(0, 6)) {
    for (const d of argv.domain) {
      console.log(`  PATCH  ${BASE}/domains/${d}/users/${t.id}  {"active": ${argv.reactivate}}`);
    }
    for (const g of argv.group) {
      console.log(`  DELETE ${BASE}/groups/${g}/users/${t.id}`);
    }
    console.log(chalk.gray(`         ↳ ${t.email}`));
  }
  if (targets.length > 6) console.log(chalk.gray(`  … and ${targets.length - 6} more users`));
  console.log();
  process.exit(0);
}

// Typed confirmation. A flag alone is too easy to leave in shell history.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(chalk.yellow(`Type "${verb.toLowerCase()} ${targets.length}" to proceed: `));
rl.close();
if (answer.trim() !== `${verb.toLowerCase()} ${targets.length}`) {
  console.log(chalk.red('Aborted — no changes made.'));
  process.exit(1);
}

const audit = [];
let ok = 0, failed = 0, skipped = 0;

for (const [i, t] of targets.entries()) {
  process.stdout.write(`\r[${i + 1}/${targets.length}] ${t.email.padEnd(45)}`);

  for (const d of argv.domain) {
    // NOTE: skilljar-client.mjs sets baseURL to https://api.skilljar.com/v1
    // already, so paths here must NOT be prefixed with /v1.
    const url = `/domains/${d}/users/${t.id}`;
    let before = '';
    try {
      const cur = await client.get(url);
      before = String(cur.data?.active);
      // idempotent: skip if already in the desired state
      if (cur.data?.active === argv.reactivate) {
        audit.push({ email: t.email, skilljar_id: t.id, action: 'domain', target: d,
                     before, after: before, result: 'skipped_already_set', error: '' });
        skipped += 1;
        continue;
      }
    } catch (err) {
      // 404 = this user has no record on this domain, i.e. they never signed
      // up to it. Nothing to revoke, and not a failure.
      if (err?.response?.status === 404) {
        audit.push({ email: t.email, skilljar_id: t.id, action: 'domain', target: d,
                     before: 'no_record', after: 'no_record', result: 'skipped_no_record', error: '' });
        skipped += 1;
        continue;
      }
      audit.push({ email: t.email, skilljar_id: t.id, action: 'domain', target: d,
                   before: '', after: '', result: 'failed_read', error: describe(err) });
      failed += 1;
      continue;
    }

    try {
      const res = await client.patch(url, { active: argv.reactivate });
      audit.push({ email: t.email, skilljar_id: t.id, action: 'domain', target: d,
                   before, after: String(res.data?.active), result: 'ok', error: '' });
      ok += 1;
    } catch (err) {
      audit.push({ email: t.email, skilljar_id: t.id, action: 'domain', target: d,
                   before, after: '', result: 'failed_write', error: describe(err) });
      failed += 1;
    }
  }

  for (const g of argv.group) {
    try {
      await client.delete(`/groups/${g}/users/${t.id}`);
      audit.push({ email: t.email, skilljar_id: t.id, action: 'group_remove', target: g,
                   before: 'member', after: 'removed', result: 'ok', error: '' });
      ok += 1;
    } catch (err) {
      const status = err?.response?.status;
      // 404 = already not a member. Not an error for our purposes.
      const result = status === 404 ? 'skipped_not_member' : 'failed_write';
      if (status === 404) skipped += 1; else failed += 1;
      audit.push({ email: t.email, skilljar_id: t.id, action: 'group_remove', target: g,
                   before: '', after: '', result, error: status === 404 ? '' : describe(err) });
    }
  }
}

process.stdout.write('\n');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const auditPath = path.join(argv.auditDir, `revoke-audit-${stamp}.csv`);
await fs.ensureDir(argv.auditDir);
await fs.writeFile(auditPath, parse(audit, {
  fields: ['email', 'skilljar_id', 'action', 'target', 'before', 'after', 'result', 'error']
}));

console.log(chalk.green(`\n✓ ${ok} applied`) + `, ${skipped} skipped, ` +
            (failed ? chalk.red(`${failed} failed`) : '0 failed'));
console.log(`   Audit trail: ${auditPath}`);
if (failed) console.log(chalk.yellow('   Check the audit CSV — the error column has the reason for each failure.'));
console.log(chalk.gray('   To undo a domain revoke: re-run with --reactivate --confirm\n'));
