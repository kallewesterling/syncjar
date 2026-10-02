import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planQuizEdit,
  hasChanges,
  isDestructive,
  editRequestCount,
  questionPatchBody,
  quizPatchBody,
  questionBody,
  describePlan,
  fingerprintQuizFile
} from '../scripts/quiz-plan.mjs';
import { validateEditedQuiz } from '../scripts/quiz-create.mjs';

// An invented pulled quiz: three questions, in the shape buildQuizFile writes.
function pulled() {
  const q = (id, text, right, wrong) => ({
    id, type: 'MULTIPLE_CHOICE', html: `<p>${text}</p>`,
    requires_manual_grading: false, case_sensitive: false,
    correct_answer_feedback_html: '', incorrect_answer_feedback_html: '',
    answer_feedback_html: '', is_graded: true, is_optional: false,
    answers: [{ id: `${id}a`, answer_text: right, correct: true }, { id: `${id}b`, answer_text: wrong, correct: false }]
  });
  return {
    id: 'quizS', name: 'Sample quiz', html: '<p>About the sample.</p>',
    passing_percentage_correct: 70, show_results_on_failure: true, max_attempts: 0,
    require_correct_response: false, randomize_questions: false, limit_question_count: 0,
    randomize_answers: false, time_limit_seconds: null, show_question_feedback: true, alignment: 'left',
    questions: [q('qA', 'First', 'Apple', 'Banana'), q('qB', 'Second', 'Cherry', 'Date'), q('qC', 'Third', 'Elderberry', 'Fig')]
  };
}
const edited = (fn) => { const f = structuredClone(pulled()); fn(f); return f; };
const ids = (xs) => xs.map(x => x.replaces ?? x.id ?? 'new');

test('an unedited pulled file plans nothing', () => {
  const plan = planQuizEdit(pulled(), pulled());
  assert.equal(hasChanges(plan), false);
  assert.deepEqual(plan.problems, []);
});

test('a pulled file passes edit validation', () => {
  assert.deepEqual(validateEditedQuiz(pulled()), []);
  assert.ok(validateEditedQuiz({ ...pulled(), id: '' }).some(e => /no "id"/.test(e)));
});

test('whitespace-only HTML differences are not changes', () => {
  const plan = planQuizEdit(edited(f => { f.questions[0].html = '<p>First</p>\n'; }), pulled());
  assert.equal(hasChanges(plan), false);
});

test('settings and quiz text change in place', () => {
  const plan = planQuizEdit(edited(f => { f.passing_percentage_correct = 80; f.name = 'Renamed'; }), pulled());
  assert.deepEqual(quizPatchBody(plan), { name: 'Renamed', passing_percentage_correct: 80 });
  assert.equal(isDestructive(plan), false);
});

test('question text, feedback and type change in place, keeping the id', () => {
  const plan = planQuizEdit(edited(f => {
    f.questions[1].html = '<p>Second, reworded</p>';
    f.questions[1].correct_answer_feedback_html = '<p>Yes.</p>';
    f.questions[2].type = 'MULTIPLE_ANSWER';
  }), pulled());
  assert.deepEqual(plan.questionPatches.map(p => [p.id, Object.keys(p.fields)]), [
    ['qB', ['html', 'correct_answer_feedback_html']],
    ['qC', ['type']]
  ]);
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.deletes, []);
  assert.equal(isDestructive(plan), false);
});

// A question PATCH without `quiz` is a 400 from Skilljar.
test('a question patch body names its quiz', () => {
  const plan = planQuizEdit(edited(f => { f.questions[0].html = '<p>New</p>'; }), pulled());
  assert.deepEqual(questionPatchBody('quizS', plan.questionPatches[0]), { quiz: 'quizS', html: '<p>New</p>' });
});

test('a changed answer recreates that question and every one after it', () => {
  const plan = planQuizEdit(edited(f => { f.questions[1].answers[1].answer_text = 'Durian'; }), pulled());
  assert.deepEqual(ids(plan.creates), ['qB', 'qC']);
  assert.match(plan.creates[0].reason, /answers changed/);
  assert.match(plan.creates[1].reason, /comes after/);
  assert.deepEqual(plan.deletes.map(d => d.id), ['qB', 'qC']);
  assert.equal(isDestructive(plan), true);
});

test('changing which answer is correct counts as an answer change', () => {
  const plan = planQuizEdit(edited(f => {
    f.questions[2].answers[0].correct = false;
    f.questions[2].answers[1].correct = true;
  }), pulled());
  assert.deepEqual(ids(plan.creates), ['qC']);
});

