# syncjar — working notes

Local-first tooling for Chainguard's Skilljar instance (Chainguard Courses).

## CRITICAL: never let a raw axios error reach the console

`scripts/skilljar-client.mjs` authenticates with HTTP Basic using `SKILLJAR_API_KEY`.
An **unhandled axios rejection prints the entire request object**, including the
`Authorization: Basic …` header, which contains the API key in trivially
recoverable form.

A key that reaches a terminal, a log, or a CI transcript has to be treated as
compromised and rotated. Assume it will happen unless the call is wrapped.

So:

- **Every** call through `createSkilljarClient()` must be wrapped in `try/catch`.
- Catch blocks print `err.response?.status` and a short body only. **Never** the
  error object, `err.config`, `err.request`, or any headers.
- This applies to throwaway `node -e` one-liners just as much as to committed
  scripts. Ad-hoc commands are the easiest place to forget.

Minimum safe shape for an ad-hoc command:

```bash
node -e "import('./scripts/skilljar-client.mjs').then(async m=>{
  const c=m.createSkilljarClient();
  try{const r=await c.get('/ping');console.log(r.status,r.data);}
  catch(e){console.error('HTTP',e?.response?.status,e?.response?.data??e.message);}
})"
```

See `failCleanly()` in `scripts/revoke-access.mjs` for the pattern used in scripts.

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
git fetch origin && git status -sb   # want: "## v2.0...origin/v2.0" with no ahead/behind
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
