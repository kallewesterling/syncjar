---
title: Dashboard edits (check:drift)
parent: Checks
nav_order: 1
---

# Dashboard edits: `check:drift`
{: .no_toc }

1. TOC
{:toc}

---

A push replaces Skilljar's content with your files, so a lesson edited in the
Skilljar dashboard since your last pull loses that edit. `check:drift` lists
those edits before you push.

```bash
syncjar check:drift && syncjar push
```

It needs a v2 client with `audit:read`, `lessons:read` and `courses:read`. It
makes GET requests and runs `git log`, and nothing else.

## Why the audit log

A dashboard edit does move the course's `modified_at`, but that only says the
course changed, not what or when. And an edit made through the API, by a
`push` from another checkout or any other tool, moves no timestamp at all.

Skilljar's audit log records dashboard actions, one event per edit, with the
lesson and the kind of change. It doesn't record API writes, so a push's own
writes never show up as drift.

{: .note }
The flip side: an edit made through the API, for example a push from someone
else's checkout, is invisible to `check:drift`. If several people push,
`pull` is still the way to bring everything in line.

## Where it starts from

```bash
syncjar check:drift                       # since the last pull commit in the content repo
syncjar check:drift --since 2026-10-01    # since a date, UTC
syncjar check:drift --since 59f6afa1      # since a commit in the content repo
syncjar check:drift --course onboarding   # only courses whose directory, id or title matches
syncjar check:drift --json                # for scripts
```

By default it starts from the newest commit in the content repository whose
subject says it pulled or synced from Skilljar. A subject counts when it:

- starts with *sync* or *pull*, optionally after a conventional-commit type
  such as `chore(content):`; for example `Pull from Skilljar` or
  `content: pull lesson edits`; or
- contains *sync Skilljar*, *synced Skilljar* or *synced from Skilljar*
  anywhere.

So commit your pulls with a subject like that. It doesn't start from the
newest commit of any kind: a local edit committed after a dashboard edit
would move the start past that edit and hide it.

If you recorded dashboard edits by hand in a commit with another subject,
they'll show up again; pass `--since <that commit>` to start after it.

## Reading the report

The report is grouped by course, then lesson, with one line per kind of
change, a count and a date range.

| Mark | Meaning |
|---|---|
| `!` | Lesson content: `HTML`, `VIDEO`, `QUIZ`, downloads. A push destroys these, so they come first |
| `~` | Structure: creations, deletions, reorders, publishes |
| `·` | Titles, descriptions and flags |

Lessons and courses that aren't in your local tree are looked up and reported
as new in Skilljar, never pulled, or deleted.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Nothing was edited |
| `2` | Something was |
| `1` | An error |

So `check:drift && syncjar push` pushes only when nothing was edited.

## Who made each edit

The audit log names the dashboard user behind each event. The report leaves
them out. `--show-actors` adds them, in an interactive terminal only: it's
refused with `--json`, or when the output isn't a terminal, so names can't
end up in a CI log or a file.
