/**
 * push-course-settings.mjs — push course-level settings from details.json.
 *
 * Only the fields in COURSE_SETTINGS (course-settings.mjs) are compared or
 * written: `enforce_sequential_navigation`, the two course-time display
 * flags, and `labels`. Titles and content belong to `push`, and descriptions
 * are not written by anything.
 *
 * One `GET /courses` reads every course's current settings, plus one
 * `GET /labels` when some local course names a label, so a dry run is one or
 * two requests. A real run shows the same list, asks once, sends one
 * `PATCH /courses/{id}` per course with only the changed fields, then reads
 * the catalog again and fails if any intended value did not land or any
 * other field on a written course moved.
 */
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { repoRoot } from '#lib/paths.mjs';
import { createSkilljarClient, failCleanly } from '#lib/skilljar/client.mjs';
import { fetchCourses, fetchLabels } from '#lib/skilljar/fetch.mjs';
import { listCourseDirs } from '#lib/content/course-dirs.mjs';
import { planCourseSettings, patchBodies, verifyCourseSettings } from '#lib/push/course-settings.mjs';
import { DEFAULT_ALLOWED_BRANCHES, getCurrentBranch, isBranchAllowed } from '#lib/branch-guard.mjs';
import { ok, warn, fail, skip, change, muted, heading } from '#lib/ui.mjs';

dotenv.config();

const argv = yargs(hideBin(process.argv))
  .option('dry-run', { type: 'boolean', default: false, description: 'Show each course\'s before and after; write nothing' })
  .option('force', { type: 'boolean', default: false, description: 'Write without asking' })
  .option('course', { type: 'array', string: true, default: [], description: 'Only this course directory name or course id (repeatable)' })
  .option('allow-branch', { type: 'array', string: true, default: [], description: 'Also allow pushing from this content branch' })
  .strict()
  .argv;

const coursesDir = process.env.COURSE_CONTENT_PATH || path.join(repoRoot, 'local-skilljar');

async function readLocals() {
  const wanted = new Set(argv.course);
  const locals = [];
  for (const courseDir of await listCourseDirs(coursesDir)) {
    const detailsPath = path.join(coursesDir, courseDir, 'details.json');
    if (!(await fs.pathExists(detailsPath))) continue;
    const details = await fs.readJson(detailsPath);
    if (wanted.size && !wanted.has(courseDir) && !wanted.has(details.id)) continue;
    locals.push({ courseDir, details });
  }
  return locals;
}

(async () => {
  if (!argv['dry-run']) {
    const allowed = [...DEFAULT_ALLOWED_BRANCHES, ...argv['allow-branch']];
    const branch = getCurrentBranch(coursesDir);
    if (!isBranchAllowed(branch, allowed)) {
      console.error(chalk.bold.red(`\nRefusing to push course settings: ${coursesDir} ` +
        (branch ? `is on branch ${chalk.yellow(branch)}.` : 'is not on a branch (detached HEAD, or not a git repo).')));
      console.error(`Allowed branches: ${allowed.join(', ')}`);
      console.error(chalk.gray(`\nTo check without writing:  npm run push:course-settings -- --dry-run` +
        (branch ? `\nTo push from this branch:   npm run push:course-settings -- --allow-branch ${branch}` : '')));
      process.exitCode = 1;
      return;
    }
  }

  const locals = await readLocals();
  if (argv.course.length) {
    const found = new Set(locals.flatMap(l => [l.courseDir, l.details.id]));
    const missing = argv.course.filter(c => !found.has(c));
    if (missing.length) {
      console.error(fail(`No local course matches: ${missing.join(', ')}`));
      process.exitCode = 1;
      return;
    }
  }
  if (locals.length === 0) {
    console.log(chalk.yellow('Nothing to compare.'));
    return;
  }

  const client = createSkilljarClient();
  const before = await fetchCourses(client);
  const beforeById = new Map(before.map(c => [c.id, c]));
  const namesLabels = locals.some(l => Array.isArray(l.details.labels) && l.details.labels.length);
  const knownLabels = new Set(namesLabels ? (await fetchLabels(client)).map(l => l.name) : []);
  const { changes, inSync, warnings } = planCourseSettings({ locals, upstreamById: beforeById, knownLabels });

  for (const w of warnings) console.warn(warn(w));
  console.log(muted(`\n${locals.length} course(s) compared: ${inSync} setting(s) in sync, ${changes.length} to change\n`));

  if (changes.length === 0) {
    console.log(ok(chalk.bold('Course settings are in sync.')));
    return;
  }

  const writes = patchBodies(changes);
  for (const { courseId, courseDir, title } of writes) {
    console.log(change(`${heading(title)} ${muted(`(${courseDir}, ${courseId})`)}`));
    for (const c of changes.filter(c => c.courseId === courseId)) {
      console.log(`    ${c.field}: ${chalk.red(JSON.stringify(c.from))} → ${chalk.green(JSON.stringify(c.to))}`);
    }
  }
  console.log();

  if (argv['dry-run']) {
    console.log(skip(`dry run — would PATCH ${writes.length} course(s); nothing written`));
    return;
  }

  if (!argv.force) {
    const { yes } = await inquirer.prompt([{
      type: 'confirm',
      name: 'yes',
      message: `Write these settings to ${writes.length} course(s)?`,
      default: false
    }]);
    if (!yes) {
      console.log(skip('Nothing written.'));
      return;
    }
  }

  // Stop at the first failure, so the summary never reports later writes as
  // though this one had landed.
  for (const { courseId, courseDir, body } of writes) {
    try {
      await client.patch(`/courses/${courseId}`, body);
    } catch (err) {
      failCleanly(err, `Could not update settings for ${courseDir} (${courseId}).`);
    }
    console.log(ok(`Updated ${courseDir}`));
  }

  const after = new Map((await fetchCourses(client)).map(c => [c.id, c]));
  const problems = verifyCourseSettings({ changes, before: beforeById, after });
  if (problems.length) {
    console.error(chalk.red(`\n${problems.length} problem(s) found reading the courses back:`));
    for (const p of problems) console.error(fail(p));
    process.exitCode = 1;
    return;
  }
  console.log();
  console.log(ok(chalk.bold(`Verified ${writes.length} course(s): the new settings landed and nothing else changed.`)));
})().catch(err => failCleanly(err, 'Push of course settings failed.'));
