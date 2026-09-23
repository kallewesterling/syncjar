# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries for 1.0.0 and earlier were reconstructed from git history after the
fact, so they group related commits rather than listing each one. Nothing was
tagged before 2.0.0, `1.0.0` included — it exists only as the heading below.

Releases are tags on `main`. `dev` is the integration branch; see the branch
and version scheme in `CLAUDE.md`.

## [Unreleased]

### Changed

- `npm run push` now scans in parallel against Skilljar's list endpoints
  instead of fetching every object one at a time. It was issuing 1,537
  sequential requests to check 66 courses, 649 lessons and 822 content items
  — one `GET` per object, about 380ms each — which is roughly ten minutes of
  waiting before the first write. It now reads the catalogue in one
  `GET /courses`, each course's lesson titles in one `GET /lessons?course_id=`,
  and each lesson's content in one
  `GET /lessons/{id}/content-items?include_content=true`: 716 requests, run
  six at a time. Measured against the full tree, 10 minutes becomes **77
  seconds**, and a single small course 5.8s becomes 2.3s. `--concurrency`
  tunes the fan-out; lower it if Skilljar starts throttling.

  What gets detected is unchanged, and was checked rather than assumed: run
  over the whole catalogue, the old and new implementations flag the same two
  content items and agree on every other course, and the rendered word-diff
  is byte-identical down to the colour codes.

  Two things that look like further savings are not, and are documented in
  `skilljar-fetch.mjs` so they don't get re-litigated: `GET /lessons` returns
  a `content_html` field, but it is empty for `MODULAR` lessons, which is all
  of them — so one request per lesson is the floor; and neither lessons nor
  content items carry a timestamp, so only a course has `modified_at` to
  check freshness against.

- `push` prompts are now preceded by the full change list, because the scan
  finishes before the first prompt. Previously a prompt surfaced roughly every
  ninety seconds across a ten-minute run, and you could not see what was still
  coming. As part of that, the per-object `✅ … is in sync` lines are replaced
  by one count — 1,535 of them in a full run was not information anyone read.

- Splitting the scan from the apply also means `push` no longer dies on a
  stray file. A content item the pull could not match upstream is recorded in
  `lessons-meta.json` with `id: null`; `push` built `/content-items/null` from
  it, took a 404 and exited, abandoning every other course. Those, along with
  lessons or content items that have disappeared upstream, are now reported as
  warnings telling you a pull is due, and the rest of the run continues.

- `--add-last-updated` now rewrites `lessons-meta.json` only for courses whose
  lessons were actually stamped. It previously rewrote the file for every
  course it visited, including under `--dry-run`, which is meant not to write.

- The integration branch is now `dev`, renamed from `v2.0`. A permanent branch
  named after a single release collides with the release as soon as the next
  one comes round: everything merged since 1.0.0 was sitting on a branch called
  `v2.0`, unreleased and untagged, so there was no answer to whether new work
  was 2.0 or 2.1 that wasn't also a question about the branch name. `dev` names
  the role, and 2.1 will be a tag rather than a branch.

- `package.json` is named `syncjar` rather than the leftover
  `test-local-skilljar`, and carries the README's one-line description.

### Added

- `scripts/push-plan.mjs` — decides what a push would change, as a pure
  function over already-fetched data. Separating the decision from the act is
  what lets the scan be parallel while the prompts stay sequential, and it
  puts `normalizeHtml()` under test for the first time. That function is
  load-bearing and was previously only exercised through a live sync: it has
  to collapse the indentation differences that Skilljar and the local copy
  produce on their own, while leaving whitespace inside `<pre>` exactly alone,
  because a YAML block indented with tabs and one indented with spaces are
  different documents and treating them as equal means the fix can never be
  pushed.
- `scripts/skilljar-fetch.mjs` and `scripts/concurrency.mjs` — the list reads
  and the bounded-parallelism helper, now shared. Pull already had all of
  them; push needed the same ones, and duplicating them is how the two
  scripts would have drifted.

### Security

- The Skilljar client now redacts the errors it rejects with, and the three
  scripts that never caught them now do. A raw axios error carries `config`,
  `request` and `response.headers`, and `config.headers.Authorization` is
  `Basic <base64 of SKILLJAR_API_KEY>` — so any unhandled rejection printed
  the key. `pull-slugs.mjs`, `sync-skilljar-to-local.mjs` (pull) and
  `sync-local-to-skilljar.mjs` (push) had no `try`/`catch` around any API call
  at all, which made a wrong domain or an expired key enough to put the key on
  screen; measured on a fake key, one 401 stack trace contained it 12 times.
  `redactError()` now rebuilds every rejected error with the status, body,
  method, URL and original stack and none of the containers that hold
  credentials, so a forgotten `try`/`catch` — or an ad-hoc `node -e` — can no
  longer leak. The ten previously unwrapped call sites route through
  `failCleanly()` as well, since redaction stops the leak but does not make a
  partial sync a good outcome: a failed page of a paginated pull would
  otherwise have been written to disk as though it were the whole set.

- The internal Skilljar test hostname was removed from the working tree and
  purged from git history, and all branches were force-pushed. Old commit SHAs
  remain retrievable from GitHub's API until GitHub garbage-collects the
  unreachable objects; ask GitHub Support to run GC to complete the removal.

### Fixed

- `sync-users.mjs` no longer writes a silently partial `user-progress.json`.
  Users whose per-user cache file already existed were skipped without being
  added to `processed`, and `processed` was what got written — so every re-run
  produced a file covering only the users fetched that run, and the CSV built
  from it came out short without anything reporting a problem. Here it had
  degraded to 36 of 1,764 users. The merged file is now assembled by reading
  every per-user record back off disk, which makes it complete regardless of
  how many partial or resumed runs built the cache up, and the run warns when
  it covers fewer users than the API returned.

