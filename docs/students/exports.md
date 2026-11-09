---
title: Exports
parent: Students
nav_order: 3
---

# Exports
{: .no_toc }

1. TOC
{:toc}

---

Every export is read-only and writes a CSV to `public/data/`, unless you pass
`--out`. Most of them hold names and email addresses: delete them when
you're done. They regenerate from the API in one command.

| Export | Rows | Credentials | File |
|---|---|---|---|
| `export:students` | One per student | v1 key | `students.csv` |
| `export:enrollments` | One per enrollment | v2 client | `enrollments.csv` |
| `export:analytics` | One per course, optionally per domain | v2 client | `course-analytics.csv` |
| `sync:users`, then `export:users` | One per student, with activity | v1 key | `user-report.csv` |
| `sync:users`, then `export:metrics` | One per month, by course | v1 key | `metrics-report.csv` |

## Students: `export:students`

```bash
syncjar export:students
syncjar export:students --domain example.com      # only addresses at this email domain
syncjar export:students --out ./students.csv
```

One row per student: Skilljar id, email, first and last name, email domain,
when they signed up, latest activity, and whether they have any activity.
It's a single paginated sweep of the student list, so it's the cheap way to
get a roster.

## Enrollments: `export:enrollments`

```bash
syncjar export:enrollments                                    # every enrollment
syncjar export:enrollments --course "first build" --email-domain example.com
syncjar export:enrollments --domain courses.example.com --completed-only --since 2026-07-01
syncjar export:enrollments --email someone@example.com --include-feedback
```

One row per enrollment: course, domain, the student's email and name, when
they enrolled and completed, progress and success status, score,
certificate, source (self-enrolled, purchased or assigned), and whether the
enrollment is active.

| Option | Narrows to |
|---|---|
| `--course` | A course id, or part of a title, ignoring case; repeatable |
| `--domain` | Enrollments on this Skilljar domain; repeatable |
| `--email` | One student; repeatable |
| `--email-domain` | Students at this email domain, exactly: `example.com` doesn't include `eu.example.com`; repeatable |
| `--completed-only` | Completed enrollments |
| `--since` | Enrollments made on or after this date, UTC |

Rating and free-text feedback are left out unless you pass
`--include-feedback`.

When the export isn't narrowed by student or date, its counts per course are
compared with Skilljar's analytics summary, and any difference is reported.
`--no-check` skips that. Every read happens before the file is written, and a
failed one stops the export.

## Course analytics: `export:analytics`

```bash
syncjar export:analytics                                 # one row per course
syncjar export:analytics --by-domain                     # plus a row per course per domain
syncjar export:analytics --domain courses.example.com    # plus one domain only
syncjar export:analytics --published-only                # leave out unpublished courses
```

Skilljar's own per-course summary: enrollments, completions, completion rate,
certificates issued and ratings. The figures are totals, with nothing per
student, lesson or quiz, so this file holds no personal data. A per-domain
run makes one request per course per domain.

## Activity reports: `sync:users`, `export:users`, `export:metrics`

`sync:users` downloads every student's course progress into a local cache in
`public/data/`, one file per student. `export:users` and `export:metrics`
then build reports from that cache without touching the API.

```bash
syncjar sync:users                          # build or extend the cache
syncjar sync:users --limit 100              # stop after 100 students
syncjar sync:users --start-after <user_id>  # resume after this one
syncjar export:users --internal-domain example.com
syncjar export:metrics
```

- **`export:users`** writes one row per student: name, email, when they
  enrolled, latest activity, email domain, whether they have no activity, and
  whether they're internal, meaning their address is at `--internal-domain`
  or `SYNCJAR_INTERNAL_DOMAIN`.
- **`export:metrics`** writes one row per month, with two columns per course:
  registrations that month, and how many of those completed in the same
  month.

{: .note }
`sync:users` makes one request per student plus one per course for each,
so it's slow on a large organisation. The cache never expires: a student's
file is reused on every later run, so their progress goes stale until you
delete the `public/data/user-progress/` directory. For a plain roster, use
`export:students`.
