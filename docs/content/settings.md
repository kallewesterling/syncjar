---
title: Settings
parent: Course content
nav_order: 5
---

# Settings
{: .no_toc }

1. TOC
{:toc}

---

Course, lesson, path and visibility settings live in the files `pull`,
`pull:slugs` and `pull:paths` write. Four commands push them back. They all
work the same way:

- `--dry-run` shows each record's before and after and writes nothing.
- A real run shows the same list, asks **once**, then writes. `--force` skips
  the prompt.
- Each write is a `PATCH` holding only the changed fields, so nothing else on
  the record is sent.
- Every written record is read back. If a value didn't land, or any other
  field on it moved, the command lists the problem and exits 1. It stops at
  the first failed write.
- The same [branch guard]({{ site.baseurl }}{% link content/pushing.md %}#branch-guard)
  as `push` applies, with `--allow-branch` to name another branch.

{: .warning }
Local wins here too: a setting changed in the dashboard but not in your file
shows up as a change *back*. Pull first if that might have happened.

## Course settings

`push:course-settings` pushes these fields from each course's `details.json`:

| Field | Value |
|---|---|
| `enforce_sequential_navigation` | `true` or `false`: learners must take lessons in order |
| `display_course_and_lesson_time` | `true` or `false`: show course and lesson times |
| `display_manual_course_time` | `true` or `false`: show the manual course time instead |
| `labels` | A list of label names, in any order. Each must already exist in Skilljar |

```bash
syncjar push:course-settings --dry-run
syncjar push:course-settings
syncjar push:course-settings --course <dir-or-id>    # repeatable
```

A label Skilljar doesn't have is refused with a warning rather than sent,
because what the API does with an unknown label is untested. Skilljar
recalculates `course_time` when a display flag changes, so the read-back
allows that.

Writing a setting moves the course's `modified_at`, so the next `push` scans
that course once instead of skipping it.

## Path details, lesson settings and visibility

| Command | Writes | From | Narrow with |
|---|---|---|---|
| `push:paths` | A path's title, short and long description, header, and what it calls its items (`course_name_singular`, `course_name_plural`) | each path's `details.json` | `--path <dir-or-id>` |
| `push:lesson-settings` | Whether a lesson is `optional`, its `description_html` and its `tooltip_html` | each course's `lessons-meta.json` | `--course <dir-or-id>` |
| `push:published-settings` | `hidden` and `strict_enforce_group_visibility`, per domain | each course's and path's `published.json` | `--domain <host>` |

- `push:paths` reads `PATH_CONTENT_PATH`, which `pull:paths` writes. Lesson
  titles stay with `push`.
- `push:lesson-settings` reads one lesson list per course; `--concurrency`
  sets how many at once.
- `push:published-settings` never writes slugs, although they're in the same
  file.

{: .warning }
Hiding a path's last visible course closes registration for that path on
that domain. `push:published-settings` warns before its prompt when a run
would do that.

`hidden` takes a course or path out of the catalog, except for the groups
allowed to see it. `strict_enforce_group_visibility` also blocks a direct
link for everyone else; without it, hiding only unlists.
[`check:visibility`]({{ site.baseurl }}{% link checks/visibility.md %}) shows
what the combination means for each group.

## What isn't pushed, and why

Some settings are left out on purpose:

- **Fields that can be set but never cleared.** A course's short description,
  its manual course time and time format, and a published course's
  registration dates can be written through the API, but a blank value is
  refused. A push of one would be a change nobody could undo except in the
  dashboard.
- **Slugs.** They're writable, but a change breaks every link to the course
  or path.
- **Lesson order.** Reordering is a different job from flipping a setting.
- **Settings that are the same on every course**, such as
  `registration_required`.
  [`check:settings`]({{ site.baseurl }}{% link checks/settings.md %}) reports
  the odd one out instead.
