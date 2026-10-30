# syncjar — working notes

Local-first tooling for Chainguard's Skilljar instance (Chainguard Courses).

## Branches and versions

`main` is the release branch. `dev` is the integration branch **and the repo
default**. Work flows feature → `dev` → `main`, and PRs base on `dev` unless
the change is a hotfix.

`dev` is the default on purpose. A new PR — and any bot that opens one —
targets the default branch, so making it `dev` means nothing arrives on
`main` un-integrated. `chainguard-dev/courses` has the opposite arrangement
and documents the cost: `main` is default there, so Dependabot, the weekly
link check and the nightly Skilljar sync all open against `main`, those are
the merges that go un-back-merged, and `dev` silently falls behind while git
reports nothing wrong.

Both branches are protected: pull requests required, no force-pushes, no
deletions, and admins are not exempt. Approvals are not required, since a
single maintainer cannot approve their own PR. CI (`.github/workflows/test.yaml`)
runs the test suite on every PR to either branch.

**A back-merge of `main` into `dev` must be merged with a merge commit, not
squashed.** Squashing it produces a new commit with no link to `main`'s
history, so `main` stops being an ancestor of `dev` and the next release
cannot fast-forward — which is how the divergence starts over.

**A branch names a role, never a version.** The integration branch was called
`v2.0` until 2026-09-23, which collided with the release it was named after:
the branch is permanent and the version is not, so "is this 2.1?" had no
answer that wasn't also a question about the branch. It is `dev` now, and a
`v2.1` branch should not be created when 2.1 comes round — 2.1 is a tag on
`main`.

Releases are tags on `main`, cut from a merged `dev`:

```bash
# on main, after dev has merged
git tag -a v2.0.0 -m "syncjar 2.0.0" && git push origin v2.0.0
```

At that moment, and not before:

- promote `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`,
  and open a fresh empty `[Unreleased]` above it;
- set `version` in `package.json` to match the tag.

`package.json` therefore lags `dev` on purpose: it records the last release,
not the work in flight. Nothing had ever been tagged before 2.0.0 — including
`1.0.0`, which exists only as a `CHANGELOG.md` heading — so treat the tag
history as starting there.

## CRITICAL: never let a raw axios error reach the console

`src/lib/skilljar/client.mjs` authenticates with HTTP Basic using `SKILLJAR_API_KEY`.
A raw axios error holds `config`, `request` and `response.headers`, and
`config.headers.Authorization` is `Basic <base64 of the key>` — so an
**unhandled rejection prints the key** in trivially recoverable form. Measured
on a fake key before this was fixed: 12 occurrences in one stack trace.

A key that reaches a terminal, a log, or a CI transcript has to be treated as
compromised and rotated.

There are now two layers, and both matter:

1. **The client redacts on the way out.** `redactError()` rebuilds every
   rejected error without `config`, `request` or `response.headers`, keeping
   `message`, `code`, `method`, `url`, `response.status`, `response.statusText`,
   `response.data` and the original stack. So even a forgotten `try/catch` — or
   a throwaway `node -e` one-liner, which is the easiest place to forget —
   cannot print the key. `test/skilljar-client.test.mjs` pins this, including a
   test that asserts the *unredacted* shape does leak, so the others can't pass
   vacuously.
2. **Callers still catch.** Redaction stops the leak; it does not make a
   half-finished sync a good outcome. Route failures through `failCleanly()`
   (exported from `src/lib/skilljar/client.mjs`), which prints status and a
   short body and exits 1.

So when adding a call:

- Wrap it, and say in the catch's context string what was being attempted.
- Print `err.response?.status` and a short body only. Never the error object,
  `err.config`, or `err.request` — redaction is a backstop, not a licence.
- Do not weaken `redactError()` to pass something through "just for debugging".
  Add a field to the safe object instead, and check it cannot carry the header.

## API paths: no `/v1` prefix

`skilljar-client.mjs` sets `baseURL` to `https://api.skilljar.com/v1`. Paths passed
to the client must therefore be **relative to that**:

- ✅ `client.get('/groups/{id}/users')`
- ❌ `client.get('/v1/groups/{id}/users')` → resolves to `/v1/v1/…` → 404

