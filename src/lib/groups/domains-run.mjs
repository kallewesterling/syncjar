/**
 * domains-run.mjs — the run behind `group:domains`.
 *
 * With no --add or --remove it only lists the group's domains. Otherwise it
 * is a DRY RUN BY DEFAULT that prints the list before and after. With
 * --confirm it asks for the change to be typed back, reads the group again
 * and aborts if the list moved since the plan was shown, writes only
 * `rule_email_domains`, and reads the group back: a list that did not land,
 * or any other field that moved, is a failure.
 */
import readline from 'node:readline/promises';
import yargs from 'yargs';
import { failCleanly } from '#lib/skilljar/client.mjs';
import { createSkilljarV2Client, V2_CREDENTIALS_HINT } from '#lib/skilljar/client-v2.mjs';
import { describe, resolveGroup } from '#lib/groups/membership-run.mjs';
import { fail, heading, muted, ok, skip, warn } from '#lib/ui.mjs';
import { PUBLIC_EMAIL_DOMAINS, domainsBody, normaliseDomains, planDomains, sameDomains } from '#lib/groups/domains.mjs';

// Fields of a group that a domains write must leave alone.
const UNTOUCHED = ['name', 'send_course_enrollment_email', 'category_id'];

export function parseDomainsArgs(argv) {
  return yargs(argv)
    .scriptName('syncjar group:domains')
    .usage('$0 (--group <id> | --group-name <name>) [--add <domain>…] [--remove <domain>…] [--confirm]\n\n' +
      'Lists a group\'s auto-add email domains, or changes them. New students who sign up with an address at one ' +
      'of these domains are put in the group. Dry run unless --confirm is passed.')
    .option('group', { type: 'string', describe: 'v2 id of the group' })
    .option('group-name', { type: 'string', describe: 'Exact name of the group (case-insensitive)' })
    .option('add', { type: 'array', string: true, default: [], describe: 'A domain to add, e.g. example.com; repeatable' })
    .option('remove', { type: 'array', string: true, default: [], describe: 'A domain to remove; repeatable' })
    .option('allow-public-domain', { type: 'boolean', default: false, describe: 'Allow adding a free-mail domain such as gmail.com' })
    .option('confirm', { type: 'boolean', default: false, describe: 'Actually write. Without this it is a dry run.' })
    .check((a) => {
      if (!a.group === !a.groupName) throw new Error('Pass exactly one of --group or --group-name.');
      return true;
    })
    .strict()
    .help()
    .parse();
}

