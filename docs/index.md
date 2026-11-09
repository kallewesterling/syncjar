---
title: Home
layout: home
nav_order: 1
description: Syncjar is a command-line tool for editing, previewing and syncing Skilljar course content from your own machine.
permalink: /
---

# Syncjar
{: .fs-9 }

Edit, preview and sync [Skilljar](https://www.skilljar.com/) course content
from your own machine, and manage the students and groups around it from the
command line.
{: .fs-6 .fw-300 }

[Get started]({{ site.baseurl }}{% link getting-started.md %}){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/kallewesterling/syncjar){: .btn .fs-5 .mb-4 .mb-md-0 }

---

Syncjar mirrors a Skilljar organisation's courses, lessons, quizzes and
learning paths into plain files. You edit them in any editor, keep them in
git, preview them with your own theme, and push the changes back, seeing a
diff of each one first.

It also covers the work around the content: putting students in groups,
enrolling them, exporting rosters and analytics, and checking who can see
which course.

This documentation covers **Syncjar 2.1.1**.

## What it does

| | |
|---|---|
| **[Pull]({{ site.baseurl }}{% link content/pulling.md %})** | Every course, lesson, content item, quiz and learning path, as HTML and JSON files. |
| **[Preview]({{ site.baseurl }}{% link content/previewing.md %})** | A local site that renders each lesson with your Skilljar theme. |
| **[Push]({{ site.baseurl }}{% link content/pushing.md %})** | Your edits back to Skilljar, with a word-level diff and a prompt for each change. |
| **[Quizzes]({{ site.baseurl }}{% link content/quizzes.md %})** | Write a quiz as a JSON file and create it, or edit a pulled one. |
| **[Settings]({{ site.baseurl }}{% link content/settings.md %})** | Course, lesson, path and visibility settings, kept in files and pushed like content. |
| **[Checks]({{ site.baseurl }}{% link checks/index.md %})** | Dashboard edits made since your last pull, who can see what, odd settings, broken links. |
| **[Students]({{ site.baseurl }}{% link students/index.md %})** | Group membership, enrollments, and CSV exports of students, enrollments and analytics. |

## Built to be hard to misuse

Syncjar writes to a live learning platform, so it is cautious by default:

- Commands that change student records are **dry runs** unless you pass
  `--confirm`, and then ask you to type what they are about to do.
- Every write is **read back** and checked, so a request that Skilljar
  accepts but ignores is reported as a failure.
- Runs that change students write an **audit CSV** with each record's state
  before and after.
- `push` refuses to run from a feature branch of your content repo, and shows
  every change before making it.
- API credentials are **never printed**, not even in a crash.

[Safety and data handling]({{ site.baseurl }}{% link safety.md %}) covers the rest.

## Requirements

- Node.js 20.19 or later.
- A Skilljar organisation with API access: a v1 API key, a v2 API client, or
  both, depending on the commands you use. See
  [Credentials]({{ site.baseurl }}{% link configuration.md %}#credentials).