Full endpoint reference: <https://api.skilljar.com/docs/>. That page is
JavaScript-rendered, so `curl` gets an empty shell, but the OpenAPI spec it
loads is plain YAML and greps well:
`curl -s https://api.skilljar.com/docs/schema.yml`.

## API v2: scoped OAuth clients, and what they can't do

`src/lib/skilljar/client-v2.mjs` talks to `https://api.skilljar.com/v2`
(spec: `curl -s https://api.skilljar.com/v2/openapi.json`). It does not take
the v1 key. `SKILLJAR_CLIENT_ID` and `SKILLJAR_CLIENT_SECRET` are exchanged at
`POST /v2/auth/token` for a JWT that lasts 900 seconds, and every operation
needs a named scope on that client. A client can therefore be issued for one
job, which is why `group:add` and `group:remove` use v2: the partner team can
hold a client that changes group membership and nothing else.

Observed on 2026-10-30:

- **The token response carries no `scope`**, so a missing scope only shows
  up as a 403 (`permission_denied`) on the call that needs it. A client with
  `student-groups:*` but not `students:read` reads groups and then fails the
  email lookup.
- **An inactive client is a 401** `invalid_client`, "Client is inactive."
- **v2 cannot list a group's members.** There is no GET on
  `/groups/{id}/relationships/students/`, only POST and DELETE, which take
  student ids, not emails. Hence the per-email `GET /students/?filter[email]=`.
- **Content ids are shared with v1; student ids are not.** Checked against
  the whole local course tree: all 74 courses, 698 lessons and their
  content items, 136 quizzes, and one quiz's questions and answers have the
  same id in both. Five of five students had a different v2 id from their v1
  user id. Never pass a v1 user id to a v2 call; look the student up by
  email.
- **A group's `rule_email_domains` is written whole.** `PATCH /groups/`
  replaces the array, so `group:domains` re-reads it after the prompt and
  aborts if it moved, then reads back. v1 has a true add/remove
  (`PATCH /v1/groups/{id}/email-domain-rules` with `add`/`remove`), but it
  needs the v1 key, which is what v2 is here to avoid.

Established on 2026-10-30 against a throwaway group created with
`POST /v2/groups/` and deleted afterwards, with every other group
snapshotted before and diffed after (none moved, `modified_at` included):

- A PATCH of only `rule_email_domains` changed that field and `modified_at`
  and nothing else. `group:domains` added a domain to an empty list, swapped
  one for another, and removed the last one; each read back as written.
- **The list can be cleared**: removing the last domain reads back as `[]`,
  not an error, unlike the course fields that cannot be blanked.
- The create response's attributes omit `category_id`; a read returns it as
  `null`. Compare reads with reads.
- `DELETE /v2/groups/` with `{ data: [{ type: 'groups', id }] }` returned 200
  with `status: deleted`, then 404 on read. It is a **hard, batch delete**
  that cascades memberships and visibility, so a script that calls it must
  only ever pass an id it created itself.

`group:add` and `group:remove` were tested the same way, the same day, with
one real account (the maintainer's) in a throwaway group:

- **Adding an existing member returns the original membership**: same
  membership id, same `created_at`, status `succeeded`. That is the only
  signal that a student was already in the group, so `alreadyMemberCutoff`
  compares `created_at` with the response's `Date` header (Skilljar's clock,
  in whole seconds) less the request time and 2s of slack. A membership made
  within ~3s of the run still reads as new; without the header the cutoff
  falls back to 5 minutes on the local clock.
- **Removing a non-member also returns `deleted`**, with the student's id,
  so a remove cannot report who was not in the group.

## lessons-meta.json: `content_items` means files

Every entry in a lesson's `content_items` names an HTML file, and every
consumer — push, preview, the Markdown export, and content repos' own tooling —
reads `item.file` from each one. Quiz, asset and rating content items have no
file, so the pull records them under `non_html_items` instead
(`src/lib/content/lesson-meta.mjs`). Keep it that way rather than adding typed entries
to `content_items`, which would break each of those readers.

Push also refuses to PUT a file whose upstream item is not `HTML`, because
the PUT sends `type: 'HTML'` and would replace a quiz with a page.

## Destructive operations

