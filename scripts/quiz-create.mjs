/**
 * quiz-create.mjs — check a locally authored quiz, and turn it into requests.
 *
 * A new quiz is a `quiz-new-<slug>.json` file in QUIZ_CONTENT_PATH, in the
 * same shape a pull writes but without ids. Creating it is POST /quizzes,
 * then one POST /quiz-questions per question in file order, because creation
 * order is the only order Skilljar has (see CLAUDE.md, "Quiz writes").
 *
 * Validation is strict because the API is not. It accepts and ignores fields
 * it does not act on, and returns 200 for writes it did not make. So an
 * unknown key is an error here, not a warning: `pasing_percentage_correct`
 * would otherwise be dropped without a trace. Nothing in this module makes a
 * request.
 */
import { QUIZ_SETTINGS, QUESTION_FIELDS } from './quiz-files.mjs';
import { normalizeHtml } from './push-plan.mjs';

export const QUESTION_TYPES = ['MULTIPLE_CHOICE', 'MULTIPLE_ANSWER', 'FILL_IN_THE_BLANK', 'FREEFORM'];
const ALIGNMENTS = ['left', 'center', 'right'];

// Fields a pull writes that describe upstream state rather than anything a
// create can set. Accepted in a new file, so that a copied pulled file only
// needs its ids removed, and never sent.
const READ_ONLY_QUESTION_FIELDS = ['answer_feedback_html', 'is_graded', 'is_optional'];

const QUIZ_KEYS = new Set(['name', 'html', ...QUIZ_SETTINGS, 'questions']);
const QUESTION_KEYS = new Set(QUESTION_FIELDS);
const ANSWER_KEYS = new Set(['answer_text', 'correct']);

const INTEGER_SETTINGS = {
  passing_percentage_correct: [0, 100],
  max_attempts: [0, 2147483647],
  limit_question_count: [0, 2147483647],
  time_limit_seconds: [0, 3600000]
};
const BOOLEAN_SETTINGS = [
  'show_results_on_failure',
  'require_correct_response',
  'randomize_questions',
  'randomize_answers',
  'show_question_feedback'
];
const BOOLEAN_QUESTION_FIELDS = ['requires_manual_grading', 'case_sensitive'];

const isBlank = (value) => typeof value !== 'string' || value.trim() === '';

/**
 * Returns a list of problems with a new quiz file, each naming where it is.
 * An empty list means it can be created.
 */
export function validateNewQuiz(file) {
  const errors = [];
  if (!file || typeof file !== 'object' || Array.isArray(file)) return ['the file is not a JSON object'];

  if ('id' in file) {
    errors.push('has an "id", so it looks like a pulled quiz; a new quiz has no ids');
  }
  for (const key of Object.keys(file)) {
    if (key !== 'id' && !QUIZ_KEYS.has(key)) errors.push(`unknown field "${key}"`);
  }

  if (isBlank(file.name)) errors.push('"name" is required');
  else if (file.name.length > 500) errors.push('"name" is longer than 500 characters');
  if (isBlank(file.html)) errors.push('"html" is required (the quiz description shown before it starts)');

  for (const [field, [min, max]] of Object.entries(INTEGER_SETTINGS)) {
    const value = file[field];
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`"${field}" must be a whole number from ${min} to ${max}`);
    }
  }
  for (const field of BOOLEAN_SETTINGS) {
    if (file[field] !== undefined && file[field] !== null && typeof file[field] !== 'boolean') {
      errors.push(`"${field}" must be true or false`);
    }
  }
  if (file.alignment !== undefined && file.alignment !== null && !ALIGNMENTS.includes(file.alignment)) {
    errors.push(`"alignment" must be one of ${ALIGNMENTS.join(', ')}`);
  }

  if (!Array.isArray(file.questions) || file.questions.length === 0) {
    errors.push('"questions" must be a list with at least one question');
    return errors;
  }

  if (Number.isInteger(file.limit_question_count) && file.limit_question_count > file.questions.length) {
    errors.push(`"limit_question_count" is ${file.limit_question_count}, but there are only ${file.questions.length} questions`);
  }

  file.questions.forEach((question, i) => {
    errors.push(...validateQuestion(question).map(e => `question ${i + 1}: ${e}`));
  });

  return errors;
}

