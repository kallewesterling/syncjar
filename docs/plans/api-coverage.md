# Plan: quizzes, and wider Skilljar API coverage

Status: proposal, 2026-09-28. Branch `feature/quizzes-and-api-coverage`.

## Where things stand

Syncjar calls three content collections — `/courses`, `/lessons`,
`/lessons/{id}/content-items` — plus paths, published courses/paths (for
slugs), and the user/group endpoints. The API has about 150 paths, and the
content-relevant gaps are below.

The machine-readable spec is at `https://api.skilljar.com/docs/schema.yml`
(OpenAPI 3, ~23k lines). `CLAUDE.md` says the docs can only be read in a
browser, which is true of the Redoc page and not of the spec it loads. Phase 0
corrects that note.

### We already fetch more than we keep

Before Phase 0, the pull kept only content items with `content_html`:

```js
contentItems.filter(i => i.content_html)
```

Every `QUIZ`, `ASSET` and `RATING` content item is downloaded and then dropped,
and so are the lesson fields `type`, `content_quiz_id`, `content_asset_id`,
`optional`, `time_seconds`, `search_keywords` and `tooltip_html`. That is why
quiz lessons show up in `lessons-meta.json` with `"content_items": []`. The quiz
ids we need are already in memory on every pull, so finding which lesson holds
which quiz costs no extra requests.

## Efficiency rules

These carry over from `skilljar-fetch.mjs` and apply to every new connector:

1. **Keep what you already fetched before making a new call.** Phase 0 costs
   zero requests.
2. **Read lists, not objects.** Use the largest page size each list allows:
   `/quizzes` takes up to 1000 per page, and most others take 100.
3. **One request per parent is the minimum**, and only where the API gives no
   bulk form. Quiz questions (answers included) come back one list per quiz;
   there is no endpoint that returns all questions at once.
4. **New resources get their own command, not a larger default pull.** The
   rate limit is 5,000 requests per hour, shared by every key in a Skilljar
   organisation, and a full pull of a mid-sized catalogue already spends a
   good part of it. Quizzes are the exception (see the budget below),
   because they are course content.
5. **Print the request count.** Each command reports how many requests it made,
   so a regression shows up as a number rather than as a slowdown.
6. **Nothing here has a timestamp.** Quizzes and questions carry no
   `modified_at`, so a push has to compare every quiz on every run. That is
   affordable because the quiz count is small. Record a content hash in
   `push-state.mjs` as courses do, and keep it from ever deciding a write (see
   `CLAUDE.md` on `modified_at`).

### Request budget

| Command | Requests added |
|---|---|
| `pull` (Phase 0) | 0 |
| `pull` with quizzes (Phase 1a) | 1 (`/quizzes`) + 1 per quiz + banks (1 + 1 per bank) |
| `push` with quizzes (Phase 1b) | the same reads, plus 1 write per changed quiz or question |
| catalog pulls (Phase 2) | a separate command, costed once it exists |

Quizzes are usually few next to lessons, so the added cost is small. `GET
/quizzes` gives the real count in one call.

## Phase 0 — keep what we already fetch (no new requests)

- Write `type`, `content_quiz_id`, `content_asset_id`, `optional`,
  `time_seconds`, `search_keywords` and `tooltip_html` into each lesson's
  `lessons-meta.json` entry.
- Record non-HTML content items (`id`, `type`, `order`, `header`, and the
  `content_*_id` reference) under a separate `non_html_items` key. They don't
  go into `content_items`, because push, preview, the Markdown export and
  content repos' tooling all read `item.file` from every entry there.
- Push refuses to PUT a file over an item that isn't `HTML` upstream.
- Tests use invented data only. Syncjar is public.

**Done** in the first PR on this branch. What it showed against a real instance:

- Quizzes are `QUIZ` content items inside `MODULAR` lessons, with the quiz id on
  the content item. The lesson-level `content_quiz_id` was null throughout, so
  legacy `QUIZ`-type lessons may not occur in practice. 1a should still warn
  when it meets one.
- **One quiz can be linked from more than one lesson.** Two lessons in one
  course pointed at the same quiz id. This rules out keeping a quiz file next
  to its lesson (see 1a).
