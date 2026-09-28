# Plan: quizzes, and wider Skilljar API coverage

Status: proposal, 2026-09-28. Branch `feature/quizzes-and-api-coverage`.

## Where things stand

Syncjar calls three content collections — `/courses`, `/lessons`,
`/lessons/{id}/content-items` — plus paths, published courses/paths (for
slugs), and the user/group endpoints. The API has about 150 paths, and the
content-relevant gaps are below.

The machine-readable spec is at `https://api.skilljar.com/docs/schema.yml`
(OpenAPI 3, ~23k lines). `CLAUDE.md` says the docs can only be read in a
browser, which is true of the Redoc page and not of the spec it loads. Fix that
note as part of this work.

### We already fetch more than we keep

`sync-skilljar-to-local.mjs:138` keeps only content items with `content_html`:

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
- Record non-HTML content items as metadata entries (`id`, `type`, `order`,
  `header`, `content_quiz_id` / `content_asset_id`) instead of dropping them.
  They have no file, so `push` must skip them. It currently treats a
  `content_items` entry as an HTML file to send, and `id: null` entries as
  disk-only files, so both code paths need a type check.
- Pin both behaviours with fixtures in `test/fixtures`. Syncjar is public, so
  fixtures use invented quizzes, never real course content.

This is the smallest useful PR, and it tells us whether an instance's quizzes are legacy
`QUIZ`-type lessons (quiz id on the lesson), `QUIZ` content items inside
`MODULAR` lessons, or both. Phase 1 has to handle whatever it finds.

## Phase 1 — quizzes (the delivery)

### Step 1: experiments before any write code

Run these against a throwaway quiz created through the API and **not attached
to any lesson**, so no learner can see it. Delete it afterwards.

| Question | Why it matters |
|---|---|
| Can answers be changed in place? | The `PUT /quiz-questions/{id}` description says it modifies "answers", but its request schema has no `answers` field and `answers` is read-only on the response. If answers can't be edited in place, changing one means deleting and recreating the question. |
| Does recreating a question lose learners' attempt history or reporting? | If it does, editing answers on a live quiz is a destructive act, and `push` has to treat it that way: warn, and require confirmation. |
| How is question order set? | `order` is read-only and nothing in the create request sets it. If order is creation order, reordering also means recreating. |
| Does attaching a quiz to a lesson work through `POST /lessons/{id}/content-items` with `type: QUIZ` and `content_quiz_id`? | This is how a new quiz becomes visible. It needs confirming for both lesson types. |
| Do question-bank questions show up in `/quizzes/{id}/questions`, or only through `/quizzes/{id}/question-banks`? | This decides whether a quiz file has to model banks. |

Record the answers in `CLAUDE.md` in the same style as the `modified_at`
section. They are exactly the kind of trap that section exists for.

### Step 2 (1a): pull quizzes, read-only

- `GET /quizzes?page_size=1000` returns every quiz and its settings.
- For each quiz referenced by a lesson, `GET /quizzes/{id}/questions` returns
  questions with their answers. Unreferenced quizzes are listed in a report and
  not written, so that orphans and drafts don't flood the content repo.
- On-disk format: `lessons/<lesson-slug>/quiz-<quiz_id>.json`, next to that
  lesson's `content-<id>.html` files. It holds the quiz settings plus an ordered
  `questions` array (`id`, `type`, `html`, feedback fields, and `answers` with
  `answer_text` and `correct`).
  - The file goes inside the course folder rather than in a new top-level
    directory because Syncjar only knows `COURSE_CONTENT_PATH` and
    `PATH_CONTENT_PATH`, so a new location would need a new variable in every
    content repo that wraps it.
  - It is JSON, sorted and pretty-printed, to match `details.json` and
    `lessons-meta.json` and to diff cleanly. If writing questions as HTML
    strings inside JSON turns out to be unpleasant, an authoring format
    (Markdown or YAML) can be converted into this file later. It doesn't change
    anything else.
- The CI key is read-only, and that is enough: the nightly sync starts
  mirroring quizzes as soon as this merges.

**Downstream, before 1a runs against a content repo:** the quiz files contain
answer keys, so that repo's visibility decides who can read them. Its linters
also need to ignore `lessons/**/quiz-*.json`, or lint it deliberately.

### Step 3 (1b): push edits to existing quizzes

- Compare the local file with the upstream quiz (the same reads as 1a), and
  show a diff in the existing `render-diff.mjs` style.
- Writes: `PATCH /quizzes/{id}` for settings and `PATCH /quiz-questions/{id}`
  for question fields. Answer changes and reordering follow whatever the
  experiments found. If they need a delete and recreate, that goes behind an
  explicit per-question confirmation, and it is never part of a bulk "yes to
  all".
- The branch guard and the `--dry-run` flag apply unchanged.

### Step 4 (1c): create new quizzes from local files

- A file without an `id` (for example `quiz-new-<slug>.json`) means "create".
  The push sends `POST /quizzes`, then one `POST /quiz-questions` per question
  in order, then attaches the quiz with a `QUIZ` content item. It then rewrites
  the file with the new ids and renames it to `quiz-<id>.json`, so the next run
  treats it as an edit. This matches how new HTML content items get their ids.
- Creating is simpler than editing, because there's no answer-editing problem.
  **If you want to start writing quizzes soon, 1c can come before 1b.**

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
| Question banks | `/question-banks` | pulled with quizzes in Phase 1 if the experiments show quizzes use them, otherwise here |

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
   docs note.
2. The Phase 1 experiments, written up in `CLAUDE.md` (no code).
3. 1a: pull quizzes.
4. 1c: create quizzes.
5. 1b: edit quizzes.
6. Phase 2, one resource per PR.
