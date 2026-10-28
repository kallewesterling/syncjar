import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectQuizFileNames,
  pulledShapeProblems,
  sortQuizFiles,
  triageScannedQuizzes
} from '#lib/push/quiz-select.mjs';
import { buildQuizFile } from '#lib/content/quiz-files.mjs';
import { planQuizEdit } from '#lib/push/quiz-plan.mjs';

// An invented feedback survey, in the form a pull writes it. Skilljar holds
// quizzes like this, and none of it passes the checks for a new quiz: no
// description, a LINEAR_SCALE question, and a MULTIPLE_ANSWER question with no
// correct answer.
function pulledSurvey() {
  return buildQuizFile(
    { id: 'survey1', name: 'Sample feedback survey', html: '' },
    [
      {
        id: 'sq1', order: 10, type: 'LINEAR_SCALE', html: '<p>How useful was this?</p>',
        answers: ['Not useful', '2', '3', '4', 'Very useful'].map((text, i) => ({ id: `sq1${i}`, order: i, answer_text: text, correct: false }))
      },
      {
        id: 'sq2', order: 20, type: 'MULTIPLE_ANSWER', html: '<p>What should come next?</p>',
        answers: [
          { id: 'sq2a', order: 1, answer_text: 'More labs', correct: false },
          { id: 'sq2b', order: 2, answer_text: 'More reading', correct: false }
        ]
      }
    ]
  );
}

// An invented pulled quiz that passes every check.
function pulledValid() {
  return buildQuizFile(
    { id: 'valid1', name: 'Sample graded quiz', html: '<p>Two questions.</p>', passing_percentage_correct: 70 },
    [{
      id: 'vq1', order: 10, type: 'MULTIPLE_CHOICE', html: '<p>Which file lists an image\'s packages?</p>',
      answers: [
        { id: 'vq1a', order: 1, answer_text: 'An SBOM', correct: true },
        { id: 'vq1b', order: 2, answer_text: 'A Dockerfile', correct: false }
      ]
    }]
  );
}

function newQuiz() {
  return {
    name: 'Sample: container basics check',
    html: '<p>One question on the lesson you just read.</p>',
    questions: [{
      type: 'MULTIPLE_CHOICE',
      html: '<p>Which file lists an image\'s packages?</p>',
      answers: [
        { answer_text: 'An SBOM', correct: true },
        { answer_text: 'A Dockerfile', correct: false }
      ]
    }]
  };
}

// What push does between sortQuizFiles and triageScannedQuizzes: read each
// pulled quiz from Skilljar, here a map of id to its pulled form, and plan.
const scan = (pulled, upstreamById) => pulled.map(entry => {
  const upstream = upstreamById[entry.file.id];
  return { ...entry, upstream, plan: planQuizEdit(entry.file, upstream) };
});

test('the pulled survey really does fail the checks for an edited quiz', () => {
  // Without this, the tests below could pass because the fixture is valid.
  const { pulled } = sortQuizFiles([{ name: 'quiz-survey1.json', file: pulledSurvey() }]);
  const problems = pulled[0].problems.join('\n');
  assert.match(problems, /"html" is required/);
  assert.match(problems, /question 1: "type" must be one of .*, and is "LINEAR_SCALE"/);
  assert.match(problems, /question 2: a MULTIPLE_ANSWER question needs at least one correct answer/);
});

test('an unchanged pulled quiz that fails the checks does not block a valid new quiz; it is a warning', () => {
  const sorted = sortQuizFiles([
    { name: 'quiz-new-basics.json', file: newQuiz() },
    { name: 'quiz-survey1.json', file: pulledSurvey() },
    { name: 'quiz-valid1.json', file: pulledValid() }
  ]);
  assert.deepEqual(sorted.invalidDrafts, []);
  assert.deepEqual(sorted.unreadable, []);
  assert.deepEqual(sorted.drafts.map(d => d.name), ['quiz-new-basics.json']);

  const triage = triageScannedQuizzes(scan(sorted.pulled, { survey1: pulledSurvey(), valid1: pulledValid() }));
  assert.deepEqual(triage.refused, []);
  assert.deepEqual(triage.changed, []);
  assert.deepEqual(triage.inSync.map(e => e.name), ['quiz-survey1.json', 'quiz-valid1.json']);
  assert.deepEqual(triage.warnings.map(w => w.name), ['quiz-survey1.json']);
  assert.ok(triage.warnings[0].problems.length >= 3);
});

test('an empty "Untitled Quiz" shell with no local changes is only a warning', () => {
  const shell = buildQuizFile({ id: 'shell1', name: 'Untitled Quiz', html: '' }, []);
  const sorted = sortQuizFiles([{ name: 'quiz-shell1.json', file: shell }]);
  const triage = triageScannedQuizzes(scan(sorted.pulled, { shell1: shell }));
  assert.deepEqual(triage.refused, []);
  assert.deepEqual(triage.warnings.map(w => w.name), ['quiz-shell1.json']);
});

test('an edited pulled quiz that fails the checks is refused, alone', () => {
  const edited = pulledSurvey();
  edited.questions[0].html = '<p>How useful was this course?</p>';
  const editedValid = pulledValid();
  editedValid.name = 'Sample graded quiz, renamed';

  const sorted = sortQuizFiles([
    { name: 'quiz-survey1.json', file: edited },
    { name: 'quiz-valid1.json', file: editedValid }
  ]);
  const triage = triageScannedQuizzes(scan(sorted.pulled, { survey1: pulledSurvey(), valid1: pulledValid() }));

  assert.deepEqual(triage.refused.map(r => [r.name, r.edited]), [['quiz-survey1.json', true]]);
  assert.ok(triage.refused[0].problems.some(p => /is "LINEAR_SCALE"/.test(p)));
  // The other quiz's edit still goes ahead.
  assert.deepEqual(triage.changed.map(e => e.name), ['quiz-valid1.json']);
  assert.deepEqual(triage.warnings, []);
});