- `POST /users/{id}/anonymize` is **irreversible PII erasure**. Do not call it.
- Deactivation is domain-scoped and reversible:
  `PATCH /domains/{domain}/users/{user_id}` with `{"active": false}`.
  There is no account-level deactivate in v1 — `PATCH /users/{id}` only accepts
  `email`, `first_name`, `last_name`.
- Group removal: `DELETE /groups/{group_id}/users/{user_id}`.
- Any script that writes to student records should: dry-run by default, preflight
  with live GETs before iterating, require typed confirmation, and write a
  per-run audit CSV recording prior state.

## Data hygiene

- `public/data/` is gitignored. Write student exports **there**, never to the repo
  root, which is not ignored.
- Student exports contain real names and email addresses. Delete them when the
  task is done; they regenerate from the API in one command.

## Importing a command runs it

The directory says which kind of file you are looking at:

- **`src/commands/`** — one file per npm script, named for it: `push:quizzes`
  is `src/commands/push/quizzes.mjs`, and a bare `push` is
  `src/commands/push/index.mjs`. Most end in a top-level
  `(async () => { … })()`, so `import()`ing one executes it.
  `node -e "import('./src/commands/pull/index.mjs')"` is not a syntax check —
  it is a full pull, overwriting the course content tree. Use
  `node --check <file>` to check syntax, and `node --test` for behaviour.
- **`src/lib/`** — modules that export functions and do nothing on import.
  The logic worth testing lives here, not in the commands. Put new logic here.
  Import it as `#lib/<path>.mjs` (the `"imports"` map in `package.json`), from
  commands and tests alike, so a file's depth never shows up in its imports.

Resolve default paths such as `public/data/` against `workRoot` from
`#lib/paths.mjs`, not `path.join(__dirname, '..')`, which silently points
somewhere else as soon as a command moves to a different depth. `workRoot`
is the clone when running from one, and the current directory under a
global `npm install`, whose directory `syncjar update` replaces — so
anything written there, student exports included, would vanish on the next
update. `repoRoot` is the install itself; only the preview commands, which
serve its tracked `public/` files, use it, and `bin/syncjar.mjs` refuses to
run them outside a clone (`CHECKOUT_ONLY` in `#lib/cli.mjs`).

## The `syncjar` command

`bin/syncjar.mjs` runs npm scripts as subcommands, reading the list from
`package.json` (`commandTable` in `#lib/cli.mjs`), so a new script needs no
CLI change. Each command runs as a child process with the user's options
passed through.

`syncjar update` installs `github:<repo>#<ref>` with `npm install --global`
(default ref `main`). It first fetches `package.json` at that ref and refuses
if it has no `bin.syncjar`. That was observed in a throwaway prefix:
installing `dev` from before the CLI existed removed the `syncjar` command
entirely, which leaves no `syncjar update` to recover with. So the default
`main` only becomes usable once a release containing the CLI is tagged; until
then, install and update with `--ref` pointing at a branch that has it.

Where a command must be importable — `sync/users.mjs` is, for its merge
logic, and `pull/paths.mjs` for its matching and comparison helpers — guard
the entry point:

```js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
```

**And build the Skilljar client lazily, not at module scope.**
`createSkilljarClient()` throws when `SKILLJAR_API_KEY` is unset, so an eager
one makes the module unimportable on any machine without a `.env` — which
is every CI runner. `sync-users.mjs` did exactly that, and the whole suite
passed locally and failed on its first CI run.
`test/import-without-credentials.test.mjs` now imports every module under
`src/lib/`, plus the two importable commands, in a child process with the key
stripped and the cwd moved away from the repo, so a `.env` cannot mask it
again. It walks the directory rather than keeping a list, so a new module is
covered the day it is added.

## Read lists, not objects

Skilljar exposes courses, lessons and content items both per-object and as
paginated lists. The per-object form reads naturally in a loop, and `push` was
written that way: 1,537 round trips at ~380ms, about ten minutes to check 66
courses. `src/lib/skilljar/fetch.mjs` holds the list reads both sync scripts
use — prefer them, and do not add a `GET /courses/{id}` or `GET /lessons/{id}`
to a loop.

Two dead ends recorded there so they aren't rediscovered: `GET /lessons`
carries a `content_html` field that is empty for `MODULAR` lessons (all of
ours), so content costs one request per lesson no matter what; and lessons and
content items carry no timestamps at all, so `modified_at` on a course is the
only freshness signal the API offers.

