import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { diffWordsWithSpace } from 'diff';
import chalk from 'chalk';
import inquirer from 'inquirer';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { listCourseDirs } from './course-dirs.mjs';
import {
  DEFAULT_ALLOWED_BRANCHES,
  getCurrentBranch,
  isBranchAllowed
} from './branch-guard.mjs';

// __dirname workaround for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLI args
const argv = yargs(hideBin(process.argv))
  .option('course', { type: 'string', describe: 'Course folder slug to sync' })
  .option('lesson', { type: 'string', describe: 'Lesson slug to sync' })
  .option('dry-run', { type: 'boolean', describe: 'Preview changes without syncing' })
  .option('force', { type: 'boolean', describe: 'Sync content-item changes without prompting' })
  .option('force-titles', { type: 'boolean', describe: 'Sync course/lesson title changes without prompting (separate from --force)' })
  .option('diff-only', { type: 'boolean', describe: 'Only show diffs, do not sync' })
  .option('diff', { type: 'boolean', default: true, describe: 'Show diffs before syncing' })
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

// Skilljar and the local copy wrap and indent markup differently without
// anyone editing anything, so comparing them literally reports changes nobody
// made. Collapsing runs of whitespace removes that noise.
//
// Inside <pre>, whitespace is the content. A YAML block indented with tabs and
// the same block indented with spaces are different documents, because YAML
// forbids the tab, and a reader who copies the first one gets a parse error.
// Collapsing there reports such a block as already in sync, so the fix can
// never be pushed. Keep those spans exactly, and settle only line endings,
// which change in transport rather than in an edit.
function normalizeHtml(html = '') {
  // Odd indices are the captured <pre> spans; even indices are everything else.
  return String(html)
    .split(/(<pre\b[\s\S]*?<\/pre>)/i)
    .map((part, i) =>
      i % 2 ? part.replace(/\r\n?/g, '\n') : part.replace(/\s+/g, ' '))
    .join('')
    .trim();
}

// normalizeHtml collapses each block of markup onto one long line, so a
// line-level diff flags any real edit as "whole line removed, whole line
// added" — the reader can't tell what actually changed without eyeballing
// two giant strings. Word-level diffing highlights just the words that
// changed, wherever they fall in the line.
const CONTEXT_CHARS = 60;

// Unchanged spans between edits can still be huge (a full paragraph either
// side of a one-word fix), so trim anything past a small window around each
// change rather than flooding the terminal with text nobody needs to review.
function elideContext(text) {
  if (text.length <= CONTEXT_CHARS * 2 + 20) return text;
  const skipped = text.length - CONTEXT_CHARS * 2;
  return `${text.slice(0, CONTEXT_CHARS)}…[${skipped} unchanged chars]…${text.slice(-CONTEXT_CHARS)}`;
}

function printDiff(oldValue, newValue) {
  const parts = diffWordsWithSpace(oldValue || '', newValue || '');
  for (const part of parts) {
    if (part.removed) {
      process.stdout.write(chalk.bgRed.white(part.value));
    } else if (part.added) {
      process.stdout.write(chalk.bgGreen.black(part.value));
    } else {
      process.stdout.write(chalk.gray(elideContext(part.value)));
    }
  }
  process.stdout.write('\n');
}

