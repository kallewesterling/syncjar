/**
 * sync-local-to-skilljar.mjs — push local course content upstream.
 *
 * Runs in two phases. The **scan** compares every local course against
 * upstream and produces a plan; it makes no writes, so it runs in parallel.
 * The **apply** walks that plan, shows each diff and prompts, and writes; it
 * is sequential, because prompts are.
 *
 * It used to be one interleaved pass, which forced everything into the
 * sequential shape the prompts needed — 1,537 round trips at ~380ms, roughly
 * ten minutes, with a prompt surfacing every minute and a half. Splitting the
 * phases cuts that to 716 requests (see skilljar-fetch.mjs) run 6 at a time,
 * and puts the whole change list in front of the operator before the first
 * prompt rather than dribbling it out over ten minutes.
 */
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import inquirer from 'inquirer';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { listCourseDirs } from './course-dirs.mjs';
import { mapWithConcurrency } from './concurrency.mjs';
import { fetchCourses, fetchLessons, fetchContentItems } from './skilljar-fetch.mjs';
import { planCourse } from './push-plan.mjs';
import { renderDiff, renderValueChange } from './render-diff.mjs';
import { ok, warn, skip, change, muted, heading } from './ui.mjs';
import {
  DEFAULT_ALLOWED_BRANCHES,
  getCurrentBranch,
  isBranchAllowed
} from './branch-guard.mjs';

// __dirname workaround for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Requests in flight during the scan. The client backs off on 429, so this is
// a throughput choice rather than a safety one; 6 sits below the 12 the pull
// already peaks at without complaint, and the scan is read-only besides.
const DEFAULT_CONCURRENCY = 6;

// CLI args
const argv = yargs(hideBin(process.argv))
  .option('course', { type: 'string', describe: 'Course folder slug to sync' })
  .option('lesson', { type: 'string', describe: 'Lesson slug to sync' })
  .option('dry-run', { type: 'boolean', describe: 'Preview changes without syncing' })
  .option('force', { type: 'boolean', describe: 'Sync content-item changes without prompting' })
  .option('force-titles', { type: 'boolean', describe: 'Sync course/lesson title changes without prompting (separate from --force)' })
  .option('diff-only', { type: 'boolean', describe: 'Only show diffs, do not sync' })
  .option('diff', { type: 'boolean', default: true, describe: 'Show diffs before syncing' })
  .option('diff-style', {
    type: 'string',
    choices: ['auto', 'side-by-side', 'stacked'],
    default: 'auto',
    describe: 'Diff layout. auto uses two columns when the terminal is wide enough'
  })
  .option('concurrency', {
    type: 'number',
    default: DEFAULT_CONCURRENCY,
    describe: 'Read requests in flight during the scan phase'
  })
  .option('add-last-updated', {
    type: 'boolean',
    default: false,
    describe: 'If set, updates the lesson description_html with today\'s date'
  })
  .option('allow-branch', {
    type: 'array',
    default: [],
    describe: `Also allow pushing from this content-repo branch (repeatable). Allowed by default: ${DEFAULT_ALLOWED_BRANCHES.join(', ')}`
  })
  .help()
  .argv;

// Load Skilljar auth
import dotenv from 'dotenv';
import { createSkilljarClient, failCleanly } from './skilljar-client.mjs';
dotenv.config();

// Auto-retries on 429/5xx, honouring the server's Retry-After header.
const client = createSkilljarClient();

// A title is one short string, so a two-column layout would be more structure
// than it deserves; content bodies get the full side-by-side treatment from
// render-diff.mjs.
function printDiff(action) {
  if (action.kind === 'text') {
    console.log(renderValueChange(action.upstreamValue, action.localValue));
    return;
  }
  console.log(renderDiff(action.upstreamValue, action.localValue, { style: argv['diff-style'] }));
}

// Progress goes to stderr so that piping the diff output somewhere doesn't
// interleave it with a progress counter being overwritten in place.
function progress(done, total, label) {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`\r\x1B[2K  ${chalk.gray(`[${done}/${total}]`)} ${label}`);
}

