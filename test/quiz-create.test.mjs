import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateNewQuiz,
  buildQuizRequest,
  buildQuestionRequests,
  verifyCreatedQuiz,
  createRequestCount
} from '../scripts/quiz-create.mjs';
import { buildQuizFile } from '../scripts/quiz-files.mjs';

// An invented quiz, in the shape an author would write.
function sample(overrides = {}) {
  return {
    name: 'Sample: container basics check',
    html: '<p>Three questions on the lesson you just read.</p>',
    passing_percentage_correct: 70,
    randomize_answers: true,
    questions: [
      {
        type: 'MULTIPLE_CHOICE',
        html: '<p>Which file lists an image\'s packages?</p>',
        correct_answer_feedback_html: '<p>Right.</p>',
        answers: [
          { answer_text: 'An SBOM', correct: true },
          { answer_text: 'A Dockerfile', correct: false }
        ]
      },
      {
        type: 'MULTIPLE_ANSWER',
        html: '<p>Which are signing tools?</p>',
        answers: [
          { answer_text: 'cosign', correct: true },
          { answer_text: 'sigstore-js', correct: true },
          { answer_text: 'curl', correct: false }
        ]
      },
      {
        type: 'FILL_IN_THE_BLANK',
        html: '<p>A list of components is a ____.</p>',
        case_sensitive: false,
        answers: [{ answer_text: 'SBOM', correct: true }]
      }
    ],
    ...overrides
  };
}

const q = (i, patch) => {
  const file = sample();
  file.questions[i] = { ...file.questions[i], ...patch };
  return file;
};

test('a well-formed sample quiz is valid', () => {
  assert.deepEqual(validateNewQuiz(sample()), []);
});

test('a pulled quiz with ids is not treated as new', () => {
  const errors = validateNewQuiz({ ...sample(), id: 'abc' });
  assert.ok(errors.some(e => /looks like a pulled quiz/.test(e)));
});

// The API ignores fields it does not recognise, so a typo would silently
// drop a setting.
test('an unknown field is an error, not something to ignore', () => {
  const errors = validateNewQuiz({ ...sample(), pasing_percentage_correct: 80 });
  assert.deepEqual(errors, ['unknown field "pasing_percentage_correct"']);
});

test('an unknown question or answer field is an error', () => {
  assert.ok(validateNewQuiz(q(0, { feedback: 'x' })).some(e => /question 1: unknown field "feedback"/.test(e)));
  const file = sample();
  file.questions[0].answers[0].is_correct = true;
  assert.ok(validateNewQuiz(file).some(e => /question 1: answer 1: unknown field "is_correct"/.test(e)));
});

test('name, html and at least one question are required', () => {
  const errors = validateNewQuiz({ name: ' ', html: '', questions: [] });
  assert.ok(errors.includes('"name" is required'));
  assert.ok(errors.some(e => e.startsWith('"html" is required')));
  assert.ok(errors.some(e => e.startsWith('"questions" must be a list')));
});

test('settings are range- and type-checked', () => {
  assert.ok(validateNewQuiz(sample({ passing_percentage_correct: 101 })).some(e => /passing_percentage_correct/.test(e)));
  assert.ok(validateNewQuiz(sample({ max_attempts: 1.5 })).some(e => /max_attempts/.test(e)));
  assert.ok(validateNewQuiz(sample({ randomize_answers: 'yes' })).some(e => /randomize_answers/.test(e)));
  assert.ok(validateNewQuiz(sample({ alignment: 'middle' })).some(e => /alignment/.test(e)));
  assert.deepEqual(validateNewQuiz(sample({ time_limit_seconds: null })), []);
});

test('limit_question_count cannot exceed the number of questions', () => {
  assert.ok(validateNewQuiz(sample({ limit_question_count: 4 })).some(e => /only 3 questions/.test(e)));
});

test('a multiple-choice question needs exactly one correct answer', () => {
  const two = q(0, { answers: [{ answer_text: 'a', correct: true }, { answer_text: 'b', correct: true }] });
  assert.ok(validateNewQuiz(two).some(e => /exactly one correct answer, not 2/.test(e)));
  const one = q(0, { answers: [{ answer_text: 'a', correct: true }] });
  assert.ok(validateNewQuiz(one).some(e => /at least two answers/.test(e)));
});

test('a multiple-answer question needs a correct answer', () => {
  const none = q(1, { answers: [{ answer_text: 'a', correct: false }, { answer_text: 'b', correct: false }] });
  assert.ok(validateNewQuiz(none).some(e => /at least one correct answer/.test(e)));
});