// Diffs a plain text field (e.g. a title) against its upstream value and,
// depending on the --diff/--diff-only/--dry-run/--force-titles flags, prompts
// before PATCHing `endpoint` with `{ [field]: localValue }`. Titles use their
// own --force-titles flag rather than --force, since a title is more visible
// and consequential than a content-item HTML tweak and warrants a separate,
// explicit opt-in out of unprompted pushes.
async function syncTextField({ label, endpoint, field, localValue, upstreamValue }) {
  if ((localValue || '').trim() === (upstreamValue || '').trim()) {
    console.log(`✅ ${label} is in sync.`);
    return;
  }

  console.log(`❗ Difference detected in ${chalk.yellow(label)}`);

  if (argv.diff) {
    console.log(chalk.gray('📄 Showing unified diff:\n'));
    printDiff(upstreamValue, localValue);
    console.log(); // newline
  }

  if (argv['diff-only']) {
    console.log(chalk.gray(`🔍 DIFF ONLY: Skipping ${label}\n`));
    return;
  }

  if (argv['dry-run']) {
    console.log(chalk.gray(`🔍 DRY RUN: Would update ${label}\n`));
    return;
  }

  let shouldUpdate = argv['force-titles'];
  if (!shouldUpdate) {
    const answer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Push local change to ${label}? ("${upstreamValue}" → "${localValue}")`,
        default: false
      }
    ]);
    shouldUpdate = answer.confirm;
  }

  if (shouldUpdate) {
    // failCleanly() exits. Stopping at the first failed write is the point:
    // the operator has been answering prompts one at a time, and carrying on
    // past a failure would report later successes as if this one had worked.
    try {
      await client.patch(endpoint, { [field]: localValue });
    } catch (err) {
      failCleanly(err, `Could not update ${label}.`);
    }
    console.log(chalk.green(`✅ Updated ${label}`));
  } else {
    console.log(chalk.gray(`⏭️ Skipped ${label}`));
  }
}

async function syncCourse(courseFolder) {
  const courseDir = path.join(process.env.COURSE_CONTENT_PATH, courseFolder) || path.join(__dirname, '..', 'local-skilljar', courseFolder);
  const detailsPath = path.join(courseDir, 'details.json');
  const lessonsMetaPath = path.join(courseDir, 'lessons-meta.json');

  if (!(await fs.pathExists(detailsPath)) || !(await fs.pathExists(lessonsMetaPath))) {
    console.warn(`⚠️ Skipping course "${courseFolder}" — missing details or metadata`);
    return;
  }

  const courseDetails = await fs.readJson(detailsPath);
  const lessons = await fs.readJson(lessonsMetaPath);

  if (!argv.lesson) {
    let upstreamCourse;
    try {
      ({ data: upstreamCourse } = await client.get(`/courses/${courseDetails.id}`));
    } catch (err) {
      failCleanly(err, `Could not fetch course ${courseDetails.id} ("${courseDetails.title}") to diff against.`);
    }
    await syncTextField({
      label: `course title (${courseDetails.title})`,
      endpoint: `/courses/${courseDetails.id}`,
      field: 'title',
      localValue: courseDetails.title,
      upstreamValue: upstreamCourse.title
    });
  }

  for (const lesson of lessons) {
    if (argv.lesson && lesson.slug !== argv.lesson) continue;

    console.log(`\n📘 Lesson: ${chalk.bold(courseDetails.title)} ${chalk.cyan(lesson.title)}`);

    let upstreamLesson;
    try {
      ({ data: upstreamLesson } = await client.get(`/lessons/${lesson.id}`));
    } catch (err) {
      failCleanly(err, `Could not fetch lesson ${lesson.id} ("${lesson.title}") to diff against.`);
    }
    await syncTextField({
      label: `lesson title (${lesson.title})`,
      endpoint: `/lessons/${lesson.id}`,
      field: 'title',
      localValue: lesson.title,
      upstreamValue: upstreamLesson.title
    });

    for (const item of lesson.content_items) {
      const localPath = path.join(courseDir, item.file);
      const upstreamEndpoint = `/lessons/${lesson.id}/content-items/${item.id}`;

      const localHtml = await fs.readFile(localPath, 'utf8');
      let upstreamItem;
      try {
        ({ data: upstreamItem } = await client.get(upstreamEndpoint));
      } catch (err) {
        failCleanly(err, `Could not fetch content-item ${item.id} to diff against.`);
      }

      const localNorm = normalizeHtml(localHtml);
      const upstreamNorm = normalizeHtml(upstreamItem.content_html || '');

      if (localNorm === upstreamNorm) {
        console.log(`✅ content-item ${item.id} is in sync.`);
        continue;
      }

      console.log(`❗ Difference detected in content-item ${chalk.yellow(item.id)}`);

      if (argv.diff) {
        console.log(chalk.gray('📄 Showing unified diff:\n'));
        printDiff(upstreamItem.content_html, localHtml);
        console.log(); // newline
      }

      if (argv['diff-only']) {
        console.log(chalk.gray(`🔍 DIFF ONLY: Skipping content-item ${item.id}\n`));
        continue;
      }

      if (argv['dry-run']) {
        console.log(chalk.gray(`🔍 DRY RUN: Would update content-item ${item.id}\n`));
        continue;
      }

      let shouldUpdate = argv.force;
      if (!argv.force) {
        const answer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Push local changes to content-item ${item.id}?`,
            default: false
          }
        ]);
        shouldUpdate = answer.confirm;
      }

      if (shouldUpdate) {
        try {
          await client.put(upstreamEndpoint, {
            lesson_id: lesson.id,
            content_html: localHtml,
            type: 'HTML'
          });
        } catch (err) {
          failCleanly(err, `Could not update content-item ${item.id}.`);
        }
        console.log(chalk.green(`✅ Updated content-item ${item.id}`));

        if (argv['add-last-updated']) {
          const today = new Date().toLocaleDateString('en-US', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC'
          });

          const newDescription = `<p>Last updated: ${today}.</p>`;

          try {
            await client.patch(`/lessons/${lesson.id}`, {
              description_html: newDescription
            });
          } catch (err) {
            // The content-item write above has already landed. Stopping here
            // leaves the lesson's "Last updated" stamp behind the content it
            // describes, which is visible and fixable; carrying on would
            // write that stamp into lessons-meta.json as though it had been
            // accepted upstream.
            failCleanly(err, `Updated content-item ${item.id}, but could not stamp lesson ${lesson.id} as updated.`);
          }

          lesson.description_html = newDescription; // 🔥 update in-memory object

          console.log(chalk.cyan(`📝 Updated lesson metadata with 'Last updated: ${today}'`));
        }
      } else {
        console.log(chalk.gray(`⏭️ Skipped content-item ${item.id}`));
      }

    }
  }

  if (argv['add-last-updated']) {
    await fs.outputJson(lessonsMetaPath, lessons, { spaces: 2 });
    console.log(chalk.gray(`📁 Updated lessons-meta.json to reflect updated metadata.`));
  }
}

// MAIN
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

      console.error(chalk.bold.red(`\n⛔ Refusing to push: the course content at ${coursesDir} ${where}.`));
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

  for (const courseFolder of courseFolders) {
    await syncCourse(courseFolder);
  }

  console.log(chalk.bold.green('\n✨ Sync complete.'));
})().catch(err => failCleanly(err, 'Push failed.'));
