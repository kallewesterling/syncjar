<h1 align="center"><img src="./img/logo.png" height="50" width="auto" valign="middle" />Syncjar</h1>

<p align="center">
  <strong>Edit, preview, and sync Skilljar course content locally.</strong>
</p>

<p align="center">
  The local-first Skilljar workflow tool for developers, course authors, and content pros.
</p>

---

**Syncjar** is a command-line tool that lets you pull, edit, preview, and sync course content from [Skilljar](https://www.skilljar.com/) — all from your local development environment.

It's your local **Skilljar workspace**: Write content, test changes, see diffs, and push updates upstream.

---

## ✨ Key Features

- 🔁 **Two-way sync** between Skilljar and local files
- ✍️ **Edit each Skilljar content-item** as a standalone HTML file
- 🔍 **Visual diffs** before syncing changes
- 🧪 **Local preview** mode for testing courses offline
- 💾 Uses the Skilljar API with simple setup

---

## 🗂 Folder Structure

```bash
.
├── local-skilljar/
│   └── <course-slug>/
│       ├── details.json
│       ├── lessons-meta.json
│       └── lessons/
│           └── <lesson-slug>/
│               └── content-<content_item_id>.html
│
├── local-skilljar-paths/
│   └── <path-title>/
│       ├── details.json             # The learning path itself
│       ├── path-items.json          # Its member courses
│       └── published.json           # Per-domain slugs
│
├── public/
│   ├── courses/                     # Local preview output
│   └── data/
│       └── courses.json             # Course structure for preview UI
│
├── scripts/
│   ├── sync-skilljar-to-local.mjs   # Pull from Skilljar
│   ├── sync-local-to-skilljar.mjs   # Push to Skilljar (with diffing)
│   ├── pull-slugs.mjs               # Pull per-domain URL slugs
│   ├── pull-paths.mjs               # Pull learning paths and their members
│   ├── course-dirs.mjs              # Map course ids to course directories
│   ├── generate-courses-json.mjs    # Create preview course index
│   ├── export-courses-to-md.mjs     # Export course content as Markdown
│   ├── export-users-to-csv.mjs      # Export Skilljar users to CSV
│   ├── metrics-to-csv.mjs           # Export course metrics to CSV
│   ├── check-links.mjs              # Check for broken links in content
│   ├── sync-users.mjs               # Sync user data from Skilljar
│
├── .env                             # API key
└── README.md
```

## 🚀 Setup

Clone the repo and install dependencies:

```bash
git clone https://github.com/<your-org>/syncjar.git
cd syncjar
npm install
```

2. Add your Skilljar API key to a .env file:

```env
SKILLJAR_API_KEY=sk-live-abc123
```

3. Pull your Skilljar content and generate the local preview index:

```bash
npm run build:preview
```

## 📋 Available Commands

| Command | Description |
|---|---|
| `npm run pull` | Pull all courses from Skilljar to local files |
| `npm run pull -- --course <slug>` | Pull a single course (partial match on directory name or title) |
| `npm run pull:slugs` | Pull each course's per-domain URL slugs |
| `npm run pull:paths` | Pull learning paths, their member courses, and their per-domain slugs |
| `npm run pull:paths -- --path <query>` | Pull a single path (partial match on directory name or title) |
| `npm run push` | Push local edits back to Skilljar (with diffs + prompts) |
| `npm run generate:courses` | Regenerate the local preview index |
| `npm run build:preview` | Pull + generate (full refresh) |
| `npm run serve` | Start the local preview server at http://localhost:3000 |
| `npm run export:plaintext` | Export course content as Markdown |
| `npm run export:users` | Export Skilljar users to CSV |
| `npm run export:metrics` | Export course metrics to CSV |
| `npm run check:links` | Check for broken links in course content |
| `npm run sync:users` | Sync user data from Skilljar |
| `npm test` | Run the unit tests |

## 🗃 Course Directory Names

A course's directory name comes from its **course id**, not its title.

`npm run pull` reads the `id` in every `details.json` under the content path and
builds a map of course id to directory name. A course that already has a
directory keeps that directory's name exactly, even after someone rewords or
re-cases its title in Skilljar. Only a course id that is new to the tree gets a
name derived from its title.

This is what stops a renamed course from gaining a second directory. It also
keeps the tree safe on macOS, where two names that differ only in case cannot
coexist.

To rename a course directory, rename it yourself. The next pull follows the new
name, because it matches on the id.

## 🧭 Learning Paths

Skilljar models a learning path much like a course, so `npm run pull:paths`
mirrors the same three objects per path into `local-skilljar-paths/<path>/`:

| File | Source | Contents |
|---|---|---|
| `details.json` | `GET /paths` | The path itself, verbatim: title, descriptions, promo image, item count |
| `path-items.json` | `GET /paths/{id}/path-items` | Its member courses, verbatim |
| `published.json` | `GET /domains/{domain}/published-paths` | Per-domain slug, publish id, and hidden flag |

Directory naming follows the same id-not-title rule as courses, for the same
reason — see the section above.

Set `PATH_CONTENT_PATH` in `.env` to write somewhere else (for example, into a
content repo alongside `COURSE_CONTENT_PATH`):

```env
PATH_CONTENT_PATH=../courses/paths
```

Slugs are per-domain, so `published.json` needs to know which domains to ask
about — the same `SKILLJAR_DOMAINS` (or `--domain`) that `pull:slugs` uses. A
run with neither configured still writes `details.json` and `path-items.json`,
and says it is skipping `published.json`.

```bash
npm run pull:paths                               # everything
npm run pull:paths -- --path "onboarding"        # one path
npm run pull:paths -- --dry-run                  # print, write nothing
npm run pull:paths -- --check                    # CI: non-zero exit if any file is stale
```

Two caveats worth knowing before you build anything on the output:

- **`path-items.json` is membership, not a running order.** The API returns no
  order field, and the order it does return is not display order. The file
  preserves API order and claims nothing more.
- **A path id belongs to one domain on some instances and several on others.**
  `published.json` is keyed by domain either way, so it represents both without
  assuming. If your instance has separate path objects per domain, note that
  two different path ids can share a slug, and only the slug is common to both.

Paths are read-only here: `npm run push` syncs course and lesson content, and
does not write path titles or descriptions back upstream.

## 🔁 Sync Local Edits Back to Skilljar

After editing any content file in `local-skilljar/<course>/lessons/<lesson>/content-<content_item_id>.html`, run:

```bash
npm run push
```

This will show diffs and prompt before updating content upstream.

## 🛠️ Example Workflows

### 🔄 Pull and refresh everything (Skilljar → local)

```bash
npm run build:preview
```

Runs:

```
npm run pull
npm run generate:courses
```

### 📝 Edit content locally and preview it

After these scripts have run, you can edit the .html files in `local-skilljar/<course>/lessons/<lesson>/`.

After you make changes, you need to rebuild the local preview index:

```bash
npm run generate:courses
```

Then you can preview the content:

```bash
npm run serve
```

This starts a local server at [http://localhost:3000](http://localhost:3000). Each lesson is rendered inside an iframe as a full HTML document, so Skilljar theme styles and scripts are applied accurately.

## 🎨 Theming

Add your Skilljar theme CSS and JS URLs to `preview.config.json` at the project root:

```json
{
  "theme": {
    "css": [
      "https://your-skilljar-domain.com/path/to/theme.css"
    ],
    "js": [
      "https://your-skilljar-domain.com/path/to/theme.js"
    ]
  }
}
```

The preview server injects these into each lesson iframe at render time. Leave the arrays empty to preview unstyled content. You may want to add `preview.config.json` to `.gitignore` if it contains internal URLs.

### 📤 Push changes upstream (local → Skilljar)

```bash
npm run push
```

With options:

```bash
# Dry run with diffs
npm run push -- --dry-run

# Push a specific lesson
npm run push -- --course This-Is-My-Course-Title --lesson 03-wrap-up

# Show diffs only (no syncing)
npm run push -- --diff-only

# Push content-item HTML changes without prompting
npm run push -- --force

# Push course/lesson title changes without prompting (separate from --force)
npm run push -- --force-titles

# Push without showing diffs
npm run push -- --no-diff

# Change how many read requests the scan runs at once (default 6)
npm run push -- --concurrency 3

# Force a diff layout (default: auto)
npm run push -- --diff-style stacked
npm run push -- --diff-style side-by-side

# Scan everything, ignoring what was recorded as already in sync
npm run push -- --no-skip
```

#### Skipping courses that haven't changed

`push` records which courses it has verified as in sync, in
`.syncjar-push-state.json` (gitignored). On the next run a course is skipped
outright — no requests for it at all — when **both**:

- its local content hashes to what it hashed to then, and
- the course's upstream `modified_at` is what it was then.

The second is free: `push` already fetches the whole catalogue in one request,
and the timestamp comes with it.

In practice that is the difference between scanning 66 courses and scanning
the one or two you actually edited:

```
Scanning 66 course(s)…
   65 course(s) unchanged since the last push — skipped without a request
   1 course(s) scanned: 42 item(s) in sync, 2 change(s) found in 4.9s
```

**105 seconds to 5.** Measured on the full catalogue.

Anything unknown falls through to a full scan: no state file, a changed hash,
a moved timestamp, a state file from an older version of the tool. Deleting
`.syncjar-push-state.json` is always safe — the next run just scans
everything. `--no-skip` does the same without deleting it, and `--lesson`
disables skipping too, since the hash covers a whole course.

A course is only recorded once it is *fully* in sync. Decline one prompt and
it stays unrecorded, so the rest of its changes are still there next run.

##### Is it safe?

Yes, and not because the timestamp is trustworthy. **A skipped course is never
written to.** The worst a wrong skip can do is fail to *report* that someone
edited that course in the Skilljar web UI — it cannot overwrite that edit,
because it does no writes at all. Reconciling upstream edits is `pull`'s job,
and once a pull brings one down, the local hash changes and the course is
scanned again.

Worth comparing against the behaviour this replaces: on finding such an edit,
`push` used to offer to overwrite the newer upstream copy with the older local
one. Skipping is the more conservative of the two.

#### Reading a diff

Content diffs are shown in two columns, Skilljar on the left and your local
copy on the right, with the changed words highlighted in place:

```
  Skilljar (upstream)                          │   local
───────────────────────────────────────────────┼───────────────────────────────────────────────
  ⋯ 6 unchanged line(s) ⋯
  </li>                                        │   </li>
- <li>Automate image updates in CI/CD          │ + <li>Automate image updates everywhere CI/CD
  </li>                                        │   </li>
  ⋯ 1 unchanged line(s) ⋯
```

Both sides are reflowed onto matching lines before being compared, using the
same whitespace rules the sync itself uses — Skilljar and your local copy
indent and wrap the same markup differently, and without that step nearly
every line reads as changed. Inside `<pre>`, whitespace is left exactly as it
is, because there it is content.

Those display lines are produced by the reflow, so they are not file line
numbers and none are shown.

`--diff-style stacked` gives a one-column `-`/`+` view instead, which is what
`auto` falls back to on a terminal narrower than 100 columns.

#### How a push runs

`push` works in two phases. The **scan** compares every local course against
Skilljar and builds a list of changes; it writes nothing, so it runs in
parallel. The **apply** then walks that list, shows each diff and prompts.

So you see the whole change list before the first prompt, rather than having
prompts surface one at a time over the length of the run. Scanning the full
catalogue — 66 courses, 649 lessons, 822 content items — takes about 80
seconds.

If Skilljar starts throttling (the client prints a retry notice and backs
off), lower `--concurrency`. Narrowing the scan with `--course` or `--lesson`
is faster still, since `--lesson` cuts the content reads to a single request.

#### Branch guard

Skilljar holds one live state and knows nothing about git branches. If your course content repo is on a feature branch that's behind `dev`/`main`, pushing from it silently overwrites whatever landed there in the meantime — and git can't catch that, because the danger is entirely in which branch happens to be checked out.

So `npm run push` refuses to run unless your **course content repo** (`COURSE_CONTENT_PATH`) is on `dev` or `main`. A detached HEAD, or a content directory that isn't a git repo at all, is also refused: nothing establishes that the content is current.

`--dry-run` and `--diff-only` never write to Skilljar, so they work from any branch.

```bash
# Push from another branch, naming it explicitly
npm run push -- --allow-branch feat/new-lesson
```

The guard checks *which* branch you're on, not whether it's up to date — pull before you push.

## 🔒 Connect to Your Course Content

This repo does **not** track course content directly. To use it:

1. Clone your private course content repo:

   ```bash
   git clone git@github.com:<YOUR-ORG>/<YOUR-COURSE-CONTENT-REPO>.git ~/courses
   ```

2. Add to the `.env` file in this repo:

   ```
   COURSE_CONTENT_PATH=../courses
   ```

3. Then run:

   ```bash
   npm run build:preview
   ```

This keeps your course content private and portable across environments.
