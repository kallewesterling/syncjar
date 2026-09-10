# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries for 1.0.0 and earlier were reconstructed from git history after the
fact, so they group related commits rather than listing each one.

## [Unreleased]

### Added

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
