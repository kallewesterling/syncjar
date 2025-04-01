import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { diffLines } from 'diff';
import chalk from 'chalk';
import inquirer from 'inquirer';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// __dirname workaround for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLI args
const argv = yargs(hideBin(process.argv))
  .option('course', { type: 'string', describe: 'Course folder slug to sync' })
  .option('lesson', { type: 'string', describe: 'Lesson slug to sync' })
  .option('dry-run', { type: 'boolean', describe: 'Preview changes without syncing' })
  .option('force', { type: 'boolean', describe: 'Sync all changes without prompting' })
  .option('diff-only', { type: 'boolean', describe: 'Only show diffs, do not sync' })
  .option('diff', { type: 'boolean', default: true, describe: 'Show diffs before syncing' })
  .help()
  .argv;

// Load Skilljar auth
import dotenv from 'dotenv';
dotenv.config();

const client = axios.create({
  baseURL: 'https://api.skilljar.com/v1',
  auth: {
    username: process.env.SKILLJAR_API_KEY,
    password: ''
  }
});

function normalizeHtml(html = '') {
  return html.trim().replace(/\s+/g, ' ');
}

async function syncCourse(courseFolder) {
  const courseDir = path.join(__dirname, '..', 'local-skilljar', courseFolder);
  const detailsPath = path.join(courseDir, 'details.json');
  const lessonsMetaPath = path.join(courseDir, 'lessons-meta.json');

  if (!(await fs.pathExists(detailsPath)) || !(await fs.pathExists(lessonsMetaPath))) {
    console.warn(`⚠️ Skipping course "${courseFolder}" — missing details or metadata`);
    return;
  }

  const courseDetails = await fs.readJson(detailsPath);
  const lessons = await fs.readJson(lessonsMetaPath);

  for (const lesson of lessons) {
    if (argv.lesson && lesson.slug !== argv.lesson) continue;

    console.log(`\n📘 Lesson: ${chalk.bold(courseDetails.title)} ${chalk.cyan(lesson.title)}`);

    for (const item of lesson.content_items) {
      const localPath = path.join(courseDir, item.file);
      const upstreamEndpoint = `/lessons/${lesson.id}/content-items/${item.id}`;

      const localHtml = await fs.readFile(localPath, 'utf8');
      const { data: upstreamItem } = await client.get(upstreamEndpoint);

      const localNorm = normalizeHtml(localHtml);
      const upstreamNorm = normalizeHtml(upstreamItem.content_html || '');

      if (localNorm === upstreamNorm) {
        console.log(`✅ content-item ${item.id} is in sync.`);
        continue;
      }

      console.log(`❗ Difference detected in content-item ${chalk.yellow(item.id)}`);

      if (argv.diff) {
        console.log(chalk.gray('📄 Showing unified diff:\n'));

        const diff = diffLines(upstreamItem.content_html || '', localHtml || '');

        for (const part of diff) {
          const symbol = part.added ? '+' : part.removed ? '-' : ' ';
          const color = part.added
            ? chalk.green
            : part.removed
              ? chalk.red
              : chalk.gray;

          process.stdout.write(color(`${symbol} ${part.value}`));
        }

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
        await client.put(upstreamEndpoint, {
          lesson_id: lesson.id,
          content_html: localHtml,
          type: 'HTML'
        });
        console.log(chalk.green(`✅ Updated content-item ${item.id}`));
      } else {
        console.log(chalk.gray(`⏭️ Skipped content-item ${item.id}`));
      }

    }
  }
}

// MAIN
(async () => {
  const coursesDir = path.join(__dirname, '..', 'local-skilljar');
  const courseFolders = argv.course
    ? [argv.course]
    : await fs.readdir(coursesDir);

  for (const courseFolder of courseFolders) {
    await syncCourse(courseFolder);
  }

  console.log(chalk.bold.green('\n✨ Sync complete.'));
})();
