---
title: Safety and data handling
nav_order: 8
---

# Safety and data handling
{: .no_toc }

1. TOC
{:toc}

---

Syncjar writes to a live learning platform with real learners on it. This
page collects what it does to keep that safe, and what it expects of you.

## Writes are shown, confirmed and checked

- **Content pushes show a diff and ask** before each change, or once per run
  for settings. `--dry-run` shows everything and writes nothing.
- **Student commands are dry runs by default.** Nothing is written without
  `--confirm`, and then you type the action and count, such as `enroll 12`.
- **Every write is read back.** Skilljar sometimes accepts a request and
  ignores part of it, so a `200` doesn't prove anything. A value that didn't
  land, or another field that moved, is reported as a failure, and the
  command exits non-zero.
- **A write that fails outright stops the run**, rather than the run
  carrying on past it.
- **Changes that cost learners something need their own yes.** Recreating a
  quiz question drops its response history, so `--force` never covers it.
- **Nothing irreversible is called.** Syncjar never calls Skilljar's account
  anonymisation endpoint. Removing access deactivates, which can be undone.

## Pushes come from the right place

- `push` and every other push command refuse to write from any branch of
  your content repository but `dev` or `main`, unless you name another with
  `--allow-branch`. See
  [Branch guard]({{ site.baseurl }}{% link content/pushing.md %}#branch-guard).
- [`check:drift`]({{ site.baseurl }}{% link checks/drift.md %}) tells you
  whether a push would overwrite someone's dashboard edits.
- Keep the Syncjar install itself current too (`syncjar update`, or
  `git pull` in a clone). An old version doesn't fail: it does what it did
  then, which may be wrong now.

## Pulls never leave a file half-written

Every file a pull writes goes to a temporary file first and is renamed into
place, so stopping a pull can't leave an empty or truncated content file. An
empty value from Skilljar over a file with content is read a second time
before it's written. See
[Interrupting a pull]({{ site.baseurl }}{% link content/pulling.md %}#interrupting-a-pull).

## Credentials are never printed

When a request fails, the error that comes back from the HTTP library holds
the request's headers, including the `Authorization` header, which carries
your v1 API key in a form anyone can decode. A crash that printed that error
would print your key.

So Syncjar strips every failed request down to its method, URL, status and
response body before anything can print it, and commands report failures as
a status and a short message. `whoami` prints a v2 client's scopes, never its
token or secret.

If a key or secret does end up in a terminal log, a CI transcript or a chat,
rotate it.

## Student data

These files hold students' names and email addresses:

- the audit CSVs that group and enrollment commands write;
- `export:students`, `export:enrollments` and `export:users`;
- the `sync:users` cache;
- `group:audit` output.

They're all written to `public/data/`, which a clone's `.gitignore`
excludes. From the global command that's `public/data/` under the directory
you ran it in, so keep it out of any repository you commit.

**Delete them when the task is done.** They regenerate from the API in one
command.

`check:drift` leaves out the names of the dashboard users behind each edit
unless you ask, and never writes them to a file or a non-interactive log.