function endProgress() {
  if (process.stderr.isTTY) process.stderr.write('\r\x1B[2K');
}

// ---------------------------------------------------------------------------
// Scan phase
// ---------------------------------------------------------------------------

/**
 * Reads one course's local tree. Returns null for a directory that isn't a
 * course, which is not an error: the content root holds generated JSON and
 * whatever the operating system leaves behind.
 */
async function readLocalCourse(coursesDir, courseFolder) {
  const courseDir = path.join(coursesDir, courseFolder);
  const detailsPath = path.join(courseDir, 'details.json');
  const lessonsMetaPath = path.join(courseDir, 'lessons-meta.json');

  if (!(await fs.pathExists(detailsPath)) || !(await fs.pathExists(lessonsMetaPath))) {
    console.warn(warn(`Skipping course "${courseFolder}" — missing details or metadata`));
    return null;
  }

  const [courseDetails, lessons] = await Promise.all([
    fs.readJson(detailsPath),
    fs.readJson(lessonsMetaPath)
  ]);

  // Read every local file up front. This is disk, not network, and having it
  // in hand keeps planCourse() pure.
  const localHtmlByItemId = new Map();
  for (const lesson of lessons) {
    if (argv.lesson && lesson.slug !== argv.lesson) continue;
    for (const item of lesson.content_items) {
      if (!item.id) continue;
      try {
        localHtmlByItemId.set(item.id, await fs.readFile(path.join(courseDir, item.file), 'utf8'));
      } catch {
        // planCourse() reports this as a warning; a stray entry in
        // lessons-meta.json is not a reason to abandon the run.
      }
    }
  }

  return { courseFolder, courseDir, lessonsMetaPath, courseDetails, lessons, localHtmlByItemId };
}

/**
 * Compares every local course against upstream and returns one plan.
 *
 * Fetches in two flat stages rather than nesting course → lesson → item. A
 * flat stage keeps every worker busy: nesting leaves the last few lessons of
 * a large course running alone while the limiter holds back work from other
 * courses that could have started.
 */
async function scan(locals) {
  const limit = Math.max(1, argv.concurrency);

  // Stage 0 — one request for the whole catalog. Replaces a GET per course.
  const upstreamCourses = await fetchCourses(client);
  const upstreamCourseById = new Map(upstreamCourses.map(c => [c.id, c]));

  // Stage 1 — lessons, one request per course. Carries every lesson title.
  let done = 0;
  const lessonsPerCourse = await mapWithConcurrency(locals, limit, async (local) => {
    const upstream = await fetchLessons(client, local.courseDetails.id);
    progress(++done, locals.length, `reading lessons — ${local.courseFolder}`);
    return upstream;
  });
  endProgress();

  // Stage 2 — content items, one request per lesson, content included.
  //
  // Only lessons the plan will actually look at: --lesson narrows this from
  // 649 requests to one.
  const lessonTargets = [];
  locals.forEach((local, i) => {
    const localIds = new Set(
      local.lessons
        .filter(l => !argv.lesson || l.slug === argv.lesson)
        .map(l => l.id)
    );
    for (const upstreamLesson of lessonsPerCourse[i]) {
      if (localIds.has(upstreamLesson.id)) lessonTargets.push(upstreamLesson);
    }
  });

  done = 0;
  const itemsPerLesson = await mapWithConcurrency(lessonTargets, limit, async (lesson) => {
    const items = await fetchContentItems(client, lesson.id);
    progress(++done, lessonTargets.length, `reading content — ${lesson.title}`);
    return items;
  });
  endProgress();

  const upstreamItemsByLessonId = new Map();
  lessonTargets.forEach((lesson, i) => {
    upstreamItemsByLessonId.set(lesson.id, new Map(itemsPerLesson[i].map(item => [item.id, item])));
  });

  // Plan. Pure from here on.
  const actions = [];
  const warnings = [];
  const summaries = [];

  locals.forEach((local, i) => {
    const upstreamCourse = upstreamCourseById.get(local.courseDetails.id);
    if (!upstreamCourse) {
      warnings.push(
        `course ${local.courseDetails.id} ("${local.courseFolder}") is not in the Skilljar catalog — pull to reconcile`
      );
      return;
    }

    const plan = planCourse({
      courseDir: local.courseFolder,
      courseDetails: local.courseDetails,
      lessons: local.lessons,
      upstreamCourse,
      upstreamLessonsById: new Map(lessonsPerCourse[i].map(l => [l.id, l])),
      upstreamItemsByLessonId,
      localHtmlByItemId: local.localHtmlByItemId,
      lessonFilter: argv.lesson || null
    });

    // Carry the course through on each action so the apply phase can write
    // lessons-meta.json back without re-deriving where it came from.
    for (const action of plan.actions) actions.push({ ...action, local });
    warnings.push(...plan.warnings);
    summaries.push({
      title: local.courseDetails.title,
      changes: plan.actions.length,
      inSync: plan.inSyncCount
    });
  });

  return { actions, warnings, summaries };
}

