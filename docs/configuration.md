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

Syncjar is configured with environment variables. They are read in this
order, and a later one wins over an earlier one:

1. The macOS Keychain, for the three credentials only. See
   [macOS Keychain](#macos-keychain).
2. `~/.config/syncjar/.env`. That is `$XDG_CONFIG_HOME/syncjar/.env` when
   `XDG_CONFIG_HOME` is set, and `%APPDATA%\syncjar\.env` on Windows.
3. The clone's own `.env`, when running from a clone.
4. `.env` in the current directory.
5. Variables already set in your shell, which win over every file.

Keep credentials in the Keychain or a password manager, not in a `.env`
file; see [Keeping credentials in a password manager](#keeping-credentials-in-a-password-manager).
A `.env` file is fine for settings that aren't secret, such as pointing the
content paths somewhere else from a project directory.

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
| `group:domains` | `student-groups:read`, `student-groups:write`, plus `students:read` with `--check-existing` |
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

## Keeping credentials in a password manager

A `.env` file holds the secret in plain text, where any program running as
you can read it, and it's a common way for credentials to leak: into a
commit, a backup, a shared screen, or an AI assistant that reads the project.
Syncjar doesn't need the file. It reads the macOS Keychain itself, and a
variable set in the environment wins over every `.env`, so a password manager
can supply the credentials to one command at a time and nothing is written
to disk.

### macOS Keychain

Nothing to install and no wrapper to write: Syncjar looks its credentials up
in your login Keychain. Store each one as a generic password with the
service `syncjar` and the variable's name as the account. Ending the command
with `-w` makes `security` prompt for the value, so it never lands in your
shell history:

```bash
security add-generic-password -U -s syncjar -a SKILLJAR_API_KEY -w
security add-generic-password -U -s syncjar -a SKILLJAR_CLIENT_ID -w
security add-generic-password -U -s syncjar -a SKILLJAR_CLIENT_SECRET -w
```

Store only the ones you use. `-U` replaces a value that's already there, so
the same command rotates a credential. To remove one:

```bash
security delete-generic-password -s syncjar -a SKILLJAR_API_KEY
```

Syncjar asks the Keychain only when a command needs a credential and the
variable isn't already set. So a value in your shell or in any `.env` file
still wins: once a credential is in the Keychain, delete its line from every
`.env`. `syncjar whoami` shows whether the credentials arrived.

The Keychain encrypts the value and keeps it out of every project directory,
which is what keeps it away from tools that read files. It is not a prompt
on every use: any program running as you can ask `security` for it, as
Syncjar does. For that, use 1Password, below.

Set `SYNCJAR_NO_KEYCHAIN=1` to stop Syncjar reading the Keychain.

### 1Password

You need the [1Password CLI](https://developer.1password.com/docs/cli/get-started/)
(`op`), signed in, ideally through the desktop app's integration.

1. Save the credentials as an item, for example an **API Credential** named
   `Syncjar`, with the client id as its `username` and the secret as its
   `credential`.
2. Write a file of *references* to that item. It holds no secrets, so it
   can't leak one:

   ```env
   # ~/.config/syncjar/op.env
   SKILLJAR_CLIENT_ID=op://Private/Syncjar/username
   SKILLJAR_CLIENT_SECRET=op://Private/Syncjar/credential
   ```

   Use your vault's name in place of `Private`.
3. Run commands through `op run`, which resolves the references, sets the
   variables for that one command, and masks the secret in its output:

   ```bash
   op run --env-file ~/.config/syncjar/op.env -- syncjar whoami
   ```

To avoid typing that every time, add a function to your `~/.zshrc` or
`~/.bashrc`:

```bash
syncjar() { op run --env-file "$HOME/.config/syncjar/op.env" -- command syncjar "$@"; }
```

### Bitwarden

You need the [Bitwarden CLI](https://bitwarden.com/help/cli/) (`bw`), logged
in with `bw login`.

1. Save the credentials as a login item named `Syncjar`, with the client id
   as its username and the secret as its password.
2. Add a function to your `~/.zshrc` or `~/.bashrc`. It unlocks the vault
   when needed and sets the variables for that one command:

   ```bash
   syncjar() {
     if [ -z "$BW_SESSION" ]; then
       BW_SESSION="$(bw unlock --raw)" || return
       export BW_SESSION
     fi
     SKILLJAR_CLIENT_ID="$(bw get username Syncjar)" \
     SKILLJAR_CLIENT_SECRET="$(bw get password Syncjar)" \
       command syncjar "$@"
   }
   ```

   The vault stays unlocked in that terminal until you run `bw lock` or close
   it. If more than one item is named `Syncjar`, `bw get` refuses; use the
   item's id instead.

Organisations on Bitwarden Secrets Manager can use `bws run -- syncjar …`
instead, with secrets named `SKILLJAR_CLIENT_ID` and `SKILLJAR_CLIENT_SECRET`.

Either way, `syncjar whoami` shows whether the credentials arrived.

## Keeping credentials safe

- Keep credentials in the Keychain or a password manager (above), never in
  a `.env` file.
- If a `.env` file holds anything else, keep it out of git (a clone's
  `.gitignore` already covers `.env`) and make the user-level one readable
  only by you: `chmod 600 ~/.config/syncjar/.env`.
- Prefer a narrowly scoped v2 client over the v1 key wherever a command
  allows it.
- If a key or secret is ever pasted into a terminal log, a CI transcript or a
  chat, rotate it.
