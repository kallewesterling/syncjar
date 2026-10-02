/**
 * push-quizzes.mjs — push local quiz files to Skilljar.
 *
 * Two kinds of file in QUIZ_CONTENT_PATH:
 *
 * - `quiz-new-*.json`, a draft. It's created: the quiz, then each question
 *   in file order, then read back and compared. A half-made quiz is deleted.
 *   With `--attach <lesson_id>` (and `--file`), the new quiz is also added to
 *   that lesson. That can't be undone through the API, so it only happens when
 *   asked for by name.
 * - `quiz-<id>.json`, a pulled quiz. It's compared with upstream and edited
 *   to match (see quiz-plan.mjs). Edits that keep question ids are ordinary
 *   prompted changes. Edits that recreate or remove questions cost those
 *   questions' response history and learners' review of past answers, so they
 *   are shown as such, are all-or-nothing per quiz, and need an interactive
 *   yes or `--recreate <quiz_id>`. `--force` never covers them.
 *
 * Every write is read back. A 200 from Skilljar's quiz API does not prove the
 * write happened (see CLAUDE.md, "Quiz writes").
 */
import fs from 'fs-extra';
import path from 'path';
import { repoRoot } from '#lib/paths.mjs';
import chalk from 'chalk';
import inquirer from 'inquirer';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { createSkilljarClient, failCleanly } from '#lib/skilljar/client.mjs';
import { fetchQuizzes, fetchQuizQuestions, fetchContentItems } from '#lib/skilljar/fetch.mjs';
import { mapWithConcurrency } from '#lib/concurrency.mjs';
import { isNewQuizFile, quizFileName, buildQuizFile } from '#lib/content/quiz-files.mjs';
import {
  validateNewQuiz,
  validateEditedQuiz,
  buildQuizRequest,
  buildQuestionRequests,
  verifyCreatedQuiz,
  createRequestCount
} from '#lib/push/quiz-create.mjs';
import {
  planQuizEdit,
  hasChanges,
  isDestructive,
  editRequestCount,
  quizPatchBody,
  questionPatchBody,
  questionBody,
  describePlan,
  fingerprintQuizFile
} from '#lib/push/quiz-plan.mjs';
import { DEFAULT_ALLOWED_BRANCHES, getCurrentBranch, isBranchAllowed } from '#lib/branch-guard.mjs';
import { ok, warn, skip, muted, heading } from '#lib/ui.mjs';

dotenv.config();

const argv = yargs(hideBin(process.argv))
  .option('dry-run', { type: 'boolean', default: false, description: 'Validate and show what would change; write nothing' })
  .option('force', { type: 'boolean', default: false, description: 'Apply creates and in-place edits without asking. Never covers recreating or removing questions' })
  .option('file', { type: 'string', description: 'Only this quiz file' })
  .option('attach', { type: 'string', description: 'Lesson id to add the new quiz to (needs --file with a quiz-new-*.json). Cannot be undone through the API' })
  .option('recreate', { type: 'array', string: true, default: [], description: 'Allow recreating or removing questions in this quiz id without a prompt' })
  .option('full-scan', { type: 'boolean', default: false, description: 'Compare every quiz file, including ones unchanged since the last verified push' })
  .option('state-file', { type: 'string', default: '.syncjar-quiz-state.json', description: 'Where verified quiz fingerprints are kept' })
  .option('allow-branch', { type: 'array', string: true, default: [], description: 'Also allow pushing from this content branch' })
  .option('allow-duplicate-name', { type: 'boolean', default: false, description: 'Create even if a quiz with the same name exists' })
  .strict()
  .argv;

const quizContentPath = process.env.QUIZ_CONTENT_PATH
  || path.join(repoRoot, 'local-skilljar-quizzes');

const QUIZ_FILE = /^quiz-(.+)\.json$/;
const READ_CONCURRENCY = 6;
let requests = 0;

