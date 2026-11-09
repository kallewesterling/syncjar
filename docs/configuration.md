---
title: Configuration
nav_order: 3
---

# Configuration
{: .no_toc }

1. TOC
{:toc}

---

## Where settings are read from

Syncjar is configured with environment variables, usually kept in `.env`
files. They are read in this order, and a later one wins over an earlier
one:

1. `~/.config/syncjar/.env`. That is `$XDG_CONFIG_HOME/syncjar/.env` when
   `XDG_CONFIG_HOME` is set, and `%APPDATA%\syncjar\.env` on Windows.
2. The clone's own `.env`, when running from a clone.
3. `.env` in the current directory.
4. Variables already set in your shell, which win over every file.

So a user-level file can hold your credentials, and a project directory can
point the content paths somewhere else.

## Variables

| Variable | Used by | Default |
|---|---|---|
| `SKILLJAR_API_KEY` | v1 commands (see below) | none |
| `SKILLJAR_CLIENT_ID`, `SKILLJAR_CLIENT_SECRET` | v2 commands (see below) | none |
| `COURSE_CONTENT_PATH` | Where courses are pulled to, pushed from and previewed | `local-skilljar/` |
| `QUIZ_CONTENT_PATH` | Where quizzes are pulled to and pushed from | `local-skilljar-quizzes/` |
| `PATH_CONTENT_PATH` | Where learning paths are pulled to and pushed from | `local-skilljar-paths/` |
| `SKILLJAR_DOMAINS` | The domains `pull:slugs`, `pull:paths` and `check:settings` ask about, comma-separated. `--domain` overrides it | none |
| `SYNCJAR_INTERNAL_DOMAIN` | The email domain `export:users` marks as internal. `--internal-domain` overrides it | none |
| `PORT` | The preview server's port | `3000` |

A *domain* here means a Skilljar training domain, the host your learners
visit, such as `courses.example.com`. Courses and paths are published per
domain, so slugs and visibility are per domain too.

## Credentials

Skilljar has two APIs, and Syncjar uses both.

**The v1 API** takes a single organisation-wide API key,
`SKILLJAR_API_KEY`. It can read and write everything, so treat it like an
administrator password.

**The v2 API** takes an OAuth client: `SKILLJAR_CLIENT_ID` and
`SKILLJAR_CLIENT_SECRET`, which Syncjar exchanges for a short-lived token.
Each client holds named *scopes*, such as `students:read` or
`enrollments:write`, and can do nothing outside them. So you can issue a
client for one job, for example to someone who manages group membership but
should not be able to touch course content.

Skilljar's API reference covers both, including how to get credentials:
[v1](https://api.skilljar.com/docs/) and
[v2](https://api.skilljar.com/v2/docs).

### Which commands need which

**v1 API key (`SKILLJAR_API_KEY`):**
`pull`, `pull:slugs`, `pull:paths`, `push`, `push:quizzes`,
`push:course-settings`, `push:paths`, `push:lesson-settings`,
`push:published-settings`, `check:settings`, `check:membership`,
`export:students`, `sync:users`, `group:audit`, `group:revoke`, and
`build:preview`, which runs `pull`.

**v2 client, with these scopes:**

| Command | Scopes |
|---|---|
| `whoami` | none beyond a valid client |
| `group:add`, `group:remove` | `student-groups:read`, `student-groups:write`, `students:read` |
| `group:domains` | `student-groups:read`, `student-groups:write` |
| `enroll:add`, `enroll:remove` | `courses:read`, `published-courses:read`, `domains:read`, `students:read`, `enrollments:read`, `enrollments:write` |
| `export:analytics` | `courses:read`, `analytics:read`, plus `domains:read` with `--domain` or `--by-domain` |
| `export:enrollments` | `enrollments:read`, `published-courses:read`, `courses:read`, `students:read`, `analytics:read`, plus `domains:read` with `--domain` |
| `check:drift` | `audit:read`, `lessons:read`, `courses:read` |
| `check:visibility` | `domains:read`, `student-groups:read`, `published-courses:read`, `paths:read` |

**Neither:** `generate:courses`, `serve`, `check:links`,
`export:plaintext`, and `export:users` and `export:metrics`, which read what
`sync:users` saved.

{: .warning }
`student-groups:write` is broader than group membership. Besides adding and
removing members, it lets a client rename groups, rewrite their auto-add
email domains, change which courses they can see, and delete them. Syncjar's
own commands do none of that except `group:domains`, but anyone holding the
credentials can call the API directly. Say so when you hand one out.

### Checking a client: `whoami`

A v2 client that lacks a scope gets an error from the first request that
needs it, which can be partway through a run. `whoami` checks up front:

```bash
syncjar whoami          # for people
syncjar whoami --json   # for scripts
```

It exchanges the client id and secret for a token and reads the client,
organisation, token lifetime and scopes from the token itself, because
Skilljar's token response doesn't list them. Then it lists every v2 command
as runnable or with the scopes it is missing, and the v1 commands with
whether `SKILLJAR_API_KEY` is set.

It makes no request beyond the token exchange, and never prints the token or
the secret.

## Keeping credentials safe

- Keep `.env` files out of git. A clone's `.gitignore` already covers `.env`.
- Make the user-level file readable only by you:
  `chmod 600 ~/.config/syncjar/.env`.
- Prefer a narrowly scoped v2 client over the v1 key wherever a command
  allows it.
- If a key or secret is ever pasted into a terminal log, a CI transcript or a
  chat, rotate it.
