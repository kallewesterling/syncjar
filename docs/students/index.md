---
title: Students
nav_order: 6
has_children: true
permalink: /students/
---

# Students

Commands for the people taking your courses: who is in which group, who is
enrolled in what, and exports for reporting.

| Page | Commands |
|---|---|
| [Groups and access]({{ site.baseurl }}{% link students/groups.md %}) | `group:add`, `group:remove`, `group:domains`, `group:audit`, `group:revoke`, `check:membership` |
| [Enrollments]({{ site.baseurl }}{% link students/enrollments.md %}) | `enroll:add`, `enroll:remove` |
| [Exports]({{ site.baseurl }}{% link students/exports.md %}) | `export:students`, `export:enrollments`, `export:analytics`, `sync:users`, `export:users`, `export:metrics` |

## What the write commands have in common

Every command here that changes a student record:

- is a **dry run** unless you pass `--confirm`, and the dry run makes only
  read requests;
- looks every student up first, and shows the whole plan, including who is
  skipped and why, before anything is written;
- asks you to **type** a confirmation such as `add 12` before it writes;
- **never creates an account**: an email with no Skilljar account is listed
  and skipped;
- writes an **audit CSV** to `public/data/` recording each email's state
  before and after.

The audit files and most exports hold names and email addresses. Delete them
when you're done; see
[Safety and data handling]({{ site.baseurl }}{% link safety.md %}#student-data).

Input lists are a CSV with an `email` column, or a plain file with one
address per line, passed with `--in`. For a few people, repeat `--email`
instead.
