# Syncjar — Agent Guide

Syncjar is a **two-way sync tool** between [Skilljar](https://skilljar.com) (a hosted LMS) and a local directory of HTML files. It lets course authors pull course content down to edit in their IDE, then push edits back to Skilljar via its API.

There is a working reference implementation at `../syncjar-python` (Python 3.11+, Click CLI). This directory is a **new rewrite** — start by reading the reference implementation when you need to understand what a command should do.

---

## Concepts

| Term | Meaning |
|---|---|
| **Domain** | A Skilljar-hosted site, e.g. `courses.chainguard.dev`. One Skilljar account can have many domains. |
| **Course** | A named collection of lessons on a domain. Identified by an alphanumeric `id` and a human-readable `slug`. |
| **Lesson** | A section of a course with a title, description HTML, and an ordered list of content items. |
| **Content item** | An HTML block within a lesson (`type: "HTML"` is the only type we write). |
| **Slug** | A lowercase, hyphen-separated identifier derived from a title: `"Getting Started"` → `"getting-started"`. |

---

## Skilljar API

- Base URL: `https://api.skilljar.com/v1`
- Auth: HTTP Basic — API key as the username, empty password.
- All list endpoints are paginated: `?page=1&page_size=100`. Follow `next` until exhausted.
- Key endpoints:
  - `GET /domains` — list all domains for this account
  - `GET /courses?domain={domain_id}` — list courses on a domain
  - `GET /courses/{course_id}/lessons` — list lessons for a course
  - `GET /lessons/{lesson_id}/content-items` — list content items for a lesson
  - `PUT /content-items/{item_id}` — update a content item (push)
  - `PUT /lessons/{lesson_id}` — update a lesson's description HTML

The API returns 429 when rate-limited. Retry with exponential back-off (start at 1 s, cap at ~30 s).

---

## Local file structure

The sync target is a directory (default: `local-skilljar/`, configurable via `COURSE_CONTENT_PATH`):

```
local-skilljar/
└── {domain}/                         # e.g. courses.chainguard.dev
    ├── .syncjar-meta.yaml            # incremental-sync state for this domain
    └── courses/
        └── {course-slug}/
            ├── course-meta.yaml      # course id, title, description, is_published, slug
            ├── lessons-meta.yaml     # ordered list of lessons (id, title, order, slug)
            └── {order}-{lesson-slug}/  # e.g. 10-introduction
                ├── description.html  # lesson description_html (omitted if empty)
                ├── 01.html           # content item 1 (by order)
                ├── 02.html
                └── ...
```

**`.syncjar-meta.yaml` schema:**
```yaml
last_pull: "2026-01-29T13:28:15.123456"   # ISO-8601 UTC
last_push: null
course_hashes: {}                          # {course_slug: sha256_hex}
```

The `last_pull` timestamp is compared against `course.modified` from the API to decide whether a course needs re-syncing on incremental pulls.

---

## Commands

| Command | Flags | What it does |
|---|---|---|
| `pull` | `--verbose` | Fetch all domains and courses; write to local files |
| `push` | `--course SLUG`, `--lesson SLUG`, `--dry-run`, `--force`, `--diff/--no-diff`, `--diff-only` | Push local edits back; show rich diffs, ask for confirmation |
| `generate` | — | Build `public/data/courses.json` + `public/courses/{domain}/…` for a static preview |
| `build-preview` | `--verbose` | Convenience: `pull` then `generate` |

**Incremental pull** is a core feature: on subsequent pulls only courses whose `modified` timestamp is later than `.syncjar-meta.yaml:last_pull` are re-fetched. The first pull always syncs everything.

---

## Configuration (`.env`)

```bash
SKILLJAR_API_KEY=sk-live-…        # required; Basic auth username
COURSE_CONTENT_PATH=local-skilljar # optional; path to local course directory
PREVIEW_OUTPUT_PATH=public         # optional; path for generate output
MAX_CONCURRENT_COURSES=5           # optional; asyncio concurrency limit
MAX_CONCURRENT_LESSONS=10          # optional
API_TIMEOUT=30.0                   # optional; seconds
```

---

## Key design principles

1. **Local files are the source of truth for edits.** The pull command never overwrites a local file that is newer than the remote, unless `--force` is passed.
2. **Diffs before mutations.** The push command always shows a human-readable HTML diff and asks for confirmation per change unless `--force` is set.
3. **Domain isolation.** Sync state (`.syncjar-meta.yaml`) is per-domain so the same course slug on different domains can have different content.
4. **Async throughout.** Use `asyncio` and async HTTP clients (reference uses `httpx.AsyncClient`). Never use sync I/O inside async paths.
5. **Rich terminal output.** Progress bars, coloured diffs, and error messages are part of the UX. The reference uses the `rich` library.
6. **100 % backward-compatible local format.** The file layout and YAML schemas are fixed by the reference implementation. Don't change them without updating the docs.

---

## Slug rules

The `slugify(text)` function in the reference (`syncjar/utils.py`):
- Lowercase the input
- Replace spaces and underscores with `-`
- Strip any character that isn't `[a-z0-9\-.]`
- Strip leading/trailing `-`

Lesson directories are prefixed with their `order` field zero-padded to two digits: `10-` for order 10. Content item files are `{order:02d}.html`.

---

## HTML handling

- Content is stored as raw HTML fragments (no `<html>`/`<body>` wrapper).
- When comparing local vs remote for diff/push, normalise with `normalize_html()` (reference: `syncjar/utils.py`): normalise line endings, strip trailing whitespace per line, strip leading/trailing blank lines.
- Preserve `<pre>` and `<code>` block whitespace — do not collapse it.

---

## Reference implementation layout

```
../syncjar-python/
├── syncjar/
│   ├── cli.py          — Click command definitions
│   ├── client.py       — SkilljarClient (async httpx, pagination, retry)
│   ├── config.py       — Pydantic Settings (reads .env)
│   ├── models.py       — Domain, Course, Lesson, ContentItem, *Metadata
│   ├── utils.py        — slugify, normalize_html, write_file, write_yaml, …
│   └── commands/
│       ├── pull.py     — pull_courses()
│       ├── push.py     — push_changes()
│       └── generate.py — generate_preview()
└── tests/
    ├── test_utils.py
    └── test_client.py
```

---

## Common agent tasks

**Adding a new flag to `push`:**
1. Add it to the `@cli.command()` decorator in `cli.py`.
2. Thread it through `push_changes()` in `commands/push.py`.
3. Add a test in `tests/`.

**Changing the local file schema:**
- Update `models.py` (Pydantic models).
- Update `commands/pull.py` where files are written.
- Update `commands/push.py` where files are read.
- Update the schema docs in this file.

**Testing against the real API:**
- Set `SKILLJAR_API_KEY` in `.env`.
- Use `--dry-run` on push to avoid mutations.
- Use a test domain (`chainguard-test.skilljar.com`) when available.

**Running tests:**
```bash
pytest
pytest --cov=syncjar
```

**Linting/formatting:**
```bash
black syncjar/
ruff check syncjar/
```