// ---------------------------------------------------------------------------
// Apply phase
// ---------------------------------------------------------------------------

async function applyTextAction(action) {
  // Titles use their own --force-titles flag rather than --force, since a
  // title is more visible and consequential than a content-item HTML tweak
  // and warrants a separate, explicit opt-in out of unprompted pushes.
  let shouldUpdate = argv['force-titles'];
  if (!shouldUpdate) {
    const answer = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Push local change to ${action.label}? ("${action.upstreamValue}" → "${action.localValue}")`,
      default: false
    }]);
    shouldUpdate = answer.confirm;
  }

  if (!shouldUpdate) {
    console.log(skip(`Skipped ${action.label}`));
    return false;
  }

  // failCleanly() exits. Stopping at the first failed write is the point:
  // the operator has been answering prompts one at a time, and carrying on
  // past a failure would report later successes as if this one had worked.
  try {
    await client.patch(action.endpoint, { [action.field]: action.localValue });
  } catch (err) {
    failCleanly(err, `Could not update ${action.label}.`);
  }
  console.log(ok(`Updated ${action.label}`));
  return true;
}

async function applyContentAction(action) {
  let shouldUpdate = argv.force;
  if (!shouldUpdate) {
    const answer = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Push local changes to ${action.label}?`,
      default: false
    }]);
    shouldUpdate = answer.confirm;
  }

  if (!shouldUpdate) {
    console.log(skip(`Skipped ${action.label}`));
    return false;
  }

  try {
    await client.put(action.endpoint, {
      lesson_id: action.lessonId,
      content_html: action.localValue,
      type: 'HTML'
    });
  } catch (err) {
    failCleanly(err, `Could not update ${action.label}.`);
  }
  console.log(ok(`Updated ${action.label}`));

  if (argv['add-last-updated']) {
    const today = new Date().toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    });
    const newDescription = `<p>Last updated: ${today}.</p>`;

    try {
      await client.patch(`/lessons/${action.lessonId}`, { description_html: newDescription });
    } catch (err) {
      // The content-item write above has already landed. Stopping here
      // leaves the lesson's "Last updated" stamp behind the content it
      // describes, which is visible and fixable; carrying on would write
      // that stamp into lessons-meta.json as though it had been accepted
      // upstream.
      failCleanly(err, `Updated ${action.label}, but could not stamp lesson ${action.lessonId} as updated.`);
    }

    action.lesson.description_html = newDescription; // update in-memory object
    action.local.stampedLessons = true;
    console.log(muted(`  stamped lesson ${action.lessonId} with 'Last updated: ${today}'`));
  }

  return true;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

