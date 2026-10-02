/**
 * skilljar-fetch.mjs — the list reads that both pull and push need.
 *
 * Skilljar exposes each of these three collections two ways: one resource per
 * GET, or the whole collection in one paginated GET. The per-resource form
 * reads naturally in a loop and is how `push` was first written, but it costs
 * a round trip per object — 1,537 of them across 66 courses, 649 lessons and
 * 822 content items, about ten minutes of pure waiting. The list form answers
 * the same questions in 716 requests, and there is no case in this repo where
 * a caller wants a single object it could not get from a list it already has.
 *
 * Two things that look like further savings and are not:
 *
 * - `GET /lessons` returns a `content_html` field, but it is empty for
 *   `MODULAR` lessons, which is every lesson here. The content genuinely
 *   lives in the content-items collection, so one request per lesson is the
 *   floor.
 * - Content items carry no timestamp, and neither do lessons. Only a course
 *   has `modified_at`, so there is no per-lesson freshness check to short-
 *   circuit on.
 *
 * Every failure exits through `failCleanly()`. These results feed writes — to
 * the local tree on pull, to the live LMS on push — so continuing past a
 * failed page would act on a partial collection as though it were complete.
 */
import { failCleanly } from '#lib/skilljar/client.mjs';

// Skilljar's maximum. Fewer, larger pages is strictly better here: the cost is
// the round trip, not the bytes.
const PAGE_SIZE = 100;

/**
 * Walks a paginated list endpoint and returns every result across all pages.
 */
async function fetchAllPages(client, endpoint, params, describe, pageSize = PAGE_SIZE) {
  const all = [];
  let page = 1;

  while (true) {
    let data;
    try {
      ({ data } = await client.get(endpoint, {
        params: { ...params, page, page_size: pageSize }
      }));
    } catch (err) {
      failCleanly(err, `${describe} (page ${page}).`);
    }

    all.push(...(data.results || []));
    if (!data.next) break;
    page += 1;
  }

  return all;
}

/**
 * Every course, with the full course record each one — including `title` and
 * `modified_at`. One request covers the whole catalog at this size, which is
 * why neither caller needs `GET /courses/{id}`.
 */
export function fetchCourses(client) {
  return fetchAllPages(client, '/courses', {}, 'Could not list courses');
}

/**
 * Every lesson in a course, with `title`, `order` and `description_html`.
 */
export function fetchLessons(client, courseId) {
  return fetchAllPages(
    client,
    '/lessons',
    { course_id: courseId },
    `Could not list lessons for course ${courseId}`
  );
}

/**
 * Every content item in a lesson, with its `content_html`.
 *
 * Not paginated by us: a lesson holds a handful of items, and the endpoint
 * returns them in one response. `include_content` is what makes this a
 * replacement for the per-item GET rather than just an index of ids.
 */
export async function fetchContentItems(client, lessonId) {
  let data;
  try {
    ({ data } = await client.get(`/lessons/${lessonId}/content-items`, {
      params: { include_content: true }
    }));
  } catch (err) {
    failCleanly(err, `Could not fetch content items for lesson ${lessonId}.`);
  }
  return data.results || [];
}

// `/quizzes` alone allows 1000 per page, so the whole organisation's quizzes
// are normally one request.
const QUIZ_PAGE_SIZE = 1000;

/**
 * Every quiz in the organisation, with its settings. Questions are not
 * included; see fetchQuizQuestions.
 */
export function fetchQuizzes(client) {
  return fetchAllPages(client, '/quizzes', {}, 'Could not list quizzes', QUIZ_PAGE_SIZE);
}

/**
 * Every question in a quiz, answers included, in quiz order. There is no bulk
 * form across quizzes, so this is one request per quiz.
 */
export function fetchQuizQuestions(client, quizId) {
  return fetchAllPages(
    client,
    `/quizzes/${quizId}/questions`,
    {},
    `Could not list questions for quiz ${quizId}`
  );
}

/**
 * Every member of a student group. One paginated sweep, about five requests
 * for a 400-member group. Checking members one at a time costs three calls
 * each, and Skilljar throttles hard long before a group that size is done.
 *
 * Rows are returned as the API sends them. Read each as `row.user ?? row`,
 * as the other user scripts do, rather than assuming one shape.
 */
export function fetchGroupMembers(client, groupId) {
  return fetchAllPages(
    client,
    `/groups/${groupId}/users`,
    {},
    `Could not list members of group ${groupId}`
  );
}

export function fetchQuestionBanks(client) {
  return fetchAllPages(client, '/question-banks', {}, 'Could not list question banks');
}

/**
 * The question banks a quiz draws from. Questions drawn from a bank are not
 * in the quiz's own question list, so a quiz with banks is only partly
 * described by fetchQuizQuestions.
 */
export function fetchQuizQuestionBanks(client, quizId) {
  return fetchAllPages(
    client,
    `/quizzes/${quizId}/question-banks`,
    {},
    `Could not list question banks for quiz ${quizId}`
  );
}