## Pulls write atomically — never truncate a content file in place

`fs.writeFile`, and fs-extra's `outputFile`, `outputJson` and `writeJson`,
open the target with `O_TRUNC` and then write. Every pull used them. On
2026-10-28 a Ctrl+C during `pull` left two lesson files at 0 bytes. Git shows
that as an ordinary edit deleting every line, and a `push` of that commit
empties the live lesson. A cancelled nightly CI sync can do the same.

So every file a pull writes (`pull`, `pull:slugs`, `pull:paths`, quizzes
included) goes through `writeFileAtomic` / `writeJsonAtomic` in
`src/lib/content/atomic-write.mjs`. Each one writes a temp file in the same
directory, flushes it, and renames it over the target. Temp files are named
`.<name>.syncjar-<12 hex>.tmp`, so they are dotfiles that no `.html`/`.json`
reader matches. Each pull removes any left by a killed run before it starts.
`writeJsonAtomic` output is byte-identical to `outputJson(…, { spaces: 2 })`,
so switching caused no churn. A pull into a copy of the courses repo diffed
clean. When adding a pull-side write, use these helpers rather than fs-extra.

As a second guard, `src/lib/content/empty-content.mjs` stops pull replacing a
non-empty content file with an empty one on one read. Pull's content comes
from the content-items list with `include_content`, which the spec doesn't
document, and `GET /lessons` has already shown that a list's `content_html`
can be empty when the content isn't. So an empty value over a non-empty file
is confirmed with the documented `GET /lessons/{id}/content-items/{id}`. If
that read has content, pull writes it. If it returns `''`, the item really is
empty, and pull writes the empty file with a warning. If it fails, or returns
no field, pull keeps the file, warns, and exits 1.

## `modified_at` is not proven to track content edits — keep it non-load-bearing

`push` skips courses recorded as in sync (`push-state.mjs`), keyed on a local
content hash *and* the course's upstream `modified_at`. It is tempting to lean
harder on that timestamp — to skip on it alone, or to use it to decide what to
pull. Don't, without settling this first.

**It has never been established that editing a content item in the Skilljar
web UI bumps its parent course's `modified_at`.** The obvious place to look is
the content repo's nightly-sync history, and it cannot answer: across every
sync commit, no *pre-existing* course has ever had its normalised content
change upstream. The cell is empty. (The cases that look like evidence are
newly added courses, where there is no prior record to compare, and
trailing-newline churn from the pull's own writes, which `normalizeHtml`
correctly calls unchanged.) Settling it needs a deliberate content-only push
followed by a read of the course record.

The current design is safe without an answer, because **a skipped course is
never written to** — the worst a wrong skip does is not report drift, and
`pull` is what reconciles drift anyway. Any future use of `modified_at` that
decides to *write*, or to *not pull*, loses that property and needs the
experiment run first.

## Settings writes

Established on 2026-10-28 and 2026-10-29 against throwaway objects published
only on the staging domain: a course, two lessons in it, and a path. Every
field was set back afterwards.

- **`PATCH /courses/{id}` is a true partial update.** A body of only
  `{ "enforce_sequential_navigation": true }` returned 200, and both the
  response and a separate read changed that field and `modified_at` and
  nothing else: title, descriptions, labels and the course-time fields were
  untouched. Setting it back restored the record, apart from `modified_at`.
- **Published state is not on the course object.** It lives on
  `/domains/{domain}/published-courses`, and those records did not change.
- **Do not use `PUT /courses/{id}`.** The spec makes `title`,
  `short_description` and `enforce_sequential_navigation` required for it, so
  a settings change by PUT would also rewrite the title and description.
- **The write bumps `modified_at`.** So a course whose setting is pushed is
  rescanned once by the next `push`, which is the safe direction.
- **Skilljar trims strings.** `" x"` is stored as `"x"`, so a read-back
  comparison of a string field must trim.

Every other field in `PatchedCourseRequest`, and every field in
`PatchedPublishedCourseRequest`, was then tested the same way: set, read both
records back, restore, read again.

