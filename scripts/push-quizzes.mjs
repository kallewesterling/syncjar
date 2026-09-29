/**
 * push-quizzes.mjs — create quizzes in Skilljar from local `quiz-new-*.json`.
 *
 * Creating a quiz does not attach it to any lesson, so learners cannot see it
 * and it can be deleted. Attaching is a separate step, left to the Skilljar
 * UI for now: content items have no DELETE, so an attachment cannot be
 * undone through the API.
 *
 * For each file: validate, create the quiz, create each question in file
 * order, read the quiz back, and compare. A mismatch or a failed request
 * deletes the quiz it just made. Nothing links to it yet, so that removes it
 * entirely. On success the file is replaced by the pulled form,
 * `quiz-<id>.json`, so the next run does not create it again.
 *
 * Editing existing quizzes is not here yet (see docs/plans/api-coverage.md).
 */
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import inquirer from 'inquirer';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { createSkilljarClient, failCleanly } from './skilljar-client.mjs';
import { fetchQuizzes, fetchQuizQuestions } from './skilljar-fetch.mjs';
import { isNewQuizFile, quizFileName, buildQuizFile } from './quiz-files.mjs';
import {
  validateNewQuiz,
  buildQuizRequest,
  buildQuestionRequests,
  verifyCreatedQuiz,
  createRequestCount
} from './quiz-create.mjs';
import { DEFAULT_ALLOWED_BRANCHES, getCurrentBranch, isBranchAllowed } from './branch-guard.mjs';
import { ok, warn, skip, muted, heading } from './ui.mjs';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = yargs(hideBin(process.argv))
  .option('dry-run', { type: 'boolean', default: false, description: 'Validate and show what would be created; write nothing' })
  .option('force', { type: 'boolean', default: false, description: 'Create without asking about each quiz' })
  .option('file', { type: 'string', description: 'Only this quiz-new-*.json file' })
  .option('allow-branch', { type: 'array', string: true, default: [], description: 'Also allow pushing from this content branch' })
  .option('allow-duplicate-name', { type: 'boolean', default: false, description: 'Create even if a quiz with the same name exists' })
  .strict()
  .argv;

const quizContentPath = process.env.QUIZ_CONTENT_PATH
  || path.join(__dirname, '..', 'local-skilljar-quizzes');

let requests = 0;

// Never prints the error object; see CLAUDE.md. Returns status and a short body.
function describe(err) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const detail = typeof body === 'string' ? body.slice(0, 300) : body ? JSON.stringify(body).slice(0, 300) : err?.code || err?.message;
  return status ? `HTTP ${status}: ${detail}` : String(detail);
}

async function createQuiz(client, fileName, file) {
  let quizId = null;

  // Undo a half-made quiz. It is unattached, so deleting it is complete.
  async function rollback(reason) {
    console.error(chalk.red(`✗ ${fileName}: ${reason}`));
    if (!quizId) return;
    try {
      requests++;
      await client.delete(`/quizzes/${quizId}`);
      console.error(chalk.yellow(`  deleted the partly created quiz ${quizId}`));
    } catch (err) {
      console.error(chalk.red(`  could not delete the partly created quiz ${quizId} (${describe(err)}) — delete it in Skilljar`));
    }
  }

  try {
    requests++;
    const { data } = await client.post('/quizzes', buildQuizRequest(file));
    quizId = data.id;

    for (const body of buildQuestionRequests(quizId, file)) {
      requests++;
      await client.post('/quiz-questions', body);
    }

    requests += 2;
    const [{ data: quiz }, questions] = await Promise.all([
      client.get(`/quizzes/${quizId}`),
      fetchQuizQuestions(client, quizId)
    ]);
    const upstream = buildQuizFile(quiz, questions);

    const problems = verifyCreatedQuiz(file, upstream);
    if (problems.length) {
      await rollback(`Skilljar did not store what was sent:\n    ${problems.join('\n    ')}`);
      return false;
    }

    // New file first, then remove the draft, so a crash between the two
    // leaves both rather than neither.
    await fs.outputJson(path.join(quizContentPath, quizFileName(quizId)), upstream, { spaces: 2 });
    await fs.remove(path.join(quizContentPath, fileName));
    console.log(ok(`Created "${file.name}" as quiz ${quizId} — ${file.questions.length} question(s), now ${quizFileName(quizId)}`));
    return true;
  } catch (err) {
    await rollback(describe(err));
    return false;
  }
}

