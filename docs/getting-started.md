---
title: Getting started
nav_order: 2
---

# Getting started
{: .no_toc }

1. TOC
{:toc}

---

There are two ways to run Syncjar:

- **As a global `syncjar` command**, installed with npm. This is the one to
  use if you work with students and groups, or pull and push content but
  don't need the local preview.
- **From a clone of the repository**, with `npm run`. The local preview
  (`serve`, `generate:courses`, `build:preview`) and `check:links` only run
  from a clone.

Both run the same commands with the same options: `syncjar push --dry-run`
and `npm run push -- --dry-run` are the same thing.

## Install the `syncjar` command

You need Node.js 20.19 or later.

```bash
npm install --global github:kallewesterling/syncjar#main
```

`main` holds the latest release. To pin one, name its tag instead, for
example `#v2.1.1`. Then check it works:

```bash
syncjar help       # every command, and where credentials are read from
syncjar --version
```

### Updating

```bash
syncjar update                  # the latest release
syncjar update --ref v2.1.1     # a specific tag, branch or commit
syncjar update --force          # reinstall even if it's already installed
```

`syncjar update` looks up the commit the ref points at, and does nothing if
that commit is already installed. It checks the commit, not the version
number, because a branch keeps the same version number from one commit to
the next.

npm doesn't record which commit it installed, so the first update after
installing with `npm install --global` always reinstalls. After that,
`update` keeps its own record, and `syncjar help` shows the ref and commit
you're on.

Before installing, `update` also checks that the ref provides the `syncjar`
command. Very old refs don't, and installing one would remove the command,
leaving you no `syncjar update` to recover with.

## Or work from a clone

```bash
git clone https://github.com/kallewesterling/syncjar.git
cd syncjar
npm install
```

Run commands as `npm run <command>`, with options after `--`:

```bash
npm run push -- --dry-run
```

Update a clone with `git pull`. `syncjar update` refuses to run from one.

## Add your credentials

Syncjar talks to two versions of the Skilljar API, and each takes its own
credentials:

```env
# The v1 API: content, quizzes, paths, settings, user exports
SKILLJAR_API_KEY=...

# The v2 API: groups, enrollments, analytics, drift and visibility checks
SKILLJAR_CLIENT_ID=...
SKILLJAR_CLIENT_SECRET=...
```

You only need the ones for the commands you use;
[Credentials]({{ site.baseurl }}{% link configuration.md %}#credentials) lists
which commands need which.

For the global command, the natural place is a user-level file that only you
can read:

```bash
mkdir -p ~/.config/syncjar
touch ~/.config/syncjar/.env && chmod 600 ~/.config/syncjar/.env
```

In a clone, a `.env` at the repository root works too, and is gitignored.

If you have a v2 client, check what it can do:

```bash
syncjar whoami
```

It lists every v2 command as runnable or with the scopes it is missing.

## Your first pull

Pick a directory for your course content. Keeping it in its own git
repository is strongly recommended. Git history is what lets you see what
changed in Skilljar, and `push` relies on the branch it's on (see
[Pushing]({{ site.baseurl }}{% link content/pushing.md %}#branch-guard)).

```env
COURSE_CONTENT_PATH=../courses
```

Then pull:

```bash
syncjar pull
```

Each course becomes a directory with its details, its lessons and one HTML
file per content item:

```text
<course>/
├── details.json
├── lessons-meta.json
└── lessons/
    └── <lesson>/
        └── content-<content_item_id>.html
```

Quizzes and learning paths have their own pulls and directories; see
[Pulling]({{ site.baseurl }}{% link content/pulling.md %}).

## Edit, preview, push

From a clone, build the preview and open it:

```bash
npm run build:preview     # pull, then generate the preview index
npm run serve             # http://localhost:3000
```

Edit a content file, run `npm run generate:courses` to refresh the preview,
and when you're happy:

```bash
syncjar check:drift && syncjar push --dry-run
syncjar push
```

`check:drift` stops the line if someone has edited a course in the Skilljar
dashboard since your last pull, because a push would overwrite that edit.
`push --dry-run` shows every change without making it, and `push` asks
before each one.

## Where files are written

From a clone, everything is written inside the clone. From the global
command, defaults such as `local-skilljar/` and `public/data/` are written
under **the directory you run the command from**. They never go inside the
installation, because the next `syncjar update` replaces it.

Exports and audit files go to `public/data/`. Several of them hold students'
names and email addresses; see
[Safety and data handling]({{ site.baseurl }}{% link safety.md %}#student-data).
