---
title: Pulling
parent: Course content
nav_order: 1
---

# Pulling
{: .no_toc }

1. TOC
{:toc}

---

## Courses, lessons and quizzes: `pull`

```bash
syncjar pull                      # every course
syncjar pull --course onboarding  # courses whose directory name or title contains this
```

Each course is written to `COURSE_CONTENT_PATH` (default `local-skilljar/`):

```text
<course>/
├── details.json           # the course record, as Skilljar returns it
├── lessons-meta.json      # its lessons, in order, with their content items
└── lessons/
    └── <lesson>/
        └── content-<content_item_id>.html
```

Every HTML content item becomes its own file. Items that aren't HTML, such
as quizzes, assets and ratings, have no file. They are listed under
`non_html_items` in `lessons-meta.json`, so tools that read the files can
rely on every entry in `content_items` having one.

### Quizzes

`pull` also writes quizzes, one file per quiz, to `QUIZ_CONTENT_PATH`
(default `local-skilljar-quizzes/`):

```text
quiz-<quiz_id>.json    # settings, then questions in order, each with its answers
```

Quizzes get their own directory because one quiz is often used by lessons in
several courses. A lesson points at its quiz through `non_html_items`:

```json
"non_html_items": [
  { "id": "<content_item_id>", "type": "QUIZ", "order": 1, "content_quiz_id": "<quiz_id>" }
]
```

A full pull writes every quiz in the organisation, including those no lesson
uses, and lists those. `--course` writes only that course's quizzes.

{: .note }
Deleting a course in Skilljar doesn't delete its quizzes. A quiz belongs to
the organisation, not the course, and through the API even the deleted
course's lessons stay readable. So a full pull keeps writing those quizzes,
and lists them as unused. Delete them in Skilljar if you don't want them.

## Slugs: `pull:slugs`

A course's URL slug isn't on the course. It belongs to the course's
*published* record, and there is one of those per domain the course is
published on. `pull:slugs` writes them to `published.json` in each course
directory, along with each domain's `hidden` and `strict_enforce_group_visibility` flags.

```bash
syncjar pull:slugs                                   # domains from SKILLJAR_DOMAINS
syncjar pull:slugs --domain courses.example.com      # or name them; repeatable
syncjar pull:slugs --dry-run                         # print, write nothing
syncjar pull:slugs --check                           # exit non-zero if any file is stale
```

`--check` is meant for CI: it compares the existing files with Skilljar and
fails if any is missing or out of date.

## Learning paths: `pull:paths`

A learning path is modelled much like a course, so `pull:paths` writes the
same three kinds of file per path to `PATH_CONTENT_PATH` (default
`local-skilljar-paths/`):

| File | Contents |
|---|---|
| `details.json` | The path itself: title, descriptions, promo image, item count |
| `path-items.json` | Its member courses |
| `published.json` | Per-domain slug, published id and visibility flags |

```bash
syncjar pull:paths                         # every path
syncjar pull:paths --path onboarding       # one path, by directory name or title
syncjar pull:paths --dry-run
syncjar pull:paths --check                 # CI: non-zero if any file is stale
```

`published.json` needs to know which domains to ask about, from
`SKILLJAR_DOMAINS` or `--domain`. With neither, the other two files are still
written, and the run says it skipped `published.json`.

Two things to know before you build on these files:

- **`path-items.json` is membership, not running order.** The API returns no
  order field, and the order it does return isn't the display order.
- **A path id can belong to one domain or several**, depending on the
  organisation. `published.json` is keyed by domain either way. If your
  organisation has a separate path per domain, two path ids can share a slug.

## Directory names

A course's directory name comes from its **id**, not its title. On each pull,
Syncjar reads the `id` in every `details.json` and maps each course id to its
existing directory. A course that already has a directory keeps it, even
after someone rewords or re-cases its title in Skilljar. Only a course that
is new to the tree gets a name derived from its title. Paths work the same
way.

This stops a renamed course from gaining a second directory. It also keeps
the tree safe on macOS, where two names that differ only in case can't
coexist.

To rename a directory, rename it yourself. The next pull follows it, because
it matches on the id.

## Interrupting a pull

It's safe to stop a pull with Ctrl+C, or for CI to cancel one. Every file is
written to a temporary file in the same directory and then renamed into
place, so each file is either the old version or the new one, never partly
written or empty. An interrupted pull can leave some files updated and others
not, so run it again before committing.

A killed run can leave temporary files named
`.<file>.syncjar-<hex>.tmp`. They are dotfiles and don't end in `.html` or
`.json`, so nothing reads them as content, and the next pull removes them.

## Empty content is double-checked

`pull` won't replace a content file that has content with an empty one on
the strength of a single read. When Skilljar's content list returns an item
empty and the local file isn't, pull reads that item again on its own:

- If the second read has content, pull writes it.
- If the second read is empty too, the item really is empty in Skilljar. Pull
  writes the empty file and warns, so look at the lesson before committing.
- If the second read fails, pull keeps the existing file, warns, and exits
  non-zero.
