/**
 * quiz-plan.mjs — work out how to bring an existing upstream quiz in line
 * with its edited local file. Makes no requests.
 *
 * Two kinds of change, and the difference matters to learners (see CLAUDE.md,
 * "What an edit does to learners who already took the quiz"):
 *
 * - **In place.** Quiz settings, and a question's text, type, feedback and
 *   grading flags, are PATCHed. The question keeps its id and its response
 *   history.
 * - **Recreate.** Answers and order cannot be changed through the API, so a
 *   question whose answers changed, or that moved, is created again from the
 *   file and the old one deleted. A new question always goes to the end, so
 *   every question after the first new or recreated one has to be recreated
 *   too, or the order would not match the file. A recreated question loses its
 *   response history, and learners can no longer review their answers.
 *
 * Writes run in the order: settings, in-place question patches, creates,
 * then deletes. Creating before deleting means a failure partway leaves the
 * quiz with extra questions rather than missing ones, and the extras are new
 * with no history, so they can be removed without loss.
 */
import crypto from 'crypto';
import { QUIZ_SETTINGS } from '#lib/content/quiz-files.mjs';
import { normalizeHtml } from '#lib/push/plan.mjs';

const present = (value) => value !== undefined && value !== null;

const HTML_FIELDS = new Set(['html', 'correct_answer_feedback_html', 'incorrect_answer_feedback_html']);
const IN_PLACE_QUESTION_FIELDS = [
  'type',
  'html',
  'correct_answer_feedback_html',
  'incorrect_answer_feedback_html',
  'requires_manual_grading',
  'case_sensitive'
];

function differs(field, local, upstream) {
  if (!present(local)) return false;
  if (HTML_FIELDS.has(field) || field === 'name') {
    return normalizeHtml(local ?? '') !== normalizeHtml(upstream ?? '');
  }
  return local !== upstream;
}

const answersKey = (answers) =>
  JSON.stringify((answers ?? []).map(a => [String(a.answer_text ?? '').trim(), Boolean(a.correct)]));

/**
 * Returns `{ problems, quizPatch, questionPatches, creates, deletes }`.
 *
 * `problems` are reasons the plan cannot be applied at all, such as a question
 * id that isn't in the upstream quiz. When there are any, the other fields are
 * empty.
 *
 * `quizPatch` is `{ field: { from, to } }`. `questionPatches` is
 * `[{ id, position, fields: { field: { from, to } } }]`. `creates` is
 * `[{ position, question, replaces, reason }]`, in file order. `replaces` is the
 * id of the question it recreates, or null for a new question. `deletes` is
 * `[{ id, reason }]`.
 */
export function planQuizEdit(local, upstream) {
  const empty = { problems: [], quizPatch: {}, questionPatches: [], creates: [], deletes: [] };

  if (local.id !== upstream.id) {
    return { ...empty, problems: [`the file is for quiz ${local.id}, but upstream is ${upstream.id}`] };
  }

  const upstreamIndex = new Map(upstream.questions.map((q, i) => [q.id, i]));
  const problems = [];
  const seen = new Set();
  local.questions.forEach((q, i) => {
    if (!q.id) return;
    if (!upstreamIndex.has(q.id)) {
      problems.push(`question ${i + 1} has id ${q.id}, which is not in this quiz upstream — pull to get the current quiz`);
    }
    if (seen.has(q.id)) problems.push(`question ${i + 1} repeats id ${q.id}`);
    seen.add(q.id);
  });
  if (problems.length) return { ...empty, problems };

  const quizPatch = {};
  for (const field of ['name', 'html', ...QUIZ_SETTINGS]) {
    if (differs(field, local[field], upstream[field])) {
      quizPatch[field] = { from: upstream[field], to: local[field] };
    }
  }

  const questionPatches = [];
  const creates = [];
  const deletes = [];
  let lastKept = -1;
  let tailStarted = false;

  local.questions.forEach((question, i) => {
    const position = i + 1;
    if (!question.id) {
      tailStarted = true;
      creates.push({ position, question, replaces: null, reason: 'new question' });
      return;
    }

    const up = upstream.questions[upstreamIndex.get(question.id)];
    const answersChanged = answersKey(question.answers) !== answersKey(up.answers);
    const moved = upstreamIndex.get(question.id) < lastKept;

    if (answersChanged || moved || tailStarted) {
      const reason = answersChanged
        ? 'answers changed'
        : moved
          ? 'moved'
          : 'comes after a new or recreated question, so it has to be recreated to keep its place';
      tailStarted = true;
      creates.push({ position, question, replaces: question.id, reason });
      deletes.push({ id: question.id, reason: 'replaced by its recreated copy' });
      return;
    }

    lastKept = upstreamIndex.get(question.id);
    const fields = {};
    for (const field of IN_PLACE_QUESTION_FIELDS) {
      if (differs(field, question[field], up[field])) fields[field] = { from: up[field], to: question[field] };
    }
    if (Object.keys(fields).length) questionPatches.push({ id: question.id, position, fields });
  });

  for (const up of upstream.questions) {
    if (!seen.has(up.id)) deletes.push({ id: up.id, reason: 'removed from the file' });
  }

  return { problems: [], quizPatch, questionPatches, creates, deletes };
}