test('a valid edit to a pulled quiz goes ahead', () => {
  const editedValid = pulledValid();
  editedValid.passing_percentage_correct = 80;
  const sorted = sortQuizFiles([{ name: 'quiz-valid1.json', file: editedValid }]);
  const triage = triageScannedQuizzes(scan(sorted.pulled, { valid1: pulledValid() }));
  assert.deepEqual(triage.changed.map(e => e.name), ['quiz-valid1.json']);
  assert.deepEqual(triage.refused, []);
});

test('a plan that cannot be applied is refused even without check failures', () => {
  const stale = pulledValid();
  stale.questions[0].id = 'gone';
  const sorted = sortQuizFiles([{ name: 'quiz-valid1.json', file: stale }]);
  const triage = triageScannedQuizzes(scan(sorted.pulled, { valid1: pulledValid() }));
  assert.deepEqual(triage.refused.map(r => [r.name, r.edited]), [['quiz-valid1.json', false]]);
});

test('a new quiz is held to the same rules as before, and one bad draft is reported', () => {
  const noHtml = { ...newQuiz(), html: '' };
  const noQuestions = { ...newQuiz(), questions: [] };
  const linearScale = newQuiz();
  linearScale.questions[0].type = 'LINEAR_SCALE';
  const sorted = sortQuizFiles([
    { name: 'quiz-new-a.json', file: noHtml },
    { name: 'quiz-new-b.json', file: noQuestions },
    { name: 'quiz-new-c.json', file: linearScale },
    { name: 'quiz-new-d.json', readError: 'not valid JSON (Unexpected token)' },
    { name: 'quiz-new-ok.json', file: newQuiz() }
  ]);
  assert.deepEqual(sorted.invalidDrafts.map(d => d.name), ['quiz-new-a.json', 'quiz-new-b.json', 'quiz-new-c.json', 'quiz-new-d.json']);
  assert.match(sorted.invalidDrafts[0].problems.join(), /"html" is required/);
  assert.match(sorted.invalidDrafts[1].problems.join(), /at least one question/);
  assert.match(sorted.invalidDrafts[2].problems.join(), /is "LINEAR_SCALE"/);
  assert.deepEqual(sorted.drafts.map(d => d.name), ['quiz-new-ok.json']);
});

test('a pulled file that cannot be compared is refused on its own', () => {
  const sorted = sortQuizFiles([
    { name: 'quiz-broken.json', readError: 'not valid JSON (Unexpected end of input)' },
    { name: 'quiz-other.json', file: pulledValid() },
    { name: 'quiz-valid1.json', file: pulledValid() }
  ]);
  assert.deepEqual(sorted.unreadable.map(u => u.name), ['quiz-broken.json', 'quiz-other.json']);
  assert.match(sorted.unreadable[1].problems.join(), /holds quiz valid1, but is named quiz-other\.json/);
  assert.deepEqual(sorted.pulled.map(p => p.name), ['quiz-valid1.json']);
});

test('pulledShapeProblems catches what would break the plan', () => {
  assert.deepEqual(pulledShapeProblems('quiz-x.json', []), ['the file is not a JSON object']);
  assert.ok(pulledShapeProblems('quiz-x.json', { questions: [] }).some(p => /no "id"/.test(p)));
  assert.ok(pulledShapeProblems('quiz-x.json', { id: 'x' }).some(p => /"questions" must be a list/.test(p)));
  assert.ok(pulledShapeProblems('quiz-x.json', { id: 'x', questions: [{ answers: {} }] }).some(p => /"answers" must be a list/.test(p)));
  assert.deepEqual(pulledShapeProblems('quiz-x.json', { id: 'x', questions: [] }), []);
});

test('--file limits the run to that one file, so other files are not even read', () => {
  const listing = ['quiz-survey1.json', 'quiz-new-basics.json', 'quiz-new-broken.json', 'README.md', '.DS_Store'];
  assert.deepEqual(selectQuizFileNames(listing), ['quiz-new-basics.json', 'quiz-new-broken.json', 'quiz-survey1.json']);
  assert.deepEqual(selectQuizFileNames(listing, 'quiz-new-basics.json'), ['quiz-new-basics.json']);
  // A path is reduced to its file name, as before.
  assert.deepEqual(selectQuizFileNames(listing, '../courses/quizzes/quiz-new-basics.json'), ['quiz-new-basics.json']);
  assert.deepEqual(selectQuizFileNames(listing, 'quiz-new-missing.json'), []);
});

test('--file naming a bad draft still stops the run', () => {
  const names = selectQuizFileNames(['quiz-new-broken.json', 'quiz-new-ok.json'], 'quiz-new-broken.json');
  const files = { 'quiz-new-broken.json': { ...newQuiz(), html: '' }, 'quiz-new-ok.json': newQuiz() };
  const sorted = sortQuizFiles(names.map(name => ({ name, file: files[name] })));
  assert.deepEqual(sorted.invalidDrafts.map(d => d.name), ['quiz-new-broken.json']);
  assert.deepEqual(sorted.drafts, []);
});