(async () => {
  let names = [];
  try { names = await fs.readdir(quizContentPath); } catch { /* no directory */ }
  let drafts = names.filter(isNewQuizFile).sort();
  if (argv.file) drafts = drafts.filter(name => name === path.basename(argv.file));

  if (drafts.length === 0) {
    console.log(chalk.yellow(argv.file
      ? `No quiz-new-*.json named ${argv.file} in ${quizContentPath}.`
      : `No quiz-new-*.json files in ${quizContentPath}. Nothing to create.`));
    return;
  }

  // Validate everything before writing anything, so one bad file cannot leave
  // a run half done.
  const files = [];
  let invalid = 0;
  for (const name of drafts) {
    let file;
    try {
      file = await fs.readJson(path.join(quizContentPath, name));
    } catch (err) {
      console.error(chalk.red(`✗ ${name}: not valid JSON (${err.message})`));
      invalid++;
      continue;
    }
    const errors = validateNewQuiz(file);
    if (errors.length) {
      console.error(chalk.red(`✗ ${name}:`));
      for (const e of errors) console.error(chalk.red(`    ${e}`));
      invalid++;
      continue;
    }
    files.push({ name, file });
  }
  if (invalid) {
    console.error(chalk.red(`\n${invalid} file(s) need fixing. Nothing was created.`));
    process.exitCode = 1;
    return;
  }

  if (!argv['dry-run']) {
    const allowed = [...DEFAULT_ALLOWED_BRANCHES, ...argv['allow-branch']];
    const branch = getCurrentBranch(quizContentPath);
    if (!isBranchAllowed(branch, allowed)) {
      console.error(chalk.bold.red(`\nRefusing to create quizzes: ${quizContentPath} ` +
        (branch ? `is on branch ${chalk.yellow(branch)}.` : 'is not on a branch (detached HEAD, or not a git repo).')));
      console.error(`Allowed branches: ${allowed.join(', ')}`);
      console.error(chalk.gray(`\nTo check without writing:  npm run push:quizzes -- --dry-run` +
        (branch ? `\nTo create from this branch: npm run push:quizzes -- --allow-branch ${branch}` : '')));
      process.exitCode = 1;
      return;
    }
  }

  const client = createSkilljarClient();

  // A crash after creating a quiz but before renaming its file would leave
  // the draft in place, and running again would create it twice. The name is
  // the only thing to match on, so an existing name stops the run.
  let existing;
  try {
    requests++;
    existing = new Set((await fetchQuizzes(client)).map(q => q.name));
  } catch (err) {
    failCleanly(err, 'Could not list existing quizzes.');
  }
  const clashes = files.filter(({ file }) => existing.has(file.name));
  if (clashes.length && !argv['allow-duplicate-name']) {
    for (const { name, file } of clashes) {
      console.error(chalk.red(`✗ ${name}: a quiz named "${file.name}" already exists in Skilljar`));
    }
    console.error(chalk.gray('\nIf that quiz came from an earlier run, pull to get its file and delete the draft.' +
      '\nIf the names really should match, rerun with --allow-duplicate-name.'));
    process.exitCode = 1;
    return;
  }

  console.log(heading(`\n${files.length} quiz(zes) to create in Skilljar:`));
  for (const { name, file } of files) {
    console.log(`  ${file.name} ${muted(`— ${file.questions.length} question(s), ${createRequestCount(file)} requests (${name})`)}`);
  }
  console.log();

  if (argv['dry-run']) {
    console.log(skip('dry run — nothing created'));
    return;
  }

  let created = 0;
  let failed = 0;
  for (const { name, file } of files) {
    if (!argv.force) {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Create "${file.name}" (${file.questions.length} question(s))?`,
        default: false
      }]);
      if (!confirm) {
        console.log(skip(`Skipped ${name}`));
        continue;
      }
    }
    if (await createQuiz(client, name, file)) created++;
    else failed++;
  }

  console.log(muted(`\n${requests} request(s).`));
  if (created) {
    console.log(warn('New quizzes are not attached to any lesson. Add each one to its lesson in Skilljar.'));
  }
  if (failed) process.exitCode = 1;
})().catch(err => failCleanly(err, 'Creating quizzes failed.'));