// Never prints the error object; see CLAUDE.md. Returns status and a short body.
function describe(err) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const detail = typeof body === 'string' ? body.slice(0, 300) : body ? JSON.stringify(body).slice(0, 300) : err?.code || err?.message;
  return status ? `HTTP ${status}: ${detail}` : String(detail);
}

async function call(fn) {
  requests++;
  return fn();
}

async function readUpstream(client, quizId) {
  const [{ data: quiz }, questions] = await Promise.all([
    call(() => client.get(`/quizzes/${quizId}`)),
    (requests++, fetchQuizQuestions(client, quizId))
  ]);
  return buildQuizFile(quiz, questions);
}

async function readState(file) {
  try {
    const state = await fs.readJson(file);
    return { quizzes: state.quizzes ?? {} };
  } catch {
    return { quizzes: {} };
  }
}

function record(state, id, file) {
  state.quizzes[id] = { fingerprint: fingerprintQuizFile(file), verifiedAt: new Date().toISOString() };
}

async function confirm(message) {
  if (!process.stdin.isTTY) return false;
  const { yes } = await inquirer.prompt([{ type: 'confirm', name: 'yes', message, default: false }]);
  return yes;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

async function createQuiz(client, fileName, file, attachTo) {
  let quizId = null;

  async function rollback(reason) {
    console.error(chalk.red(`✗ ${fileName}: ${reason}`));
    if (!quizId) return;
    try {
      await call(() => client.delete(`/quizzes/${quizId}`));
      console.error(chalk.yellow(`  deleted the partly created quiz ${quizId}`));
    } catch (err) {
      console.error(chalk.red(`  could not delete the partly created quiz ${quizId} (${describe(err)}) — delete it in Skilljar`));
    }
  }

  let upstream;
  try {
    const { data } = await call(() => client.post('/quizzes', buildQuizRequest(file)));
    quizId = data.id;
    for (const body of buildQuestionRequests(quizId, file)) {
      await call(() => client.post('/quiz-questions', body));
    }
    upstream = await readUpstream(client, quizId);
    const problems = verifyCreatedQuiz(file, upstream);
    if (problems.length) {
      await rollback(`Skilljar did not store what was sent:\n    ${problems.join('\n    ')}`);
      return null;
    }
  } catch (err) {
    await rollback(describe(err));
    return null;
  }

  // New file first, then remove the draft, so a crash between the two
  // leaves both rather than neither.
  await fs.outputJson(path.join(quizContentPath, quizFileName(quizId)), upstream, { spaces: 2 });
  await fs.remove(path.join(quizContentPath, fileName));
  console.log(ok(`Created "${file.name}" as quiz ${quizId} — ${file.questions.length} question(s), now ${quizFileName(quizId)}`));

  if (attachTo) await attachQuiz(client, quizId, file.name, attachTo);
  return upstream;
}

// The quiz exists and is verified by now, so a failure here leaves a correct,
// unattached quiz, which is the state a create without --attach ends in.
// Skilljar rejects a blank header on create, although lessons attached in its
// UI can have one, so the quiz name is used.
async function attachQuiz(client, quizId, header, lessonId) {
  try {
    const items = await (requests++, fetchContentItems(client, lessonId));
    const order = items.reduce((max, i) => Math.max(max, i.order ?? 0), 0) + 1;
    await call(() => client.post(`/lessons/${lessonId}/content-items`, {
      type: 'QUIZ', content_quiz_id: quizId, header, order
    }));
    const after = await (requests++, fetchContentItems(client, lessonId));
    if (!after.some(i => i.type === 'QUIZ' && i.content_quiz_id === quizId)) {
      console.error(chalk.red(`✗ quiz ${quizId} was not found in lesson ${lessonId} after attaching — check the lesson in Skilljar`));
      process.exitCode = 1;
      return;
    }
    console.log(ok(`Attached quiz ${quizId} to lesson ${lessonId}, as item ${order}. Pull to record it in lessons-meta.json.`));
  } catch (err) {
    console.error(chalk.red(`✗ quiz ${quizId} was created but not attached to lesson ${lessonId}: ${describe(err)}`));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

/**
 * Applies one quiz's plan, then verifies it. Returns the verified upstream
 * file, or null. A failure while creating questions removes the ones this run
 * created, since they're new and have no history. A failure while deleting is
 * reported, because by then the replacements exist and the quiz has extras.
 */
async function applyEdit(client, local, plan) {
  const quizId = local.id;
  const label = `"${local.name}" (${quizId})`;
  const created = [];

  try {
    if (Object.keys(plan.quizPatch).length) {
      await call(() => client.patch(`/quizzes/${quizId}`, quizPatchBody(plan)));
    }
    for (const patch of plan.questionPatches) {
      await call(() => client.patch(`/quiz-questions/${patch.id}`, questionPatchBody(quizId, patch)));
    }
  } catch (err) {
    console.error(chalk.red(`✗ ${label}: an in-place edit failed (${describe(err)}). Nothing was recreated or deleted. Pull to see where it stands.`));
    return null;
  }

  try {
    for (const create of plan.creates) {
      const { data } = await call(() => client.post('/quiz-questions', questionBody(quizId, create.question)));
      created.push(data.id);
    }
  } catch (err) {
    console.error(chalk.red(`✗ ${label}: creating a question failed (${describe(err)}).`));
    for (const id of created) {
      try {
        await call(() => client.delete(`/quiz-questions/${id}`));
      } catch (deleteErr) {
        console.error(chalk.red(`  could not remove new question ${id} (${describe(deleteErr)}) — remove it in Skilljar`));
      }
    }
    console.error(chalk.yellow(`  removed the ${created.length} question(s) this run had added; no existing question was deleted`));
    return null;
  }

  for (const del of plan.deletes) {
    try {
      await call(() => client.delete(`/quiz-questions/${del.id}`));
    } catch (err) {
      console.error(chalk.red(`✗ ${label}: could not delete question ${del.id} (${describe(err)}). Its replacement already exists, so the quiz now has an extra question. Delete ${del.id} in Skilljar, then pull.`));
      return null;
    }
  }

  const upstream = await readUpstream(client, quizId);
  const problems = verifyCreatedQuiz(local, upstream);
  if (problems.length) {
    console.error(chalk.red(`✗ ${label}: Skilljar does not match the file after the edit:\n    ${problems.join('\n    ')}\n  Pull to see where it stands.`));
    return null;
  }
  return upstream;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

(async () => {
  let names = [];
  try { names = await fs.readdir(quizContentPath); } catch { /* no directory */ }
  names = names.filter(n => QUIZ_FILE.test(n)).sort();
  if (argv.file) names = names.filter(n => n === path.basename(argv.file));

  if (names.length === 0) {
    console.log(chalk.yellow(argv.file
      ? `No quiz file named ${argv.file} in ${quizContentPath}.`
      : `No quiz files in ${quizContentPath}. Nothing to do.`));
    return;
  }

  if (argv.attach && !(argv.file && isNewQuizFile(path.basename(argv.file)))) {
    console.error(chalk.red('--attach needs --file naming one quiz-new-*.json, so it is clear which quiz goes where.'));
    process.exitCode = 1;
    return;
  }

  // Validate everything before writing anything.
  const drafts = [];
  const edits = [];
  let invalid = 0;
  for (const name of names) {
    let file;
    try {
      file = await fs.readJson(path.join(quizContentPath, name));
    } catch (err) {
      console.error(chalk.red(`✗ ${name}: not valid JSON (${err.message})`));
      invalid++;
      continue;
    }
    const isDraft = isNewQuizFile(name);
    const errors = isDraft ? validateNewQuiz(file) : validateEditedQuiz(file);
    if (!isDraft && file.id && name !== quizFileName(file.id)) {
      errors.push(`holds quiz ${file.id}, but is named ${name}; expected ${quizFileName(file.id)}`);
    }
    if (errors.length) {
      console.error(chalk.red(`✗ ${name}:`));
      for (const e of errors) console.error(chalk.red(`    ${e}`));
      invalid++;
      continue;
    }
    (isDraft ? drafts : edits).push({ name, file });
  }
  if (invalid) {
    console.error(chalk.red(`\n${invalid} file(s) need fixing. Nothing was written.`));
    process.exitCode = 1;
    return;
  }

  // Skip quiz files unchanged since the last verified push or scan. Skipping
  // never writes, so a wrong skip can only miss drift, which pull reports.
  const stateFile = argv['state-file'];
  const state = await readState(stateFile);
  const toScan = argv['full-scan']
    ? edits
    : edits.filter(({ file }) => state.quizzes[file.id]?.fingerprint !== fingerprintQuizFile(file));
  const skipped = edits.length - toScan.length;

  if (!argv['dry-run']) {
    const allowed = [...DEFAULT_ALLOWED_BRANCHES, ...argv['allow-branch']];
    const branch = getCurrentBranch(quizContentPath);
    if (!isBranchAllowed(branch, allowed)) {
      console.error(chalk.bold.red(`\nRefusing to push quizzes: ${quizContentPath} ` +
        (branch ? `is on branch ${chalk.yellow(branch)}.` : 'is not on a branch (detached HEAD, or not a git repo).')));
      console.error(`Allowed branches: ${allowed.join(', ')}`);
      console.error(chalk.gray(`\nTo check without writing:  npm run push:quizzes -- --dry-run` +
        (branch ? `\nTo push from this branch:   npm run push:quizzes -- --allow-branch ${branch}` : '')));
      process.exitCode = 1;
      return;
    }
  }

  if (drafts.length === 0 && toScan.length === 0) {
    console.log(ok(`Nothing to push — ${skipped} quiz file(s) unchanged since the last verified push (--full-scan to compare anyway).`));
    return;
  }

  const client = createSkilljarClient();

  // One list serves both jobs: names for the duplicate check, and existence
  // for the files being edited.
  let upstreamList;
  try {
    upstreamList = await (requests++, fetchQuizzes(client));
  } catch (err) {
    failCleanly(err, 'Could not list quizzes.');
  }
  const upstreamIds = new Set(upstreamList.map(q => q.id));
  const upstreamNames = new Set(upstreamList.map(q => q.name));

  const clashes = drafts.filter(({ file }) => upstreamNames.has(file.name));
  if (clashes.length && !argv['allow-duplicate-name']) {
    for (const { name, file } of clashes) {
      console.error(chalk.red(`✗ ${name}: a quiz named "${file.name}" already exists in Skilljar`));
    }
    console.error(chalk.gray('\nIf that quiz came from an earlier run, pull to get its file and delete the draft.' +
      '\nIf the names really should match, rerun with --allow-duplicate-name.'));
    process.exitCode = 1;
    return;
  }

  if (argv.attach) {
    try {
      await call(() => client.get(`/lessons/${argv.attach}`));
    } catch (err) {
      failCleanly(err, `Lesson ${argv.attach} could not be read, so nothing was created.`);
    }
  }

  // Plan every edit before applying any.
  const missing = toScan.filter(({ file }) => !upstreamIds.has(file.id));
  for (const { name, file } of missing) {
    console.error(chalk.red(`✗ ${name}: quiz ${file.id} is not in Skilljar any more. Pull to reconcile.`));
  }
  const scanned = await mapWithConcurrency(
    toScan.filter(({ file }) => upstreamIds.has(file.id)),
    READ_CONCURRENCY,
    async (entry) => {
      try {
        const upstream = await readUpstream(client, entry.file.id);
        return { ...entry, upstream, plan: planQuizEdit(entry.file, upstream) };
      } catch (err) {
        failCleanly(err, `Could not read quiz ${entry.file.id}.`);
      }
    }
  );

  let blocked = missing.length;
  const inSync = [];
  const changed = [];
  for (const entry of scanned) {
    if (entry.plan.problems.length) {
      console.error(chalk.red(`✗ ${entry.name}:`));
      for (const p of entry.plan.problems) console.error(chalk.red(`    ${p}`));
      blocked++;
    } else if (hasChanges(entry.plan)) {
      changed.push(entry);
    } else {
      inSync.push(entry);
    }
  }

  // Proven in sync by comparison, whatever mode this is: the state records an
  // observation, not a write.
  for (const { file } of inSync) record(state, file.id, file);

  console.log(heading('\nQuizzes:'));
  if (skipped) console.log(muted(`  ${skipped} unchanged since the last verified push — skipped without a request`));
  if (inSync.length) console.log(muted(`  ${inSync.length} compared and already in sync`));
  for (const { name, file } of drafts) {
    const attach = argv.attach ? `, then attach to lesson ${argv.attach}` : '';
    console.log(`  create "${file.name}" ${muted(`— ${file.questions.length} question(s), ${createRequestCount(file)} requests${attach} (${name})`)}`);
  }
  for (const { file, plan } of changed) {
    const destructive = isDestructive(plan);
    console.log(`  ${destructive ? chalk.yellow('edit, recreating questions') : 'edit'} "${file.name}" ${muted(`— ${editRequestCount(plan)} write(s) + 2 reads (${quizFileName(file.id)})`)}`);
    for (const line of describePlan(plan)) console.log(muted(`      ${line}`));
    if (destructive) {
      console.log(chalk.yellow(`      Recreating or removing ${plan.deletes.length} question(s) drops their response history from quiz analytics,`));
      console.log(chalk.yellow('      and learners who took this quiz can no longer review their answers. Scores and completions are kept.'));
    }
  }
  console.log();

  if (argv['dry-run']) {
    await fs.outputJson(stateFile, state, { spaces: 2 });
    console.log(skip('dry run — nothing written'));
    if (blocked) process.exitCode = 1;
    return;
  }

  let failed = blocked;

  for (const { name, file } of drafts) {
    const attach = argv.attach ? ` and attach it to lesson ${argv.attach} (cannot be undone through the API)` : '';
    if (!argv.force && !(await confirm(`Create "${file.name}" (${file.questions.length} question(s))${attach}?`))) {
      console.log(skip(`Skipped ${name}`));
      continue;
    }
    const upstream = await createQuiz(client, name, file, argv.attach);
    if (upstream) record(state, upstream.id, upstream);
    else failed++;
  }

  for (const { file, plan } of changed) {
    const label = `"${file.name}"`;
    if (isDestructive(plan)) {
      const allowed = argv.recreate.includes(file.id)
        || await confirm(`Edit ${label} and recreate or remove ${plan.deletes.length} question(s)? Their response history and learners' answer review are lost.`);
      if (!allowed) {
        console.log(skip(`Skipped ${label}: it recreates questions. Confirm interactively, or rerun with --recreate ${file.id}.`));
        // Refused rather than declined: the change is still pending, and a
        // script calling this has to be able to tell.
        if (!process.stdin.isTTY) failed++;
        continue;
      }
    } else if (!argv.force && !(await confirm(`Edit ${label} (${editRequestCount(plan)} change(s))?`))) {
      console.log(skip(`Skipped ${label}`));
      if (!process.stdin.isTTY) failed++;
      continue;
    }

    const upstream = await applyEdit(client, file, plan);
    if (!upstream) {
      failed++;
      continue;
    }
    await fs.outputJson(path.join(quizContentPath, quizFileName(file.id)), upstream, { spaces: 2 });
    record(state, file.id, upstream);
    console.log(ok(`Updated ${label} — verified, and ${quizFileName(file.id)} rewritten with Skilljar's ids`));
  }

  await fs.outputJson(stateFile, state, { spaces: 2 });
  console.log(muted(`\n${requests} request(s).`));
  if (drafts.length && !argv.attach) {
    console.log(warn('New quizzes are not attached to any lesson. Add each one to its lesson in Skilljar, or use --attach.'));
  }
  if (failed) process.exitCode = 1;
})().catch(err => failCleanly(err, 'Pushing quizzes failed.'));