function validateQuestion(question) {
  const errors = [];
  if (!question || typeof question !== 'object' || Array.isArray(question)) return ['is not an object'];

  if ('id' in question) errors.push('has an "id"; a new question has none');
  for (const key of Object.keys(question)) {
    if (key !== 'id' && key !== 'answers' && !QUESTION_KEYS.has(key)) errors.push(`unknown field "${key}"`);
  }
  if (!QUESTION_TYPES.includes(question.type)) {
    errors.push(`"type" must be one of ${QUESTION_TYPES.join(', ')}`);
  }
  if (isBlank(question.html)) errors.push('"html" is required');
  for (const field of BOOLEAN_QUESTION_FIELDS) {
    if (question[field] !== undefined && question[field] !== null && typeof question[field] !== 'boolean') {
      errors.push(`"${field}" must be true or false`);
    }
  }

  const answers = question.answers ?? [];
  if (!Array.isArray(answers)) return [...errors, '"answers" must be a list'];

  answers.forEach((answer, j) => {
    const where = `answer ${j + 1}`;
    if ('id' in answer) errors.push(`${where} has an "id"; a new answer has none`);
    for (const key of Object.keys(answer)) {
      if (key !== 'id' && !ANSWER_KEYS.has(key)) errors.push(`${where}: unknown field "${key}"`);
    }
    if (isBlank(answer.answer_text)) errors.push(`${where}: "answer_text" is required`);
    else if (answer.answer_text.length > 1000) errors.push(`${where}: "answer_text" is longer than 1000 characters`);
    if (typeof answer.correct !== 'boolean') errors.push(`${where}: "correct" must be true or false`);
  });

  const correct = answers.filter(a => a.correct === true).length;
  switch (question.type) {
    case 'MULTIPLE_CHOICE':
      if (answers.length < 2) errors.push('a MULTIPLE_CHOICE question needs at least two answers');
      if (correct !== 1) errors.push(`a MULTIPLE_CHOICE question needs exactly one correct answer, not ${correct}`);
      break;
    case 'MULTIPLE_ANSWER':
      if (answers.length < 2) errors.push('a MULTIPLE_ANSWER question needs at least two answers');
      if (correct < 1) errors.push('a MULTIPLE_ANSWER question needs at least one correct answer');
      break;
    case 'FILL_IN_THE_BLANK':
      if (answers.length < 1) errors.push('a FILL_IN_THE_BLANK question needs at least one accepted answer');
      if (correct !== answers.length) errors.push('every answer to a FILL_IN_THE_BLANK question is an accepted answer, so each needs "correct": true');
      break;
    case 'FREEFORM':
      if (answers.length) errors.push('a FREEFORM question takes no answers');
      break;
  }

  return errors;
}

// Only what the file actually sets is sent. Leaving a setting out lets
// Skilljar apply its own default, which is what an unset field in the file
// means.
const present = (value) => value !== undefined && value !== null;

export function buildQuizRequest(file) {
  const body = { name: file.name, html: file.html };
  for (const field of QUIZ_SETTINGS) {
    if (present(file[field])) body[field] = file[field];
  }
  return body;
}

export function buildQuestionRequests(quizId, file) {
  return file.questions.map(question => {
    const body = { quiz: quizId, type: question.type, html: question.html };
    for (const field of QUESTION_FIELDS) {
      if (field === 'type' || field === 'html' || READ_ONLY_QUESTION_FIELDS.includes(field)) continue;
      if (present(question[field])) body[field] = question[field];
    }
    body.answers = (question.answers ?? []).map(a => ({ answer_text: a.answer_text, correct: a.correct }));
    return body;
  });
}

// HTML is compared the way push compares it, so Skilljar re-wrapping markup
// is not reported as a failed write.
const same = (a, b) => normalizeHtml(a ?? '') === normalizeHtml(b ?? '');

/**
 * Compares what was asked for with what Skilljar now holds, since a 200 from
 * a quiz write does not prove the write happened. `upstream` is a pulled-shape
 * quiz file (see buildQuizFile). Returns a list of differences.
 */
export function verifyCreatedQuiz(file, upstream) {
  const problems = [];
  if (!same(file.name, upstream.name)) problems.push('name differs');
  if (!same(file.html, upstream.html)) problems.push('html differs');
  for (const field of QUIZ_SETTINGS) {
    if (present(file[field]) && file[field] !== upstream[field]) {
      problems.push(`${field} is ${JSON.stringify(upstream[field])}, not ${JSON.stringify(file[field])}`);
    }
  }

  if (upstream.questions.length !== file.questions.length) {
    problems.push(`has ${upstream.questions.length} questions, not ${file.questions.length}`);
    return problems;
  }

  file.questions.forEach((wanted, i) => {
    const got = upstream.questions[i];
    const where = `question ${i + 1}`;
    if (got.type !== wanted.type) problems.push(`${where} is ${got.type}, not ${wanted.type}`);
    if (!same(got.html, wanted.html)) problems.push(`${where}: html differs (out of order, or not saved)`);
    for (const field of ['correct_answer_feedback_html', 'incorrect_answer_feedback_html']) {
      if (present(wanted[field]) && !same(got[field], wanted[field])) problems.push(`${where}: ${field} differs`);
    }
    for (const field of BOOLEAN_QUESTION_FIELDS) {
      if (present(wanted[field]) && got[field] !== wanted[field]) problems.push(`${where}: ${field} differs`);
    }
    const key = (answers) => JSON.stringify(answers.map(a => [a.answer_text, Boolean(a.correct)]));
    if (key(got.answers) !== key(wanted.answers ?? [])) problems.push(`${where}: answers differ`);
  });

  return problems;
}

/** Requests one create costs: the quiz, each question, and two reads to verify. */
export function createRequestCount(file) {
  return 1 + file.questions.length + 2;
}