| Field | Result |
|---|---|
| Course: `display_course_and_lesson_time`, `display_manual_course_time` | Round-trip cleanly. They also recompute the read-only `course_time`: with the manual flag on it reads `manual_course_time`. |
| Course: `labels` | Round-trips cleanly with an existing label; no label was created. **What an unknown label name does is untested** — it may create an organisation-wide label. |
| Course: `title`, `long_description_html` | Round-trip cleanly. The published record's embedded copy of the course follows. |
| Course: `short_description`, `manual_course_time` | **Can be set, cannot be cleared:** `""` is a 400, "may not be blank". |
| Course: `course_and_lesson_time_format` | **Can be set, cannot be cleared:** `null` is a 400, "may not be null". |
| Published: `hidden`, `strict_enforce_group_visibility`, `registration_required`, `restrict_access_start_end_dates`, `allow_self_service_reenroll`, `unique_progress_per_enrollment`, `require_all_prerequisites` | Round-trip cleanly. |
| Published: `slug` | Round-trips cleanly; `course_url` follows. |
| Published: `registration_starts_at`, `registration_ends_at` | **Can be set, cannot be cleared:** `null` and `""` are both a 400. A future start date also closed registration (`offer.registration_open` went false). |

Two dead ends for clearing those fields: `PUT /courses/{id}` that omits them
leaves them as they were rather than resetting them, and
`PUT /domains/{d}/published-courses/{id}` is a 400 on the course's own
unchanged slug ("A published course with this slug already exists"), so PUT
is unusable there. Clearing them takes the dashboard.

Paths, published paths and lessons, tested the same way:

| Field | Result |
|---|---|
| Path (`PATCH /paths/{id}`): `title`, `short_description`, `long_description_html`, `header_html`, `course_name_singular`, `course_name_plural` | Round-trip cleanly. Unlike a course's, a path's `short_description` can be blanked again. The published path's embedded copy of the path follows. |
| Published path: `hidden`, `strict_enforce_group_visibility`, `unique_progress_per_enrollment` | Round-trip cleanly. |
| Published path: `slug` | Round-trips cleanly; `path_url` follows. |
| Lesson (`PATCH /lessons/{id}`): `optional`, `description_html`, `tooltip_html`, `title`, `time_seconds`, `search_keywords`, `display_fullscreen`, `order` | Round-trip cleanly, with no `course_id` needed in the body. `optional` also changes the published course's required-lesson count. `order` moved only the lesson written; the others were not renumbered. |

A path's id and its published-path id are different ids. A path's
`GET /paths` id is what `PATCH /paths/{id}` takes; the id in
`/domains/{d}/published-paths` is the published path's own. On some paths
the two are equal, which hides the difference.

**A path with no visible course on a domain has its registration closed
there** (`offer.registration_open` false). Recorded on 2026-10-28 by hiding a
staging path's only course and unhiding it again. So hiding a path's last
visible course closes the path.

What writes these, and from where:

| Command | Writes | From |
|---|---|---|
| `push:course-settings` | `enforce_sequential_navigation`, the two course-time display flags, `labels` | each course's `details.json` |
| `push:paths` | the six path fields above | each path's `details.json` |
| `push:lesson-settings` | `optional`, `description_html`, `tooltip_html` | each course's `lessons-meta.json` |
| `push:published-settings` | `hidden`, `strict_enforce_group_visibility` | each course's and path's `published.json`, per domain |

All four share `src/lib/push/settings.mjs` (planning and read-back) and
`settings-run.mjs` (branch guard, one prompt, stop at the first failed write).
Each reads every written record back and fails on a value that did not land
or any other field that moved. `push:course-settings` allows `course_time` to
move when a display flag was written, and `push:published-settings` ignores
`offer.registration_open`, which it warns about before the prompt instead.
`push:course-settings` refuses labels that `GET /labels` does not list, rather
than find out what an unknown one does.

Left out on purpose:

- **Fields that cannot be cleared.** A push of one is a change nobody can
  undo through the API.
- **Slugs.** Writable, but a change breaks every link to the course or path.
- **Lesson titles.** `push` already writes them.
- **Lesson `order`.** Reordering is a different job from flipping a setting.
- **Lesson `time_seconds`, `search_keywords`, `display_fullscreen`.** No
  lesson uses them.
- **The uniform published-course settings** (`registration_required` and the
  rest). They are the same on every course, so `check:settings` reports the
  odd one out instead of anyone editing them from git.