- `SECTION` lessons exist and have no content items.

## Phase 1 — quizzes (the delivery)

### Step 1: experiments before any write code

Run these against a throwaway quiz created through the API and **not attached
to any lesson**, so no learner can see it. Delete it afterwards.

**Done** on 2026-09-28. The details are in `CLAUDE.md`, under "Quiz writes".

| Question | Answer |
|---|---|
| Can answers be changed in place? | **No.** PATCH and PUT with `answers` return 200 and change nothing. The only way is to delete and recreate the question, which gives it a new id. |
| Can question text, type and feedback be changed in place? | **Yes**, with PATCH, but only if the body includes `quiz`. Without it, PATCH is a 400. |
| How is question order set? | **By creation order only.** `order` in a PATCH is ignored, and a recreated question goes to the end. |
| Does recreating a question lose learners' attempt history or reporting? | **Partly.** Tested on a test course with a test learner. Scores and completions survive. The question's response history disappears from quiz analytics, and learners can no longer review their answers. An in-place PATCH keeps the question's history. Details in `CLAUDE.md`. |
| Does attaching a quiz to a lesson work through `POST /lessons/{id}/content-items`? | **Yes.** `type: QUIZ` with `content_quiz_id` returns 201, tested on a test course. It still can't be undone through the API. |
| Do quizzes use question banks? | **Not on the instance tested.** Banks can exist without any quiz using them, so 1a checks `/quizzes/{id}/question-banks` and warns if it finds one, rather than modelling banks in the file. |
| Does a quiz's question list need pagination? | Not in practice: every quiz tested had well under 100 questions. 1a still follows `next`. |

A 200 from a quiz write does not mean it happened, so every write in 1b and
1c is followed by a read that confirms it.

### Step 2 (1a): pull quizzes, read-only

**Done.** One file per quiz, `quiz-<id>.json`, in `QUIZ_CONTENT_PATH`: a
directory of its own, next to the course and path directories, not inside a
course.

- **Why not inside a course:** the first real pull found that sharing is the
  norm, not the exception. Bundle courses link the same quizzes as the courses
  they bundle, so a copy per course came to nearly three files per quiz, and
  each edit would have to be made in every copy. A quiz belongs to the
  organisation, as a learning path does, so it gets its own directory as paths
  do. Lessons point at it through the `content_quiz_id` in `non_html_items`.
- **What a pull writes:** a full pull writes every quiz in the organisation,
  linked or not. A quiz that 1c creates stays unattached until someone links
  it, and it still has to refresh. A `--course` pull writes only that course's
  quizzes. Only a full pull reports quizzes that aren't linked, and local
  files whose quiz is gone upstream (left in place, never deleted).
- **Cost:** `/quizzes` (1000 per page) and `/question-banks`, then one
  question list per quiz. The per-quiz bank check only runs when some bank's
  `quiz_association_count` is non-zero, so an organisation whose banks are all
  unused pays nothing for it.
- **Format:** quiz settings, then an ordered `questions` array (`id`, `type`,
  `html`, feedback and grading fields, and `answers` with `id`, `answer_text`
  and `correct`). There's no `order` field, because array order is the order,
  and upstream order can't be set anyway. Every field is written even when
  unset, so any pulled file works as a template for a new quiz.
- Repeating a pull rewrites identical bytes.
- The CI key is read-only, and that is enough: a nightly pull mirrors quizzes
  as soon as the content repo passes `QUIZ_CONTENT_PATH`.

**Downstream:** the quiz files contain answer keys, so the content repo's
visibility decides who can read them.

### Step 3 (1b): push edits to existing quizzes

**Done** in `npm run push:quizzes`, together with `--attach`. Tested live on a
test course: an in-place edit, a destructive edit refused and then allowed
with `--recreate`, and a create with `--attach`. What changed from the plan
below: the confirmation for destructive changes is per quiz, not per
question. Accepting some recreations and declining others would leave the
quiz in an order the file doesn't describe.

- Compare the local file with the upstream quiz (the same reads as 1a), and
  show a diff in the existing `render-diff.mjs` style.
