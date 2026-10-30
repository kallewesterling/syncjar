/**
 * membership-run.mjs — the run behind `group:add` and `group:remove`.
 *
 * DRY RUN BY DEFAULT. A dry run makes only reads: it resolves the group and
 * looks up every email, so what it prints is what a real run would send.
 * With --confirm it asks for the action and count to be typed back, sends
 * the batches, stops at the first batch that fails as a whole, and writes an
 * audit CSV of every email either way.
 */
import fs from 'fs-extra';
import path from 'path';
import readline from 'node:readline/promises';
import yargs from 'yargs';
import { parse } from 'json2csv';
import { workRoot } from '#lib/paths.mjs';
import { mapWithConcurrency } from '#lib/concurrency.mjs';
import { errorDetail, failCleanly } from '#lib/skilljar/client.mjs';
import { createSkilljarV2Client, listAllV2, V2_CREDENTIALS_HINT } from '#lib/skilljar/client-v2.mjs';
import { fail, heading, muted, ok, skip, warn } from '#lib/ui.mjs';
import {
  ACTIONS,
  AUDIT_FIELDS,
  MEMBERSHIP_BATCH_SIZE,
  chunk,
  classifyLookups,
  membershipBody,
  normaliseEmails,
  parseEmailList,
  readBatchResult
} from '#lib/groups/membership.mjs';

const LOOKUP_CONCURRENCY = 4;
const SAMPLE_ROWS = 10;

export function parseMembershipArgs(action, argv) {
  const { verb } = ACTIONS[action];
  return yargs(argv)
    .scriptName(`syncjar group:${verb}`)
    .usage(`$0 (--group <id> | --group-name <name>) (--in <file> | --email <address>…) [--confirm]\n\n` +
      `${verb === 'add' ? 'Adds existing Skilljar students to' : 'Removes students from'} a group, by email. ` +
      'Dry run unless --confirm is passed.')
    .option('group', { type: 'string', describe: 'v2 id of the group' })
    .option('group-name', { type: 'string', describe: 'Exact name of the group (case-insensitive)' })
    .option('in', { type: 'string', describe: 'CSV with an email column, or one address per line' })
    .option('email', { type: 'array', string: true, default: [], describe: 'An address to act on; repeatable' })
    .option('confirm', { type: 'boolean', default: false, describe: 'Actually write. Without this it is a dry run.' })
    .option('audit-dir', { type: 'string', default: path.join(workRoot, 'public', 'data'), describe: 'Where the audit CSV is written' })
    .check((a) => {
      if (!a.group === !a.groupName) throw new Error('Pass exactly one of --group or --group-name.');
      if (!a.in && !a.email.length) throw new Error('Pass --in <file> or at least one --email.');
      return true;
    })
    .strict()
    .help()
    .parse();
}

/**
 * Finds the group by id, or by exact (case-insensitive) name. Returns
 * `{ group }`, or `{ error }` describing why there is no single match.
 */
export async function resolveGroup(client, { group, groupName }) {
  if (group) {
    const { data } = await client.get(`/groups/${encodeURIComponent(group)}`);
    return { group: data.data };
  }
  const candidates = await listAllV2(client, '/groups/', { 'filter[name]': groupName });
  const exact = candidates.filter((g) => g.attributes?.name?.toLowerCase() === groupName.toLowerCase());
  if (exact.length === 1) return { group: exact[0] };
  if (exact.length > 1) {
    return { error: `${exact.length} groups are named "${groupName}". Pass --group with one of: ${exact.map((g) => g.id).join(', ')}` };
  }
  const near = candidates.slice(0, 10).map((g) => `"${g.attributes?.name}"`).join(', ');
  return { error: `No group is named "${groupName}".${near ? ` Names containing it: ${near}` : ''}` };
}

async function lookUpStudents(client, emails) {
  return mapWithConcurrency(emails, LOOKUP_CONCURRENCY, async (email) => {
    const { data } = await client.get('/students/', { params: { 'filter[email]': email, 'page[size]': 2 } });
    return { email, matches: data.data ?? [] };
  });
}

async function readEmails(argv, readFile) {
  const fromFile = argv.in ? parseEmailList(await readFile(argv.in, 'utf8')) : { emails: [], invalid: [], repeated: 0 };
  const merged = normaliseEmails([...fromFile.emails, ...argv.email]);
  return {
    emails: merged.emails,
    invalid: [...fromFile.invalid, ...merged.invalid],
    repeated: fromFile.repeated + merged.repeated
  };
}

const describe = (err) => {
  const status = err?.response?.status;
  const detail = errorDetail(err) || (!status ? err?.code || err?.message : '');
  return `HTTP ${status ?? '-'}${detail ? ` — ${detail}` : ''}`;
};