test('answer ids in the file are ignored; only text and correctness count', () => {
  const plan = planQuizEdit(edited(f => { for (const a of f.questions[0].answers) delete a.id; }), pulled());
  assert.equal(hasChanges(plan), false);
});

test('a question added at the end is a plain create, not destructive', () => {
  const plan = planQuizEdit(edited(f => {
    f.questions.push({ type: 'FREEFORM', html: '<p>Fourth</p>', answers: [] });
  }), pulled());
  assert.deepEqual(ids(plan.creates), ['new']);
  assert.deepEqual(plan.deletes, []);
  assert.equal(isDestructive(plan), false);
});

test('a question added in the middle recreates everything after it', () => {
  const plan = planQuizEdit(edited(f => {
    f.questions.splice(1, 0, { type: 'FREEFORM', html: '<p>Inserted</p>', answers: [] });
  }), pulled());
  assert.deepEqual(ids(plan.creates), ['new', 'qB', 'qC']);
  assert.deepEqual(plan.deletes.map(d => d.id), ['qB', 'qC']);
});

test('moving a question earlier recreates from the first out-of-order one', () => {
  const plan = planQuizEdit(edited(f => { f.questions = [f.questions[0], f.questions[2], f.questions[1]]; }), pulled());
  assert.deepEqual(ids(plan.creates), ['qB']);
  assert.match(plan.creates[0].reason, /moved/);
  assert.deepEqual(plan.deletes.map(d => d.id), ['qB']);
});

test('removing a question deletes it, and needs no recreation', () => {
  const plan = planQuizEdit(edited(f => { f.questions.splice(1, 1); }), pulled());
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.deletes, [{ id: 'qB', reason: 'removed from the file' }]);
  assert.equal(isDestructive(plan), true);
});

test('an unknown or repeated question id stops the plan', () => {
  const unknown = planQuizEdit(edited(f => { f.questions[0].id = 'qZ'; }), pulled());
  assert.match(unknown.problems[0], /qZ, which is not in this quiz upstream/);
  assert.equal(hasChanges(unknown), false);
  const repeated = planQuizEdit(edited(f => { f.questions[2].id = 'qA'; }), pulled());
  assert.ok(repeated.problems.some(p => /repeats id qA/.test(p)));
});

test('a file for a different quiz stops the plan', () => {
  assert.match(planQuizEdit({ ...pulled(), id: 'other' }, pulled()).problems[0], /for quiz other/);
});

test('editRequestCount counts one write per change', () => {
  const plan = planQuizEdit(edited(f => {
    f.passing_percentage_correct = 90;
    f.questions[0].html = '<p>Reworded</p>';
    f.questions[2].answers[0].answer_text = 'Elder';
  }), pulled());
  assert.equal(editRequestCount(plan), 1 + 1 + 1 + 1);
});

test('questionBody sends answers without ids and no read-only fields', () => {
  const body = questionBody('quizS', pulled().questions[0]);
  assert.deepEqual(body.answers, [{ answer_text: 'Apple', correct: true }, { answer_text: 'Banana', correct: false }]);
  for (const field of ['id', 'is_graded', 'is_optional', 'answer_feedback_html']) assert.equal(field in body, false);
  assert.equal(body.quiz, 'quizS');
});

test('describePlan names each change', () => {
  const lines = describePlan(planQuizEdit(edited(f => {
    f.passing_percentage_correct = 90;
    f.questions[1].answers[1].answer_text = 'Durian';
  }), pulled()));
  assert.deepEqual(lines, [
    'quiz passing_percentage_correct: "70" → "90"',
    'question 2: recreate (answers changed)',
    'question 3: recreate (comes after a new or recreated question, so it has to be recreated to keep its place)'
  ]);
});

test('describePlan strips tags from the excerpts it prints', () => {
  const lines = describePlan(planQuizEdit(edited(f => {
    f.questions[0].html = '<p>Pick <scr<b>ipt>the</b> <em>fruit</em></p>';
  }), pulled()));
  const line = lines.find(l => l.startsWith('question 1 html:'));
  assert.ok(line, lines.join('\n'));
  assert.ok(line.endsWith('→ "Pick ipt>the fruit"'), line);
});

test('fingerprintQuizFile changes with content and nothing else', () => {
  assert.equal(fingerprintQuizFile(pulled()), fingerprintQuizFile(pulled()));
  assert.notEqual(fingerprintQuizFile(pulled()), fingerprintQuizFile(edited(f => { f.name = 'x'; })));
});