async function askTyped(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const listing = (domains) => (domains.length ? domains.join(', ') : '(none)');

async function readGroup(client, id) {
  const { data } = await client.get(`/groups/${encodeURIComponent(id)}`);
  return data.data;
}

/**
 * Runs one `group:domains`. Returns the exit code. `client` is a v2 client
 * (or a stand-in with get/patch); the rest is injectable for tests.
 */
export async function runDomains(argv, { client, log = console.log, prompt = askTyped, onApiError }) {
  const apiError = onApiError ?? ((err, context) => {
    log(fail(`${context}: ${describe(err)}`));
    return 1;
  });

  const add = normaliseDomains(argv.add);
  const remove = normaliseDomains(argv.remove);
  const invalid = [...add.invalid, ...remove.invalid];
  if (invalid.length) {
    log(fail(`Not a domain: ${invalid.join(', ')}. Pass a bare domain such as example.com.`));
    return 1;
  }
  const both = add.domains.filter((d) => remove.domains.includes(d));
  if (both.length) {
    log(fail(`Both added and removed: ${both.join(', ')}.`));
    return 1;
  }
  const publicDomains = add.domains.filter((d) => PUBLIC_EMAIL_DOMAINS.has(d));
  if (publicDomains.length && !argv.allowPublicDomain) {
    log(fail(`${publicDomains.join(', ')} is a free-mail domain: anyone who signs up with an address there would join the group.`));
    log(muted('  Pass --allow-public-domain if that really is intended.'));
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

  const current = group.attributes?.rule_email_domains ?? [];
  log(heading(`\n"${group.attributes?.name}"`));
  log(muted(`  group id ${group.id}`));
  log(`  Auto-add domains: ${listing(current)}`);

  if (!add.domains.length && !remove.domains.length) return 0;

  const plan = planDomains(current, { add: add.domains, remove: remove.domains });
  log('');
  for (const d of plan.adding) log(ok(`add     ${d}`));
  for (const d of plan.removing) log(warn(`remove  ${d}`));
  for (const d of plan.alreadyPresent) log(skip(`${d} is already there`));
  for (const d of plan.notPresent) log(skip(`${d} is not there, so there is nothing to remove`));

  const changes = plan.adding.length + plan.removing.length;
  if (!changes) {
    log(`\n${skip('Nothing to change.')}\n`);
    return 0;
  }
  log(muted(`\n  ${plan.before.length} domains before, ${plan.after.length} after`));
  log(muted('  This applies to new signups only. Students who already have an account are not added; use group:add for them.\n'));

  if (!argv.confirm) {
    log(`${skip('DRY RUN: nothing was written. Re-run with --confirm to apply.')}\n`);
    return 0;
  }

  const expected = `change ${changes}`;
  const answer = await prompt(`Type "${expected}" to proceed: `);
  if (String(answer).trim() !== expected) {
    log(fail('Aborted. Nothing was written.'));
    return 1;
  }

  let fresh;
  try {
    fresh = await readGroup(client, group.id);
  } catch (err) {
    return apiError(err, 'Could not re-read the group before writing');
  }
  if (!sameDomains(fresh.attributes?.rule_email_domains, current)) {
    log(fail(`The group's domains changed since this run read them: now ${listing(fresh.attributes?.rule_email_domains ?? [])}.`));
    log(fail('Nothing was written. Re-run to plan against the current list.'));
    return 1;
  }

  let res;
  try {
    res = await client.patch('/groups/', domainsBody(group.id, plan.after));
  } catch (err) {
    return apiError(err, 'Could not update the group\'s domains');
  }
  const [item] = res.data?.data ?? [];
  if (item?.status !== 'succeeded') {
    const error = item?.error ? [item.error.code, item.error.detail].filter(Boolean).join(': ') : 'no result in the response';
    log(fail(`The update was not applied: ${error}`));
    log(muted(`  The list was: ${listing(current)}`));
    return 1;
  }

  let after;
  try {
    after = await readGroup(client, group.id);
  } catch (err) {
    log(warn(`Written, but the read-back failed: ${describe(err)}. Check the group with group:domains.`));
    log(muted(`  The list was: ${listing(current)}`));
    return 1;
  }
  const problems = [];
  if (!sameDomains(after.attributes?.rule_email_domains, plan.after)) {
    problems.push(`domains read back as ${listing(after.attributes?.rule_email_domains ?? [])}`);
  }
  for (const field of UNTOUCHED) {
    if (JSON.stringify(after.attributes?.[field]) !== JSON.stringify(fresh.attributes?.[field])) {
      problems.push(`${field} moved from ${JSON.stringify(fresh.attributes?.[field])} to ${JSON.stringify(after.attributes?.[field])}`);
    }
  }
  if (problems.length) {
    for (const p of problems) log(fail(p));
    log(muted(`  The list was: ${listing(current)}`));
    return 1;
  }

  log(ok(`Updated: ${plan.adding.length} added, ${plan.removing.length} removed, ${after.attributes.rule_email_domains.length} domains now.`));
  log(muted(`  They were: ${listing(current)}\n`));
  return 0;
}

/**
 * The whole of `group:domains`. Options are parsed before the client is
 * built, so --help works without credentials.
 */
export async function domainsCommand(rawArgv) {
  const argv = parseDomainsArgs(rawArgv);
  let client;
  try {
    client = createSkilljarV2Client();
  } catch (err) {
    console.error(fail(err.message));
    return 1;
  }
  return runDomains(argv, {
    client,
    onApiError: (err, context) => failCleanly(err, context, { credentialsHint: V2_CREDENTIALS_HINT })
  });
}