async function askTyped(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Runs one add or remove. Returns the exit code. `client` is a v2 client
 * (or a stand-in with get/post/delete); the rest is injectable for tests.
 */
export async function runMembership(action, argv, {
  client,
  log = console.log,
  prompt = askTyped,
  readFile = fs.readFile,
  writeFile = fs.outputFile,
  now = Date.now,
  onApiError
}) {
  const { verb, method, past } = ACTIONS[action];
  const apiError = onApiError ?? ((err, context) => {
    log(fail(`${context}: ${describe(err)}`));
    return 1;
  });

  const { emails, invalid, repeated } = await readEmails(argv, readFile);
  if (invalid.length) log(warn(`${invalid.length} entries are not email addresses and are ignored: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ', …' : ''}`));
  if (repeated) log(muted(`  ${repeated} repeated addresses dropped`));
  if (!emails.length) {
    log(fail('No email addresses to act on.'));
    return 1;
  }

  let group;
  try {
    const resolved = await resolveGroup(client, argv);
    if (resolved.error) {
      log(fail(resolved.error));
      return 1;
    }
    group = resolved.group;
  } catch (err) {
    return apiError(err, `Could not read group ${argv.group ?? `"${argv.groupName}"`}`);
  }

  let lookups;
  try {
    lookups = await lookUpStudents(client, emails);
  } catch (err) {
    return apiError(err, 'Could not look up students by email');
  }
  const { found, missing, ambiguous } = classifyLookups(lookups);
  const inactive = found.filter((s) => s.inactive);

  log(heading(`\n${verb.toUpperCase()}  ${found.length} students ${action === 'add' ? 'to' : 'from'} "${group.attributes?.name}"`));
  log(muted(`  group id ${group.id}`));
  if (missing.length) log(warn(`${missing.length} emails have no Skilljar account and are skipped (nobody is created): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`));
  if (ambiguous.length) log(warn(`${ambiguous.length} emails match more than one student and are skipped: ${ambiguous.join(', ')}`));
  if (inactive.length) log(warn(`${inactive.length} of the students are deactivated; they are ${past} like the rest.`));
  log(muted(action === 'add'
    ? '  The v2 API cannot list a group\'s members, so students already in it are only identified after the run.'
    : '  The v2 API cannot list a group\'s members, so a student who was not in the group is reported as removed too.'));
  log(muted(`  ${Math.ceil(found.length / MEMBERSHIP_BATCH_SIZE)} write request(s) of up to ${MEMBERSHIP_BATCH_SIZE}\n`));

  if (!found.length) {
    log(fail('None of the emails belong to a Skilljar student. Nothing to do.'));
    return 1;
  }

  if (!argv.confirm) {
    for (const s of found.slice(0, SAMPLE_ROWS)) log(`  ${verb.padEnd(6)} ${s.email}${s.name ? muted(`  ${s.name}`) : ''}`);
    if (found.length > SAMPLE_ROWS) log(muted(`  … and ${found.length - SAMPLE_ROWS} more`));
    log(`\n${skip('DRY RUN: nothing was written. Re-run with --confirm to apply.')}\n`);
    return 0;
  }

  const expected = `${verb} ${found.length}`;
  const answer = await prompt(`Type "${expected}" to proceed: `);
  if (String(answer).trim() !== expected) {
    log(fail('Aborted. Nothing was written.'));
    return 1;
  }

  const rows = [];
  let stopped = null;
  for (const batch of chunk(found, MEMBERSHIP_BATCH_SIZE)) {
    if (stopped) {
      rows.push(...batch.map((s) => ({ email: s.email, student_id: s.id, result: 'not_attempted', error: 'an earlier batch failed' })));
      continue;
    }
    const sentAt = now();
    try {
      const url = `/groups/${encodeURIComponent(group.id)}/relationships/students/`;
      const body = membershipBody(batch.map((s) => s.id));
      const res = method === 'post' ? await client.post(url, body) : await client.delete(url, { data: body });
      rows.push(...readBatchResult(action, batch, res.data, sentAt));
    } catch (err) {
      stopped = describe(err);
      rows.push(...batch.map((s) => ({ email: s.email, student_id: s.id, result: 'failed', error: stopped })));
    }
  }

  const names = new Map(found.map((s) => [s.id, s.name]));
  const audit = [
    ...rows.map((r) => ({ ...r, name: names.get(r.student_id) ?? '' })),
    ...missing.map((email) => ({ email, result: 'skipped_no_account' })),
    ...ambiguous.map((email) => ({ email, result: 'skipped_ambiguous' }))
  ].map((r) => ({ ...r, group_id: group.id, group_name: group.attributes?.name ?? '', action }));

  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const auditPath = path.join(argv.auditDir, `group-${verb}-audit-${stamp}.csv`);
  await writeFile(auditPath, parse(audit, { fields: AUDIT_FIELDS }));

  const count = (result) => rows.filter((r) => r.result === result).length;
  const failed = rows.filter((r) => r.result === 'failed' || r.result === 'not_attempted').length;
  log('');
  log(ok(`${count(past)} ${past}`) + (action === 'add' ? muted(`, ${count('already_member')} already members`) : ''));
  if (failed) log(fail(`${failed} failed or not attempted`));
  if (stopped) log(fail(`Stopped after a batch failed: ${stopped}`));
  log(muted(`  Audit trail: ${auditPath}`));
  log(muted('  It holds names and email addresses. Delete it once it is no longer needed.\n'));
  return failed ? 1 : 0;
}

/**
 * The whole of `group:add` and `group:remove`. Options are parsed before
 * the client is built, so --help works without credentials.
 */
export async function membershipCommand(action, rawArgv) {
  const argv = parseMembershipArgs(action, rawArgv);
  let client;
  try {
    client = createSkilljarV2Client();
  } catch (err) {
    console.error(fail(err.message));
    return 1;
  }
  return runMembership(action, argv, {
    client,
    onApiError: (err, context) => failCleanly(err, context, { credentialsHint: V2_CREDENTIALS_HINT })
  });
}
