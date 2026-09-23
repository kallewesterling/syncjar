# syncjar — working notes

Local-first tooling for Chainguard's Skilljar instance (Chainguard Courses).

## Branches and versions

`main` is the release branch and the repo default. `dev` is the integration
branch. Work flows feature → `dev` → `main`, and PRs base on `dev` unless the
change is a hotfix.

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
