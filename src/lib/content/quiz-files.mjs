/**
 * quiz-files.mjs — the on-disk form of a quiz, and which lessons point at it.
 *
 * Quizzes live in their own directory, `QUIZ_CONTENT_PATH`, one file per quiz
 * (`quiz-<id>.json`), next to the course and path directories rather than
 * inside a course. A quiz belongs to the organisation, not to a course: one
 * quiz is often linked from lessons in several courses (a bundle course and
 * the courses it bundles, say), and a copy per course would give push several
 * sources of truth for one upstream object. Lessons point at a quiz through
 * the `content_quiz_id` in their `non_html_items`.
 *
 * Array order in `questions` is the quiz's order. Upstream order is creation
 * order and cannot be set (see CLAUDE.md, "Quiz writes"), so the file does not
 * carry an `order` field that would suggest otherwise.
 */

export function quizFileName(quizId) {
  return `quiz-${quizId}.json`;
}

const QUIZ_FILE_PATTERN = /^quiz-(.+)\.json$/;

// `quiz-new-*.json` is a quiz authored locally and not yet created upstream.
// It has no id to match, so it is never reported as stale.
export function isNewQuizFile(fileName) {
  return fileName.startsWith('quiz-new-') && fileName.endsWith('.json');
}

export const QUIZ_SETTINGS = [
  'passing_percentage_correct',
  'show_results_on_failure',
  'max_attempts',
  'require_correct_response',
  'randomize_questions',
  'limit_question_count',
  'randomize_answers',
  'time_limit_seconds',
  'show_question_feedback',
  'alignment'
];

export const QUESTION_FIELDS = [
  'type',
  'html',
  'requires_manual_grading',
  'case_sensitive',
  'correct_answer_feedback_html',
  'incorrect_answer_feedback_html',
  'answer_feedback_html',
  'is_graded',
  'is_optional'
];

// Every field is written, set or not, so each file shows the full set of
// things a quiz can have. That makes a pulled file a usable template for
// writing a new one.
function pickAll(record, fields) {
  const out = {};
  for (const field of fields) out[field] = record[field] ?? null;
  return out;
}

const byOrderThenId = (a, b) =>
  (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id));

export function buildQuizFile(quiz, questions) {
  return {
    id: quiz.id,
    name: quiz.name ?? '',
    html: quiz.html ?? '',
    ...pickAll(quiz, QUIZ_SETTINGS),
    questions: [...questions].sort(byOrderThenId).map(question => ({
      id: question.id,
      ...pickAll(question, QUESTION_FIELDS),
      answers: [...(question.answers ?? [])].sort(byOrderThenId).map(answer => ({
        id: answer.id,
        answer_text: answer.answer_text,
        correct: Boolean(answer.correct)
      }))
    }))
  };
}

/**
 * Every quiz id linked from these lesson entries. Reads both forms: a `QUIZ`
 * content item in a MODULAR lesson, and the legacy `QUIZ`-type lesson that
 * carries the id itself.
 */
export function collectLinkedQuizIds(lessonEntries) {
  const ids = new Set();
  for (const lesson of lessonEntries) {
    if (lesson.content_quiz_id) ids.add(lesson.content_quiz_id);
    for (const item of lesson.non_html_items ?? []) {
      if (item.type === 'QUIZ' && item.content_quiz_id) ids.add(item.content_quiz_id);
    }
  }
  return ids;
}

/**
 * Whether any question bank is used by any quiz. When none is, the per-quiz
 * bank check can be skipped entirely, which saves one request per quiz.
 */
export function banksInUse(banks) {
  return banks.some(bank => (bank.quiz_association_count ?? 1) > 0);
}

/**
 * Local quiz files whose quiz no longer exists upstream. They are reported
 * rather than deleted, since the file may be the only copy left.
 */
export function findStaleQuizFiles(fileNames, upstreamIds) {
  return fileNames
    .filter(name => !isNewQuizFile(name))
    .filter(name => {
      const match = QUIZ_FILE_PATTERN.exec(name);
      return match && !upstreamIds.has(match[1]);
    })
    .sort();
}
