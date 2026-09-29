import test from 'node:test';
import assert from 'node:assert/strict';

import {
  quizFileName,
  isNewQuizFile,
  buildQuizFile,
  collectLinkedQuizIds,
  banksInUse,
  findStaleQuizFiles,
  QUIZ_SETTINGS,
  QUESTION_FIELDS
} from '../scripts/quiz-files.mjs';

// Invented sample data, shaped like `GET /quizzes` and
// `GET /quizzes/{id}/questions`.
const quiz = {
  id: 'quizA',
  name: 'Sample knowledge check',
  html: '<p>Three quick questions.</p>',
  passing_percentage_correct: 70,
  show_results_on_failure: true,
  max_attempts: 0,
  require_correct_response: false,
  randomize_questions: false,
  limit_question_count: 0,
  randomize_answers: true,
  time_limit_seconds: null,
  show_question_feedback: true,
  alignment: 'left'
};

const question = (id, order, extra = {}) => ({
  id,
  order,
  type: 'MULTIPLE_CHOICE',
  html: `<p>Question ${id}</p>`,
  requires_manual_grading: false,
  case_sensitive: false,
  correct_answer_feedback_html: '',
  incorrect_answer_feedback_html: '',
  answer_feedback_html: '',
  is_graded: true,
  is_optional: false,
  answers: [
    { id: `${id}-b`, order: 20, answer_text: 'Wrong', correct: false },
    { id: `${id}-a`, order: 10, answer_text: 'Right', correct: true }
  ],
  ...extra
});

test('quizFileName and isNewQuizFile', () => {
  assert.equal(quizFileName('quizA'), 'quiz-quizA.json');
  assert.equal(isNewQuizFile('quiz-new-sbom-basics.json'), true);
  assert.equal(isNewQuizFile('quiz-quizA.json'), false);
});

test('buildQuizFile orders questions and answers by upstream order', () => {
  const file = buildQuizFile(quiz, [question('q2', 20), question('q1', 10)]);
  assert.deepEqual(file.questions.map(q => q.id), ['q1', 'q2']);
  assert.deepEqual(file.questions[0].answers.map(a => a.answer_text), ['Right', 'Wrong']);
});

// Upstream order is creation order and cannot be set, so an `order` field in
// the file would suggest an edit that no push can make.
test('buildQuizFile does not write order fields', () => {
  const file = buildQuizFile(quiz, [question('q1', 10)]);
  assert.equal('order' in file.questions[0], false);
  assert.equal('order' in file.questions[0].answers[0], false);
});

test('buildQuizFile writes every setting and question field, set or not', () => {
  const file = buildQuizFile({ id: 'bare' }, [{ id: 'q1', answers: [] }]);
  for (const field of QUIZ_SETTINGS) assert.ok(field in file, `missing ${field}`);
  for (const field of QUESTION_FIELDS) assert.ok(field in file.questions[0], `missing ${field}`);
  assert.equal(file.time_limit_seconds, null);
  assert.equal(file.name, '');
});

test('buildQuizFile keeps false and 0 as values', () => {
  const file = buildQuizFile(quiz, []);
  assert.equal(file.max_attempts, 0);
  assert.equal(file.require_correct_response, false);
});

test('buildQuizFile coerces a missing correct flag to false', () => {
  const file = buildQuizFile(quiz, [question('q1', 10, { answers: [{ id: 'a', answer_text: 'x' }] })]);
  assert.equal(file.questions[0].answers[0].correct, false);
});

test('buildQuizFile is deterministic whatever order the API returns', () => {
  const a = buildQuizFile(quiz, [question('q1', 10), question('q2', 20)]);
  const b = buildQuizFile(quiz, [question('q2', 20), question('q1', 10)]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('collectLinkedQuizIds reads QUIZ items and legacy quiz lessons', () => {
  const ids = collectLinkedQuizIds([
    { slug: '10-intro', non_html_items: [{ type: 'ASSET', content_asset_id: 'x' }] },
    { slug: '20-check', non_html_items: [{ type: 'QUIZ', content_quiz_id: 'quizA' }] },
    { slug: '30-legacy', type: 'QUIZ', content_quiz_id: 'quizB' },
    { slug: '40-plain', content_items: [] }
  ]);
  assert.deepEqual([...ids].sort(), ['quizA', 'quizB']);
});

// Two lessons pointing at one quiz is common, and must yield one file.
test('collectLinkedQuizIds counts a quiz linked from two lessons once', () => {
  const ids = collectLinkedQuizIds([
    { slug: '70-first', non_html_items: [{ type: 'QUIZ', content_quiz_id: 'quizA' }] },
    { slug: '180-second', non_html_items: [{ type: 'QUIZ', content_quiz_id: 'quizA' }] }
  ]);
  assert.deepEqual([...ids], ['quizA']);
});

// Banks can exist without any quiz using them. Checking every quiz for banks
// in that case doubles the request count for nothing.
test('banksInUse is false when no bank is associated with a quiz', () => {
  assert.equal(banksInUse([]), false);
  assert.equal(banksInUse([{ id: 'b1', quiz_association_count: 0 }]), false);
  assert.equal(banksInUse([{ id: 'b1', quiz_association_count: 0 }, { id: 'b2', quiz_association_count: 2 }]), true);
});

// An unknown count must not be read as zero, or bank questions go missing
// from quiz files without a warning.
test('banksInUse assumes a bank without a count is in use', () => {
  assert.equal(banksInUse([{ id: 'b1' }]), true);
});

test('findStaleQuizFiles reports files whose quiz is gone upstream, and nothing else', () => {
  const stale = findStaleQuizFiles(
    ['quiz-quizA.json', 'quiz-old.json', 'quiz-new-draft.json', 'notes.md', '.DS_Store'],
    new Set(['quizA'])
  );
  assert.deepEqual(stale, ['quiz-old.json']);
});