export function hasChanges(plan) {
  return Object.keys(plan.quizPatch).length > 0
    || plan.questionPatches.length > 0
    || plan.creates.length > 0
    || plan.deletes.length > 0;
}

/**
 * Whether applying the plan destroys anything learners have: a recreated or
 * removed question loses its response history. Adding a question at the end
 * does not.
 */
export function isDestructive(plan) {
  return plan.deletes.length > 0;
}

/** Requests the plan costs to apply, not counting the two reads that verify it. */
export function editRequestCount(plan) {
  return (Object.keys(plan.quizPatch).length ? 1 : 0)
    + plan.questionPatches.length
    + plan.creates.length
    + plan.deletes.length;
}

// The body of a create request, from a local question.
export function questionBody(quizId, question) {
  const body = { quiz: quizId, type: question.type, html: question.html };
  for (const field of ['correct_answer_feedback_html', 'incorrect_answer_feedback_html', 'requires_manual_grading', 'case_sensitive']) {
    if (present(question[field])) body[field] = question[field];
  }
  body.answers = (question.answers ?? []).map(a => ({ answer_text: a.answer_text, correct: a.correct }));
  return body;
}

// PATCH bodies. A question PATCH must name its quiz, or Skilljar rejects it.
export function quizPatchBody(plan) {
  return Object.fromEntries(Object.entries(plan.quizPatch).map(([field, { to }]) => [field, to]));
}

export function questionPatchBody(quizId, patch) {
  return { quiz: quizId, ...Object.fromEntries(Object.entries(patch.fields).map(([field, { to }]) => [field, to])) };
}

// Only ever printed, and JSON-quoted, but tags are still stripped until none
// are left, so a removal can't splice a new one together out of its neighbours.
const excerpt = (value) => {
  let text = String(value ?? '');
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]+>/g, '');
  } while (text !== previous);
  text = text.replace(/\s+/g, ' ').trim();
  return JSON.stringify(text.length > 70 ? `${text.slice(0, 67)}…` : text);
};

/** Human-readable lines describing a plan, for the review before any write. */
export function describePlan(plan) {
  const lines = [];
  for (const [field, { from, to }] of Object.entries(plan.quizPatch)) {
    lines.push(`quiz ${field}: ${excerpt(from)} → ${excerpt(to)}`);
  }
  for (const patch of plan.questionPatches) {
    for (const [field, { from, to }] of Object.entries(patch.fields)) {
      lines.push(`question ${patch.position} ${field}: ${excerpt(from)} → ${excerpt(to)}`);
    }
  }
  for (const create of plan.creates) {
    lines.push(create.replaces
      ? `question ${create.position}: recreate (${create.reason})`
      : `question ${create.position}: add`);
  }
  for (const del of plan.deletes.filter(d => d.reason === 'removed from the file')) {
    lines.push(`question ${del.id}: delete (removed from the file)`);
  }
  return lines;
}

/**
 * A hash of everything push could write for a quiz file. It's recorded after
 * a push or scan proves the quiz in sync, so the next run can skip a file that
 * hasn't changed without making any requests.
 */
export function fingerprintQuizFile(file) {
  return crypto.createHash('sha256').update(JSON.stringify(file)).digest('hex');
}