Before adding a field, check it is in the matching `Patched…Request` schema in
the spec, and test it the same way: set it on a throwaway object, read it
back, diff the whole record and every record that embeds it, set it back.
`push` does not touch these settings, and its skip-state fingerprint does not
hash them, so adding them there would force a full rescan of every course
once.

`check:settings` is read-only. It works out the norm from the catalog, rather
than hardcoding one organisation's values: when one value covers at least 90%
of records (`--threshold`), every record with another value is listed. Truly
split settings such as `hidden` are reported as varying.

## Quiz writes: what the API does, as opposed to what the spec says

Established on 2026-09-28 against throwaway quizzes that were never attached
to a lesson, then deleted. The spec is wrong or silent on most of this.

- **`PATCH /quiz-questions/{id}` needs `quiz` in the body**, even though the
  question already belongs to one. Without it, every PATCH is a 400: `You must
  pass either a quiz or a quiz_question_bank`.
- **With `quiz`, PATCH edits `html`, `type` and the feedback fields in place.**
  The question id is unchanged.
- **Answers cannot be edited.** PATCH and PUT with an `answers` array both
  return 200 and change nothing. There is no answer endpoint. Changing an
  answer means deleting the question and creating it again, which gives it a
  new id.
- **Order cannot be set.** `order` in a PATCH is also accepted and ignored.
  Questions are ordered by creation (`order` 10, 20, 30, …), and a recreated
  question goes to the end. So changing one answer in the middle of a quiz
  also moves that question to the end, unless everything after it is
  recreated too.
- **A 200 does not mean the write happened.** Because of the two points above,
  every quiz write must be followed by a read that confirms the change, and a
  mismatch is a failure, not a warning.
- **Content items cannot be deleted.** `/lessons/{id}/content-items/{id}` has
  GET, PUT and PATCH and no DELETE, so attaching a quiz to a lesson cannot be
  undone through the API. Only deleting the lesson or course removes it.
- **Attaching works:** `POST /lessons/{id}/content-items` with
  `{ type: 'QUIZ', content_quiz_id, header, order }` returns 201, and the quiz
  shows in the lesson straight away. `header` must not be blank: `''` is a 400
  (`This field may not be blank.`), even though items attached in the UI can
  have an empty header. `push:quizzes --attach` uses the quiz name.
- **`DELETE /quizzes/{id}` works** and returns 204, then 404 on read.
- **Deleting a course in the UI leaves its contents behind.** Seen on
  2026-09-29: after a course was deleted in the dashboard, `GET /courses/{id}`
  was a 404 and the course had left `GET /courses`. But its lessons still
  read back with `GET /lessons/{id}`, still listed under
  `GET /lessons?course_id=`, and still linked their quizzes, and the quizzes
  were untouched. A quiz is an organisation-level object, so nothing removes
  it with the course. Since a full pull writes every quiz, including unlinked
  ones, a deleted course's quizzes keep arriving in the quiz directory. The
  cleanup is `DELETE /lessons/{id}` for each lesson, which removes its quiz
  links, then `DELETE /quizzes/{id}` for each quiz nothing else uses. Both
  return 204, then 404 on read. Pull won't see the orphaned lessons, because it
  starts from the course list.

### Validate what a run would write, not every file it can see

Skilljar holds quizzes that `push:quizzes`' own rules reject: empty
descriptions, `LINEAR_SCALE` questions on feedback forms, `MULTIPLE_ANSWER`
survey questions with no correct answer, empty "Untitled Quiz" shells. A pull
writes them faithfully. From #25 until the fix, every pulled file was
validated before anything was compared, so 26 such files, none edited, made
every run without `--file` fail with "Nothing was written".

So `src/lib/push/quiz-select.mjs` ties validation to writes:

- **Drafts** (`quiz-new-*.json`) are always written, so all of them are
  validated first, and one bad draft stops the run.
- **Pulled files** are validated after they are planned against a fresh read,
  the read push makes anyway, and only matter if the plan has changes. A
  failure refuses that quiz alone. A file with no changes is never written,
  so its problems are only a warning. A file skipped through
  `.syncjar-quiz-state.json` was proven in sync when it was recorded, and is
  treated the same way.

