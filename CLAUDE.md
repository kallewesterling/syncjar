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

`scripts/skilljar-client.mjs` authenticates with HTTP Basic using `SKILLJAR_API_KEY`.
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
   (exported from `scripts/skilljar-client.mjs`), which prints status and a
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

Full endpoint reference: <https://api.skilljar.com/docs/> (JavaScript-rendered, so
`curl`/fetch returns an empty shell; open it in a browser).

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

## Importing a script runs it

Every file in `scripts/` ends in a top-level `(async () => { … })()`, so
`import()`ing one executes it. `node -e "import('./scripts/sync-skilljar-to-local.mjs')"`
is not a syntax check — it is a full pull, overwriting the course content tree.
Use `node --check <file>` to check syntax, and `node --test` for behaviour.

This is also why the logic worth testing lives in modules that export
functions and do nothing on import (`push-plan.mjs`, `push-args.mjs`,
`push-state.mjs`, `skilljar-fetch.mjs`, `render-diff.mjs`, `course-dirs.mjs`,
`branch-guard.mjs`, `concurrency.mjs`) rather than in the entry-point
scripts. Put new logic there.

Where a script must be importable — `sync-users.mjs` is, for its merge logic
— guard the entry point:

```js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
```

**And build the Skilljar client lazily, not at module scope.**
`createSkilljarClient()` throws when `SKILLJAR_API_KEY` is unset, so an eager
one makes the module unimportable on any machine without a `.env` — which
is every CI runner. `sync-users.mjs` did exactly that, and the whole suite
passed locally and failed on its first CI run.
`test/import-without-credentials.test.mjs` now imports each of these modules
in a child process with the key stripped and the cwd moved away from the
repo, so a `.env` cannot mask it again.

## Read lists, not objects

Skilljar exposes courses, lessons and content items both per-object and as
paginated lists. The per-object form reads naturally in a loop, and `push` was
written that way: 1,537 round trips at ~380ms, about ten minutes to check 66
courses. `scripts/skilljar-fetch.mjs` holds the list reads both sync scripts
use — prefer them, and do not add a `GET /courses/{id}` or `GET /lessons/{id}`
to a loop.

Two dead ends recorded there so they aren't rediscovered: `GET /lessons`
carries a `content_html` field that is empty for `MODULAR` lessons (all of
ours), so content costs one request per lesson no matter what; and lessons and
content items carry no timestamps at all, so `modified_at` on a course is the
only freshness signal the API offers.

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
- For a straight roster, `scripts/export-students.mjs` is still the cheaper
  path: one sweep of `/users` rather than N × (1 + courses) requests.
