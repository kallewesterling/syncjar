---
title: Command reference
nav_order: 7
permalink: /reference/commands/
---

# Command reference
{: .no_toc }

Every command, what it needs, and where it's documented. Run
`syncjar <command> --help` for its full list of options. From a clone, the
same command is `npm run <command> -- <options>`.

**Credentials:** *v1* is `SKILLJAR_API_KEY`, *v2* a v2 client with the
scopes on [Configuration]({{ site.baseurl }}{% link configuration.md %}#which-commands-need-which),
and *none* runs locally.
{: .fs-3 }

1. TOC
{:toc}

---

## Content

| Command | Does | Writes to Skilljar | Credentials |
|---|---|---|---|
| [`pull`]({{ site.baseurl }}{% link content/pulling.md %}) | Courses, lessons, content items and quizzes to files | no | v1 |
| [`pull:slugs`]({{ site.baseurl }}{% link content/pulling.md %}#slugs-pullslugs) | Per-domain slugs and visibility flags to `published.json` | no | v1 |
| [`pull:paths`]({{ site.baseurl }}{% link content/pulling.md %}#learning-paths-pullpaths) | Learning paths to files | no | v1 |
| [`push`]({{ site.baseurl }}{% link content/pushing.md %}) | Course titles, lesson titles and HTML content items | yes, with prompts | v1 |
| [`push:quizzes`]({{ site.baseurl }}{% link content/quizzes.md %}) | New quizzes, and edits to pulled ones | yes, with prompts | v1 |
| [`push:course-settings`]({{ site.baseurl }}{% link content/settings.md %}#course-settings) | Course settings from `details.json` | yes, one prompt | v1 |
| [`push:paths`]({{ site.baseurl }}{% link content/settings.md %}#path-details-lesson-settings-and-visibility) | Path details from `details.json` | yes, one prompt | v1 |
| [`push:lesson-settings`]({{ site.baseurl }}{% link content/settings.md %}#path-details-lesson-settings-and-visibility) | Lesson settings from `lessons-meta.json` | yes, one prompt | v1 |
| [`push:published-settings`]({{ site.baseurl }}{% link content/settings.md %}#path-details-lesson-settings-and-visibility) | `hidden` and strict enforcement from `published.json` | yes, one prompt | v1 |

## Preview (from a clone only)

| Command | Does | Credentials |
|---|---|---|
| [`build:preview`]({{ site.baseurl }}{% link content/previewing.md %}) | `pull`, then `generate:courses` | v1 |
| [`generate:courses`]({{ site.baseurl }}{% link content/previewing.md %}) | Rebuilds the preview index from the content files | none |
| [`serve`]({{ site.baseurl }}{% link content/previewing.md %}) | Serves the preview at `http://localhost:3000` | none |
| [`export:plaintext`]({{ site.baseurl }}{% link content/previewing.md %}#export-to-markdown-exportplaintext) | One Markdown file per course | none |

`export:plaintext` also runs from the global command.

## Checks

All read-only.

| Command | Does | Credentials |
|---|---|---|
| [`check:drift`]({{ site.baseurl }}{% link checks/drift.md %}) | Dashboard edits since the last pull; exits `2` if any | v2 |
| [`check:visibility`]({{ site.baseurl }}{% link checks/visibility.md %}) | Who can see each published course and path, and likely mistakes | v2 |
| [`check:settings`]({{ site.baseurl }}{% link checks/settings.md %}) | Settings that differ from the rest of the catalog | v1 |
| [`check:links`]({{ site.baseurl }}{% link checks/settings.md %}#broken-links-checklinks) | Broken links in the preview's content; clone only | none |
| [`check:membership`]({{ site.baseurl }}{% link students/groups.md %}#checking-membership-checkmembership) | Whether people are in a group, and active on a domain | v1 |

## Students

| Command | Does | Writes to Skilljar | Credentials |
|---|---|---|---|
| [`group:add`]({{ site.baseurl }}{% link students/groups.md %}) | Adds students to a group, by email | with `--confirm` | v2 |
| [`group:remove`]({{ site.baseurl }}{% link students/groups.md %}) | Removes students from a group, by email | with `--confirm` | v2 |
| [`group:domains`]({{ site.baseurl }}{% link students/groups.md %}#auto-add-email-domains-groupdomains) | Lists or changes a group's auto-add email domains | with `--confirm` | v2 |
| [`group:audit`]({{ site.baseurl }}{% link students/groups.md %}#auditing-a-group-against-a-roster-groupaudit) | Group members who aren't on a roster | no | v1 |
| [`group:revoke`]({{ site.baseurl }}{% link students/groups.md %}#revoking-access-grouprevoke) | Removes reviewed users from a group, or deactivates them on a domain | with `--confirm` | v1 |
| [`enroll:add`]({{ site.baseurl }}{% link students/enrollments.md %}) | Enrolls students in a course, by email | with `--confirm` | v2 |
| [`enroll:remove`]({{ site.baseurl }}{% link students/enrollments.md %}) | Deactivates students' enrollments in a course | with `--confirm` | v2 |

## Exports

All read-only, writing to `public/data/` by default.

| Command | Does | Credentials |
|---|---|---|
| [`export:students`]({{ site.baseurl }}{% link students/exports.md %}#students-exportstudents) | The student list | v1 |
| [`export:enrollments`]({{ site.baseurl }}{% link students/exports.md %}#enrollments-exportenrollments) | One row per enrollment | v2 |
| [`export:analytics`]({{ site.baseurl }}{% link students/exports.md %}#course-analytics-exportanalytics) | Per-course totals, optionally per domain | v2 |
| [`sync:users`]({{ site.baseurl }}{% link students/exports.md %}#activity-reports-syncusers-exportusers-exportmetrics) | Caches every student's progress locally | v1 |
| [`export:users`]({{ site.baseurl }}{% link students/exports.md %}#activity-reports-syncusers-exportusers-exportmetrics) | Students with activity, from the cache | none |
| [`export:metrics`]({{ site.baseurl }}{% link students/exports.md %}#activity-reports-syncusers-exportusers-exportmetrics) | Monthly registrations and completions, from the cache | none |

## The `syncjar` command itself

| Command | Does |
|---|---|
| `syncjar help` | Lists commands, the installed version and commit, and where credentials are read from |
| `syncjar --version` | Prints the version |
| [`syncjar update`]({{ site.baseurl }}{% link getting-started.md %}#updating) | Installs the latest release, or `--ref <ref>`, unless that commit is already installed |
| [`syncjar whoami`]({{ site.baseurl }}{% link configuration.md %}#checking-a-client-whoami) | Shows the v2 client's scopes and which commands it can run |
