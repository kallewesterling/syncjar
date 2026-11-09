---
title: Enrollments
parent: Students
nav_order: 2
---

# Enrollments
{: .no_toc }

1. TOC
{:toc}

---

`enroll:add` enrolls existing students in a course by email.
`enroll:remove` deactivates their enrollments. Both use the v2 API and need
a client with `courses:read`, `published-courses:read`, `domains:read`,
`students:read`, `enrollments:read` and `enrollments:write`.

```bash
# Dry run: reads only, and shows who would be enrolled and who is skipped
syncjar enroll:add --course "Getting started" --domain courses.example.com --in acme.csv

# Do it, with an expiry: asks you to type "enroll <n>" first
syncjar enroll:add --course <id> --domain courses.example.com --in acme.csv --expires-at 2027-01-31 --confirm

# Deactivate: asks you to type "unenroll <n>" first
syncjar enroll:remove --course <id> --domain courses.example.com --email a@acme.com --confirm
```

`--course` takes the course's v2 id or its exact title. An enrollment belongs
to a course *on one domain*, so `--domain` is required when the course is
published on more than one. `--expires-at` takes an ISO 8601 date or time; a
bare date means midnight UTC.

## Deactivating isn't deleting

Neither the v2 API nor the Skilljar dashboard can delete an enrollment.
`enroll:remove` deactivates it:

- the learner loses access, and the course shows as "Inactive" on their
  dashboard;
- the enrollment keeps its id, dates and progress, and a completed one stays
  completed;
- analytics still count it.

Neither command marks anyone as having completed a course.

## Bringing someone back: `--re-enroll` or `--restore`

A student with a deactivated enrollment is skipped by a plain `enroll:add`,
because there are two different ways to bring them back:

```bash
syncjar enroll:add --course <id> --email a@acme.com --re-enroll --confirm   # a fresh start
syncjar enroll:add --course <id> --email a@acme.com --restore --confirm     # their old progress
```

| | `--re-enroll` | `--restore` |
|---|---|---|
| Creates | A **new** enrollment, from no progress | Nothing: the old enrollment is made active again |
| Progress | Starts at zero | Kept, as if it had never been deactivated |
| The old enrollment | Stays, inactive, as history | Is the active one again |
| What the dashboard shows | Only the new one, on the admin's student page; the API returns both | The one enrollment |

`--re-enroll` relies on the course's *unique progress per enrollment*
setting being on, so that each enrollment has its own progress.

- `--re-enroll` can't be combined with `--expires-at`: Skilljar answers that
  combination with an internal error and writes nothing.
- `--restore` doesn't take an expiry either, and refuses a student who
  already has more than one enrollment in the course, rather than guess which
  to restore.

## Who is skipped

Every email is looked up first, along with that student's enrollment in the
course on that domain. Nobody is created. These are skipped and listed:

| Skipped | `enroll:add` | `enroll:remove` |
|---|---|---|
| No Skilljar account, or more than one | ✓ | ✓ |
| Already actively enrolled | ✓ | — |
| Enrollment deactivated | unless `--re-enroll` or `--restore` | ✓ (already inactive) |
| Enrollment expired | ✓ | ✓ (already inactive) |
| More than one enrollment in the course on that domain, with `--restore` | ✓ | — |
| Deactivated account | ✓ | — |
| Not an active member of the domain | ✓ | — |
| Not enrolled | — | ✓ |
| More than one active enrollment in the course on that domain | — | ✓ |

The expired-enrollment, domain-member and deactivated-account skips are
cautious: what Skilljar does with those students hasn't been tested, so
Syncjar leaves them for you to handle in the dashboard.

## After the run

A confirmed run sends batches of 100 and stops at the first batch that fails
as a whole. Then it reads every student's enrollment back. A row counts as
done only when the read-back matches what was meant:

- for an add, a new active enrollment, with the requested expiry;
- for a re-enroll, one active enrollment that isn't the old one, and the old
  one still inactive;
- for a restore, the old enrollment active again, and alone;
- for a remove, the targeted enrollment inactive.

The audit CSV in `public/data/` records each email's state before and after,
including the learner's progress.

Learning paths have no enrollments in the v2 API, so these commands handle
courses only.

{: .note }
Syncjar sends no email itself. Whether Skilljar emails a learner who is
enrolled through the API is up to Skilljar: in testing on a staging domain,
none arrived. Try it on one address before enrolling a cohort.