test('every fill-in-the-blank answer must be marked correct', () => {
  const file = q(2, { answers: [{ answer_text: 'SBOM', correct: true }, { answer_text: 'bill', correct: false }] });
  assert.ok(validateNewQuiz(file).some(e => /FILL_IN_THE_BLANK/.test(e)));
});

test('a freeform question takes no answers', () => {
  assert.deepEqual(validateNewQuiz(q(0, { type: 'FREEFORM', answers: [] })), []);
  assert.ok(validateNewQuiz(q(0, { type: 'FREEFORM' })).some(e => /takes no answers/.test(e)));
});

test('an unknown question type and a missing correct flag are errors', () => {
  assert.ok(validateNewQuiz(q(0, { type: 'TRUE_FALSE' })).some(e => /"type" must be one of/.test(e)));
  const file = sample();
  delete file.questions[0].answers[1].correct;
  assert.ok(validateNewQuiz(file).some(e => /answer 2: "correct" must be true or false/.test(e)));
});

test('buildQuizRequest sends only the settings the file sets', () => {
  assert.deepEqual(buildQuizRequest(sample({ time_limit_seconds: null })), {
    name: 'Sample: container basics check',
    html: '<p>Three questions on the lesson you just read.</p>',
    passing_percentage_correct: 70,
    randomize_answers: true
  });
});

test('buildQuestionRequests keeps file order and attaches every question to the quiz', () => {
  const bodies = buildQuestionRequests('quizX', sample());
  assert.deepEqual(bodies.map(b => b.type), ['MULTIPLE_CHOICE', 'MULTIPLE_ANSWER', 'FILL_IN_THE_BLANK']);
  assert.ok(bodies.every(b => b.quiz === 'quizX'));
  assert.equal(bodies[0].correct_answer_feedback_html, '<p>Right.</p>');
  assert.equal(bodies[2].case_sensitive, false);
});

// A copied pulled file carries these; they describe upstream state and are
// not part of a create request.
test('buildQuestionRequests does not send read-only fields', () => {
  const [body] = buildQuestionRequests('quizX', q(0, { is_graded: true, is_optional: false, answer_feedback_html: '' }));
  for (const field of ['is_graded', 'is_optional', 'answer_feedback_html']) assert.equal(field in body, false);
  assert.deepEqual(validateNewQuiz(q(0, { is_graded: true, is_optional: false, answer_feedback_html: '' })), []);
});

// Builds what a successful create reads back, in pulled form.
function readBack(file, tweak = (x) => x) {
  const quiz = { id: 'quizX', name: file.name, html: file.html, passing_percentage_correct: 70, randomize_answers: true };
  const questions = file.questions.map((question, i) => ({
    id: `q${i}`, order: (i + 1) * 10, ...question,
    answers: (question.answers ?? []).map((a, j) => ({ id: `a${i}${j}`, order: (j + 1) * 10, ...a }))
  }));
  return buildQuizFile(...tweak([quiz, questions]));
}

test('verifyCreatedQuiz passes when Skilljar holds what was sent', () => {
  assert.deepEqual(verifyCreatedQuiz(sample(), readBack(sample())), []);
});

test('verifyCreatedQuiz ignores whitespace Skilljar adds to HTML', () => {
  const upstream = readBack(sample());
  upstream.html = '<p>Three questions on the lesson   you just read.</p>\n';
  assert.deepEqual(verifyCreatedQuiz(sample(), upstream), []);
});

test('verifyCreatedQuiz catches a setting that did not stick', () => {
  const upstream = readBack(sample(), ([quiz, qs]) => [{ ...quiz, passing_percentage_correct: 0 }, qs]);
  assert.deepEqual(verifyCreatedQuiz(sample(), upstream), ['passing_percentage_correct is 0, not 70']);
});

test('verifyCreatedQuiz catches questions out of order', () => {
  const upstream = readBack(sample(), ([quiz, qs]) => [quiz, qs.map((x, i) => ({ ...x, order: 100 - i }))]);
  assert.ok(verifyCreatedQuiz(sample(), upstream).some(p => /question 1/.test(p)));
});

test('verifyCreatedQuiz catches a missing question and changed answers', () => {
  assert.deepEqual(
    verifyCreatedQuiz(sample(), readBack(sample(), ([quiz, qs]) => [quiz, qs.slice(0, 2)])),
    ['has 2 questions, not 3']
  );
  const flipped = readBack(sample(), ([quiz, qs]) => [quiz, qs.map((x, i) => i ? x : {
    ...x, answers: x.answers.map(a => ({ ...a, correct: !a.correct }))
  })]);
  assert.deepEqual(verifyCreatedQuiz(sample(), flipped), ['question 1: answers differ']);
});

test('createRequestCount is one per quiz and question, plus two reads', () => {
  assert.equal(createRequestCount(sample()), 6);
});