Don't move pulled-file validation back ahead of the comparison, and don't
relax the rules for drafts so that pulled files pass. Unsupported types such
as `LINEAR_SCALE` stay unsupported for writes, because what a POST or PATCH
does with them has not been established.

### What an edit does to learners who already took the quiz

Established on 2026-09-29 against a test course with one test learner, who
scored 2 of 3 before each change. Checked in the dashboard, because **the API
exposes no quiz attempts**: lesson progress has `score` and `max_score`, but
they stay null for a quiz inside a MODULAR lesson.

| Change | Attempt score and completions | That question's response history | Learner can review their answers |
|---|---|---|---|
| PATCH in place (`html`, feedback, `type`) | kept | kept, shown under the new wording | not isolated (see below) |
| Delete and recreate (the only way to change answers or order) | kept | **lost**: gone from quiz analytics; the new question starts at 0 responses | **no**: "This has been modified since you last took it. As a result, the answers are unavailable." |

So on a quiz learners have taken, recreating a question costs its analytics
history and learners' ability to review their answers. It does not cost
scores or completions. Show each recreate, require confirmation for it, and
never include it in a bulk yes. An in-place PATCH keeps the question's
history and can be an ordinary prompted change.

Not isolated: whether an in-place PATCH alone also hides the learner's
answers. The quiz tested had already been recreated, which had hidden them.
Assume it does, and treat any edit to a taken quiz as ending answer review
for past attempts.

## Check the checkout before pushing

`push` writes to a live LMS with whatever code is checked out. A stale working
tree does not fail — it succeeds at the wrong thing. The pre-rewrite tree (see
below) had no `<pre>` whitespace preservation, hardcoded Skilljar domains, and
no branch guard, so a push from it would mangle code blocks and silently
overwrite live content while reporting success.

So before any push, confirm the branch is current with its remote:

```bash
git fetch origin && git status -sb   # want: "## dev...origin/dev" with no ahead/behind
```

A bare `## <branch>` with no `...origin/<branch>` means the branch has no
upstream at all, so that line is telling you nothing about how current it is.

The same applies to the **course content repo** — `push` reads content from
`COURSE_CONTENT_PATH`, so its branch is what decides what lands in Skilljar.
The branch guard in `sync-local-to-skilljar.mjs` checks *which* branch that repo
is on, but not whether it is up to date, so a stale local `dev` still overwrites.

### Clones predating the 2026-09 history rewrite are on orphaned commits

The internal Skilljar test hostname was purged from history and every branch was
force-pushed (see the CHANGELOG). Any clone from before that is carrying the old
SHAs, and **the divergence is invisible**: same file contents, same commit
subjects, different SHAs. `git log` looks perfectly normal.

It surfaces later as a misleading error — `fatal: Not possible to fast-forward`,
which reads like an ordinary "you're behind, pull first" rather than "this branch
is on discarded history." It bit once already, during a `gh pr merge` that had
in fact **merged successfully** on the remote and only failed while updating the
local branch afterward, leaving the tree checked out on pre-rewrite code.

Check with `git rev-list --left-right --count <branch>...origin/<branch>`. Any
local-ahead count on a branch you never committed to means orphaned history;
`git reset --hard origin/<branch>` is the fix. Verify nothing is unique to the
local side first — `comm -23` over `git ls-tree -r --name-only` for each side —
and note the old tip stays in the reflog.

Delete this section once every working clone is known to postdate the rewrite.

## The user export used to be silently partial (fixed)

`sync-users.mjs` skipped users whose per-user cache file already existed without
adding them to `processed`, and `processed` was what got written to
`user-progress.json` — the file `export-users-to-csv.mjs` reads. So every re-run
produced a CSV covering only the users fetched that run. In this repo it had
degraded to 36 of 1,764 users, a 2% export that looked like a clean result.

`user-progress.json` is now built by reading every per-user file back off disk
(`readAllCachedUsers`), so it is complete regardless of how many partial or
resumed runs built the cache up, and the run warns when it covers fewer users
than the API returned. `test/sync-users.test.mjs` pins the behaviour.

Two things to keep in mind:

- The per-user cache never expires. Files are reused indefinitely, so progress
  data goes stale until you delete `public/data/user-progress/`.
- For a straight roster, `npm run export:students` is still the cheaper
  path: one sweep of `/users` rather than N × (1 + courses) requests.
