/**
 * quiz-select.mjs — which quiz files a push:quizzes run has to answer for.
 *
 * A pulled quiz file is Skilljar's own state written to disk, and Skilljar
 * holds quizzes this tool could not have created: empty descriptions, survey
 * questions with no correct answer, LINEAR_SCALE questions, empty "Untitled
 * Quiz" shells. Holding every such file to the rules for a new quiz made each
 * run fail on quizzes nobody had touched. So the rules follow the writes:
 *
 * - A draft (`quiz-new-*.json`) is always written, so every draft is checked
 *   before anything is written, and one bad draft stops the run.
 * - A pulled file is checked when it would be written: when its edit plan
 *   against a fresh read of Skilljar has changes. A failure then refuses
 *   that quiz alone. A pulled file that matches Skilljar is never written,
 *   so its problems are reported as warnings and nothing more.
 *
 * "Matches Skilljar" comes from the read push already makes to plan an edit,
 * so it costs no extra request. A file skipped as unchanged since its last
 * verified push was proven to match then, and is treated the same way.
 *
 * Makes no requests.
 */
import path from 'path';
import { isNewQuizFile, quizFileName } from '#lib/content/quiz-files.mjs';
import { validateNewQuiz, validateEditedQuiz } from '#lib/push/quiz-create.mjs';
import { hasChanges } from '#lib/push/quiz-plan.mjs';

const QUIZ_FILE = /^quiz-(.+)\.json$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The quiz files in a directory listing, sorted, and limited to `only` when given (`--file`). */
export function selectQuizFileNames(names, only) {
  const quizNames = names.filter(n => QUIZ_FILE.test(n)).sort();
  return only ? quizNames.filter(n => n === path.basename(only)) : quizNames;
}

/**
 * Problems that stop a pulled file from being compared with Skilljar at all.
 * A pull never writes a file like this, so it has been edited, and since it
 * can't be planned it can't be pushed.
 */
export function pulledShapeProblems(name, file) {
  if (!isObject(file)) return ['the file is not a JSON object'];
  const problems = [];
  if (typeof file.id !== 'string' || file.id.trim() === '') {
    problems.push('has no "id"; an existing quiz file keeps the id it was pulled with');
  } else if (name !== quizFileName(file.id)) {
    problems.push(`holds quiz ${file.id}, but is named ${name}; expected ${quizFileName(file.id)}`);
  }
  if (!Array.isArray(file.questions)) {
    problems.push('"questions" must be a list');
  } else {
    file.questions.forEach((question, i) => {
      if (!isObject(question)) problems.push(`question ${i + 1} is not an object`);
      else if (question.answers != null && !Array.isArray(question.answers)) {
        problems.push(`question ${i + 1}: "answers" must be a list`);
      }
    });
  }
  return problems;
}

/**
 * Sorts what was read from the quiz directory. `entries` is
 * `[{ name, file }]`, or `[{ name, readError }]` for a file that isn't JSON.
 *
 * - `drafts`: valid drafts, `[{ name, file }]`.
 * - `invalidDrafts`: `[{ name, problems }]`. Any one stops the run.
 * - `pulled`: `[{ name, file, problems }]`, files that can be compared with
 *   Skilljar. `problems` is what validation found, and only matters if the
 *   comparison finds changes.
 * - `unreadable`: `[{ name, problems }]`, pulled files that can't be
 *   compared. Each is refused, and the others go ahead.
 */
export function sortQuizFiles(entries) {
  const out = { drafts: [], invalidDrafts: [], pulled: [], unreadable: [] };
  for (const { name, file, readError } of entries) {
    if (isNewQuizFile(name)) {
      const problems = readError ? [readError] : validateNewQuiz(file);
      if (problems.length) out.invalidDrafts.push({ name, problems });
      else out.drafts.push({ name, file });
      continue;
    }
    const shape = readError ? [readError] : pulledShapeProblems(name, file);
    if (shape.length) out.unreadable.push({ name, problems: shape });
    else out.pulled.push({ name, file, problems: validateEditedQuiz(file) });
  }
  return out;
}

/**
 * Splits pulled files once each has been planned against Skilljar.
 * `scanned` is `[{ name, file, problems, upstream, plan }]`.
 *
 * - `changed`: would be edited, and passes the checks.
 * - `inSync`: matches Skilljar, so nothing is written, whatever its problems.
 * - `refused`: `[{ name, problems, edited }]`. Either the plan itself can't be
 *   applied (`edited: false`), or the file differs from Skilljar and fails
 *   the checks (`edited: true`).
 * - `warnings`: `[{ name, problems }]`, files in `inSync` that would fail the
 *   checks if they were edited.
 */
export function triageScannedQuizzes(scanned) {
  const out = { changed: [], inSync: [], refused: [], warnings: [] };
  for (const entry of scanned) {
    if (entry.plan.problems.length) {
      out.refused.push({ name: entry.name, problems: entry.plan.problems, edited: false });
    } else if (hasChanges(entry.plan)) {
      if (entry.problems.length) out.refused.push({ name: entry.name, problems: entry.problems, edited: true });
      else out.changed.push(entry);
    } else {
      out.inSync.push(entry);
      if (entry.problems.length) out.warnings.push({ name: entry.name, problems: entry.problems });
    }
  }
  return out;
}