### Added

- `scripts/pull-paths.mjs` (`npm run pull:paths`) — pulls Skilljar learning
  paths to local files, mirroring the three objects the course pull already
  mirrors: the path itself (`details.json`), its member courses
  (`path-items.json`), and its per-domain publish records
  (`published.json`). Writes to `PATH_CONTENT_PATH`, defaulting to
  `local-skilljar-paths/`, and reuses `course-dirs.mjs` so a path directory is
  named by id rather than title for the same reason a course directory is.
  Supports `--path`, `--domain`, `--dry-run` and `--check`, matching the
  existing pull scripts. Read-only upstream; `push` still does not write path
  copy back. Two properties of Skilljar's path model are documented in the
  script and the README rather than assumed away: `path-items` carries no
  order field and is not returned in display order, and whether a path id
  appears on one domain or several varies by instance — so `published.json` is
  keyed by domain, and two different path ids can share a slug.
- `failCleanly()` is now exported from `scripts/skilljar-client.mjs` instead of
  being defined privately in `export-students.mjs`. It belongs with the client
  whose errors it sanitizes: an unhandled axios rejection prints the
  Authorization header, so every caller needs this and there is no reason for
  each to carry its own copy.
- `npm run pull:slugs` is now listed in the README's command table, which had
  only ever documented the script by filename.

- `npm run push` now refuses to run unless the course content repo
  (`COURSE_CONTENT_PATH`) is on `dev` or `main`. Skilljar holds one live state
  and has no concept of branches, so pushing from a feature branch whose
  content is behind `dev`/`main` silently overwrites whatever landed there
  after the branch was cut — and git cannot catch it, because the danger is
  entirely in which branch happens to be checked out locally. A detached HEAD
  or a non-git content directory is refused on the same grounds: nothing
  establishes that the content is current. `--allow-branch <name>` allows one
  named branch; `--dry-run` and `--diff-only` never write upstream and are
  unaffected. The guard checks which branch is checked out, not whether it is
  up to date with its remote.

- `scripts/export-students.mjs` — exports the flat Skilljar student list to CSV
  in a single paginated sweep of `/users`. Read-only. Written because
  `sync-users.mjs` skips users whose per-user cache file already exists without
  adding them to `processed`, so `user-progress.json` — and therefore the CSV
  built from it — is silently partial on any re-run. A missing row in an access
  audit reads as a clean result, which makes that bug worth routing around
  rather than living with.
- `scripts/revoke-access.mjs` — revokes domain access (`PATCH` `active: false`)
  and removes group membership (`DELETE`) for a reviewed list of users. Dry-run
  by default, preflights with live GETs before iterating, requires typed
  confirmation, and writes a per-run audit CSV recording prior state so a
  mistaken run can be reversed precisely. Never calls the irreversible
  `/users/{id}/anonymize` endpoint.
- `scripts/check-membership.mjs` — read-only check of whether users are still in
  a group and whether their domain records are active. Exists to answer whether
  a group's email-domain rule re-evaluates and silently undoes removals, which
  would leave a bulk revoke looking remediated when it isn't.
- `CLAUDE.md` — working notes covering the API-key exposure hazard in unhandled
  axios errors, the no-`/v1`-prefix path convention, which operations are
  destructive versus reversible, and data-hygiene rules for student exports.

### Changed

- `pull-slugs.mjs` requires `SKILLJAR_DOMAINS` (or `--domain`) instead of
  falling back to a hardcoded domain list. Which domains to pull from is a
  property of the Skilljar instance, not of this tool, so the previous default
  was both wrong for every other user and a way of committing an internal
  hostname. Documented in `.env-example`.
- Push diffs are now word-level instead of line-level
  (`scripts/sync-local-to-skilljar.mjs`). `normalizeHtml` collapses each block
  of markup onto one long line, so a line diff reported every real edit as
  "whole line removed, whole line added" — technically accurate and useless for
  review, since the reader had to eyeball two near-identical paragraphs to find
  the changed word. `diffWordsWithSpace` highlights only the words that actually
  changed. Long unchanged spans between edits are elided to a window around each
  change, so a one-word fix no longer prints the entire paragraph.

## [1.0.0]

### Added

- Pull and push scripts to sync Skilljar course content to and from a local
  working copy, including `description_html` and course/lesson titles.
- Local preview server with theming and dynamic course loading.
- `scripts/pull-slugs.mjs` to fetch per-domain course slugs.
- `--course` filter, `--add-last-updated`, and diff/dry-run flags on the sync
  scripts.
- Shared Skilljar client that retries on 429/5xx honouring `Retry-After`, with
  per-course content fetches capped at 4 in flight to avoid tripping the
  limiter in the first place.
- Parallelized sync with an in-place spinner table showing per-course progress.

### Fixed

- Course directories are named by course id rather than title, so a retitled
  course keeps its directory instead of forking into a second one.
- Whitespace inside `<pre>` is treated as content when comparing, so an
  indentation fix in a code block is no longer reported as already in sync and
  therefore never pushable.
- Only directories are treated as courses, so loose files in the content root
  stop producing warnings that trained people to read past real ones.
- Courses are deduplicated by slug on pull, keeping the most recently modified
  version, to avoid a write race that corrupted `details.json`.
- Pull order sorts by `modified_at`; the previous `updated_at` field does not
  exist on the API and produced `NaN` comparisons that left order unchanged.
- `lessons-meta.json` no longer drops content items on pull.
- `package.json` declares MIT, matching the LICENSE file.
