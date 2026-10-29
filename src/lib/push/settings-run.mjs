/**
 * settings-run.mjs — the shared run of every settings push: branch guard,
 * change list, one prompt, writes, read-back.
 *
 * The commands differ only in what they read and where they write, so the
 * order of operations and its guarantees live here once: nothing is written
 * on --dry-run or from an unapproved content branch, the operator sees every
 * change before the prompt, the run stops at the first failed write, and a
 * run that wrote anything ends with a read-back that fails on any mismatch.
 */
import chalk from 'chalk';
import inquirer from 'inquirer';
import { failCleanly } from '#lib/skilljar/client.mjs';
import { DEFAULT_ALLOWED_BRANCHES, getCurrentBranch, isBranchAllowed } from '#lib/branch-guard.mjs';
import { renderDiff } from '#lib/push/render-diff.mjs';
import { patchBodies } from '#lib/push/settings.mjs';
import { ok, warn, fail, skip, change, muted, heading } from '#lib/ui.mjs';

/**
 * Refuses a real run from a content repo that is not on an allowed branch.
 * Returns true when the run may go ahead. --dry-run always may.
 */
export function guardBranch({ argv, command, dir }) {
  if (argv['dry-run']) return true;
  const allowed = [...DEFAULT_ALLOWED_BRANCHES, ...(argv['allow-branch'] ?? [])];
  const branch = getCurrentBranch(dir);
  if (isBranchAllowed(branch, allowed)) return true;
  console.error(chalk.bold.red(`\nRefusing to ${command}: ${dir} ` +
    (branch ? `is on branch ${chalk.yellow(branch)}.` : 'is not on a branch (detached HEAD, or not a git repo).')));
  console.error(`Allowed branches: ${allowed.join(', ')}`);
  console.error(chalk.gray(`\nTo check without writing:  npm run ${command} -- --dry-run` +
    (branch ? `\nTo push from this branch:   npm run ${command} -- --allow-branch ${branch}` : '')));
  process.exitCode = 1;
  return false;
}

// Long values and markup get a diff; a flag or a short name reads fine inline.
function showValueChange(field, from, to) {
  const long = (v) => typeof v === 'string' && (v.length > 60 || v.includes('<'));
  if (long(from) || long(to)) {
    console.log(`    ${field}:`);
    console.log(renderDiff(from ?? '', to ?? '', { style: 'stacked' }).replace(/^/gm, '      '));
    return;
  }
  console.log(`    ${field}: ${chalk.red(JSON.stringify(from))} → ${chalk.green(JSON.stringify(to))}`);
}

/**
 * Shows a plan, and unless this is a dry run, applies and verifies it.
 *
 *   argv      parsed args: dry-run, force
 *   noun      what a target is, for the summary ("course", "lesson", …)
 *   compared  how many targets were compared
 *   plan      { changes, inSync, warnings } from planSettings()
 *   header    (write) => the line printed above a target's changes
 *   write     async (endpoint, body) => void; one PATCH
 *   verify    async () => problems[]; reads back after the writes
 */
export async function runSettingsPush({ argv, noun, compared, plan, header = (w) => w.label, write, verify }) {
  const { changes, inSync, warnings } = plan;
  for (const w of warnings) console.warn(warn(w));
  console.log(muted(`\n${compared} ${noun}(s) compared: ${inSync} setting(s) in sync, ${changes.length} to change\n`));

  if (changes.length === 0) {
    console.log(ok(chalk.bold('Settings are in sync.')));
    return;
  }

  const writes = patchBodies(changes);
  for (const w of writes) {
    console.log(change(header(w)));
    for (const c of changes.filter(c => c.id === w.id)) showValueChange(c.field, c.from, c.to);
  }
  console.log();

  if (argv['dry-run']) {
    console.log(skip(`dry run — would PATCH ${writes.length} ${noun}(s); nothing written`));
    return;
  }

  if (!argv.force) {
    const { yes } = await inquirer.prompt([{
      type: 'confirm',
      name: 'yes',
      message: `Write these settings to ${writes.length} ${noun}(s)?`,
      default: false
    }]);
    if (!yes) {
      console.log(skip('Nothing written.'));
      return;
    }
  }

  // Stop at the first failure, so the summary never reports later writes as
  // though this one had landed.
  for (const w of writes) {
    try {
      await write(w.endpoint, w.body);
    } catch (err) {
      failCleanly(err, `Could not update ${w.label}.`);
    }
    console.log(ok(`Updated ${w.label}`));
  }

  const problems = await verify();
  if (problems.length) {
    console.error(chalk.red(`\n${problems.length} problem(s) found reading back:`));
    for (const p of problems) console.error(fail(p));
    process.exitCode = 1;
    return;
  }
  console.log();
  console.log(ok(chalk.bold(`Verified ${writes.length} ${noun}(s): the new settings landed and nothing else changed.`)));
}