(async () => {
  const coursesDir = process.env.COURSE_CONTENT_PATH || path.join(__dirname, '..', 'local-skilljar');

  // Guard the content repo's branch, not syncjar's — the stale content that
  // would overwrite Skilljar lives in coursesDir. --dry-run and --diff-only
  // never write upstream, so they run from any branch.
  if (!argv['dry-run'] && !argv['diff-only']) {
    const allowedBranches = [...DEFAULT_ALLOWED_BRANCHES, ...argv['allow-branch']];
    const branch = getCurrentBranch(coursesDir);

    if (!isBranchAllowed(branch, allowedBranches)) {
      const where = branch
        ? `is on branch ${chalk.yellow(branch)}`
        : 'has no branch checked out (detached HEAD, or not a git repo)';

      console.error(chalk.bold.red(`\nRefusing to push: the course content at ${coursesDir} ${where}.`));
      console.error(chalk.gray(
        `\nSkilljar holds one live state and knows nothing about branches, so pushing from a\n` +
        `branch whose content is behind ${DEFAULT_ALLOWED_BRANCHES.join('/')} would silently overwrite live fixes.\n`
      ));
      console.error(`Allowed branches: ${allowedBranches.join(', ')}`);
      console.error(chalk.gray(
        `\nTo preview without writing:   npm run push -- --dry-run\n` +
        (branch ? `To push from this branch:     npm run push -- --allow-branch ${branch}\n` : '')
      ));
      process.exitCode = 1;
      return;
    }
  }

  // A course is a directory. The content root also holds loose JSON files and
  // whatever the operating system leaves behind, and those are not courses
  // that failed to sync. Warning about them taught people to read past a
  // warning that still means something for a real course directory with no
  // metadata, so do not treat them as candidates at all.
  //
  // An explicitly named --course is left alone, because there the warning
  // answers a question the caller actually asked.
  const courseFolders = argv.course
    ? [argv.course]
    : await listCourseDirs(coursesDir);

  const locals = (await Promise.all(
    courseFolders.map(folder => readLocalCourse(coursesDir, folder))
  )).filter(Boolean);

  if (locals.length === 0) {
    console.log(chalk.yellow('Nothing to scan.'));
    return;
  }

  console.log(heading(`\nScanning ${locals.length} course(s)…`));
  const started = Date.now();
  const { actions, warnings, summaries } = await scan(locals);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const totalInSync = summaries.reduce((n, s) => n + s.inSync, 0);
  console.log(chalk.gray(
    `   ${totalInSync} item(s) already in sync, ${actions.length} change(s) found in ${elapsed}s\n`
  ));

  for (const warning of warnings) console.warn(warn(warning));
  if (warnings.length) console.log();

  if (actions.length === 0) {
    console.log(ok(chalk.bold('Everything is in sync.')));
    return;
  }

  // The whole change list up front, so the operator knows what they are about
  // to be asked about before the first prompt rather than after the last.
  console.log(chalk.bold('Changes to review:'));
  for (const summary of summaries.filter(s => s.changes > 0)) {
    console.log(`  ${change(summary.title)} ${muted(`— ${summary.changes} change(s)`)}`);
  }

  for (const action of actions) {
    console.log(`\n${heading(action.local.courseDetails.title)} ${muted('—')} ${chalk.yellow(action.label)}`);

    if (argv.diff) {
      console.log();
      printDiff(action);
      console.log(); // newline
    }

    if (argv['diff-only']) {
      console.log(skip(`diff only — not writing ${action.label}`));
      continue;
    }

    if (argv['dry-run']) {
      console.log(skip(`dry run — would update ${action.label}`));
      continue;
    }

    if (action.kind === 'text') await applyTextAction(action);
    else await applyContentAction(action);
  }

  // One write per course, after all its stamps have landed upstream.
  if (argv['add-last-updated'] && !argv['dry-run'] && !argv['diff-only']) {
    for (const local of new Set(actions.map(a => a.local))) {
      if (!local.stampedLessons) continue;
      await fs.outputJson(local.lessonsMetaPath, local.lessons, { spaces: 2 });
      console.log(muted(`  wrote ${local.courseFolder}/lessons-meta.json`));
    }
  }

  console.log(ok(chalk.bold('Sync complete.')));
})().catch(err => failCleanly(err, 'Push failed.'));