- In-place writes: `PATCH /quizzes/{id}` for settings, and
  `PATCH /quiz-questions/{id}` (with `quiz` in the body) for `html`, `type`
  and feedback. These keep ids, so they are ordinary prompted changes.
- Answer changes, added questions and reordering can only be done by
  recreating questions. Recreating one question moves it to the end, so
  keeping the file's order means recreating that question *and every question
  after it*. The plan shows exactly which questions will be recreated. Each one
  needs its own confirmation, and none are ever part of a bulk "yes to all".
  `--force` does not apply to them. The prompt says what is lost: that
  question's response history in quiz analytics, and learners' review of
  their past answers. Scores and completions are kept.
- Removing a question from the file deletes it upstream, under the same rules.
- The branch guard and the `--dry-run` flag apply unchanged.

### Step 4 (1c): create new quizzes from local files

**Done** as `npm run push:quizzes`. Tested live on a probe quiz with all four
question types, which was then deleted. The rollback path (deleting a half-made
quiz) hasn't run live, because nothing sent was rejected.

- A file without an `id` (for example `quiz-new-<slug>.json`) means "create".
  The push sends `POST /quizzes`, then one `POST /quiz-questions` per question
  in file order (creation order *is* question order), then reads the quiz back
  to confirm it. It then rewrites the file with the new ids and renames it to
  `quiz-<id>.json`, so the next run treats it as an edit.
- A `quiz-new-*.json` file is written to `QUIZ_CONTENT_PATH` like any other.
  The next full pull then picks the created quiz up under its real id.
- **Creating and attaching are separate steps.** An unattached quiz is
  invisible to learners and can be deleted, so creating it is safe to repeat.
  Attaching it to a lesson can't be undone through the API. So 1c creates the
  quiz and stops there. Attaching through the API has since been shown to
  work, so a follow-up can add an explicitly confirmed `--attach <lesson>`
  that is never implied by `--force`.
- Creating avoids the answer-editing problem entirely, so **1c comes before
  1b**. It gets quiz authoring working soonest.

### Tests

Put the logic in export-only modules (for example `quiz-plan.mjs` and
`quiz-files.mjs`), following the rule in `CLAUDE.md`. Add them to
`import-without-credentials.test.mjs`, and use fixtures for the pull-shape,
diff and create-plan cases.

## Phase 2 — catalog and presentation (read-only first, own command)

Ordered by how often the content repo would want the data:

| Resource | Endpoints | Cost |
|---|---|---|
| Tags and labels | `/tags`, `/labels`, `/courses/{id}/labels`, `…/published-courses/{id}/tags` | 2 lists, plus 1 per course or published course if we want the mappings |
| Assets (metadata only, no binaries) | `/assets` | 1 list, which resolves the `content_asset_id` values Phase 0 starts recording |
| Rating blocks | `/lessons/{id}/rating-content-blocks` | 1 per lesson that has a `RATING` item, and only those (Phase 0 tells us which) |
| Catalog pages | `/domains/{d}/catalog-pages` and its content blocks | 1 per domain, plus 1 or 2 per page. This is the landing-page content the courses repo builds today, so pull it before pushing any of it. |
| Course series | `/domains/{d}/course-series` | 1 per domain |
| Question banks | `/question-banks` | 1 list, plus 1 per bank. Low priority: the instance tested had quizzes that didn't use banks. |

Each of these gets a `pull:<thing>` command in the style of `pull:paths`.
Writes come later, one resource at a time.

## Out of scope

Student data, enrolments, progress, groups, access codes, offers, promo codes,
purchases, licence packages, ILT/VILT sessions and webhooks. They are
operational, not content. The user tooling that exists (`sync-users`,
`revoke-access`, `export-students`) keeps its own rules in `CLAUDE.md`.
`POST /users/{id}/anonymize` stays off-limits.

## Suggested PR sequence

1. Phase 0: keep lesson metadata and non-HTML items, and correct the `CLAUDE.md`
   docs note. **Done.**
2. The Phase 1 experiments, written up in `CLAUDE.md` (no code). **Done.**
3. 1a: pull quizzes. **Done.**
4. 1c: create quizzes. **Done.**
5. 1b: edit quizzes. **Done.**
6. Phase 2, one resource per PR.
