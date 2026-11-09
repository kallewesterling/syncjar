---
title: Pushing
parent: Course content
nav_order: 3
---

# Pushing
{: .no_toc }

1. TOC
{:toc}

---

`push` writes your local course titles, lesson titles and HTML content items
to Skilljar. It shows a diff of each change and asks before making it.

```bash
syncjar check:drift && syncjar push
```

{: .warning }
Local wins. A push replaces what's in Skilljar with your file, so a lesson
someone edited in the dashboard since your last pull loses that edit. Run
[`check:drift`]({{ site.baseurl }}{% link checks/drift.md %}) first, and pull
if it reports anything.

`push` doesn't read settings: changing a setting in `details.json` and running
`push` reports nothing to do. Settings have
[their own commands]({{ site.baseurl }}{% link content/settings.md %}), as do
[quizzes]({{ site.baseurl }}{% link content/quizzes.md %}) and
[learning paths]({{ site.baseurl }}{% link content/settings.md %}#path-details-lesson-settings-and-visibility).

## Options

```bash
syncjar push --dry-run                    # show the diffs, write nothing
syncjar push --diff-only                  # the same, without the prompts
syncjar push --course <dir> --lesson <slug>   # one course, or one lesson in it
syncjar push --force                      # content changes without prompting
syncjar push --force-titles               # title changes without prompting
syncjar push --no-diff                    # prompt without showing diffs
syncjar push --diff-style stacked         # or side-by-side; default auto
syncjar push --concurrency 3              # read requests at once; default 6
syncjar push --full-scan                  # compare every course, skipping none
syncjar push --allow-branch feat/x        # allow a content-repo branch other than dev and main
syncjar push --add-last-updated           # also set each changed lesson's description to "Last updated: <date>"
```

`--force` and `--force-titles` are separate, so you can accept content
changes in bulk and still review every rename.

{: .note }
`--add-last-updated` *replaces* the lesson's description; it doesn't add to
it.

## How a push runs

A push has two phases.

1. **Scan.** Every local course is compared with Skilljar and a list of
   changes is built. Nothing is written, so this runs several reads in
   parallel.
2. **Apply.** The list is walked in order, with a diff and a prompt for each
   change.

So you see the whole list of changes before the first prompt. If Skilljar
starts throttling, the client prints a retry notice and backs off; lower
`--concurrency` if it keeps happening. `--course` and `--lesson` make the
scan faster still.

`push` only ever writes HTML content items. It refuses to write a file whose
item in Skilljar is a quiz or another type, because the write would replace
it with an HTML page.

## Reading a diff

Diffs show Skilljar on the left and your file on the right, with the changed
words highlighted:

```text
  Skilljar (upstream)                          │   local
───────────────────────────────────────────────┼───────────────────────────────────────────────
  ⋯ 6 unchanged line(s) ⋯
  </li>                                        │   </li>
- <li>Automate image updates in CI/CD          │ + <li>Automate image updates everywhere CI/CD
  </li>                                        │   </li>
```

Both sides are reflowed onto matching lines before they're compared, using
the same whitespace rules as the push itself. Skilljar and your editor
indent and wrap the same markup differently, and without that step nearly
every line would read as changed. Inside `<pre>`, whitespace is left exactly
as it is, because there it is content.

The lines come from the reflow, so they aren't line numbers in your file,
and none are shown. On a terminal narrower than 100 columns, `auto` uses the
one-column `stacked` layout.

## Skipping courses that haven't changed

`push` records which courses it has verified as in sync, in
`.syncjar-push-state.json`. On the next run a course is skipped, with no
requests at all, when **both** of these hold:

- its local files hash to what they hashed to then, and
- its `modified_at` in Skilljar is what it was then.

The timestamp costs nothing, because `push` reads the whole catalog in one
request anyway. For a catalog where you've edited one or two courses, a
push that took minutes takes seconds.

Anything unknown means a full scan: no state file, a changed hash, a moved
timestamp, a state file from an older version. Deleting the file is always
safe. `--full-scan` ignores it, and so does `--lesson`, since the hash
covers a whole course.

A run that skipped everything says so, rather than claiming it checked:

```text
✓ Nothing to push — 40 course(s) skipped, no content compared.
```

Only `--full-scan` actually compares everything. A course is only recorded
once it is fully in sync, so if you decline one of its prompts, its changes
are still there on the next run.

### Why skipping is safe

Not because the timestamp is reliable: edits made through the API don't move
it at all. It's safe because **a skipped course is never written to**. The
worst a wrong skip can do is fail to *report* an upstream edit. It can't
overwrite one. Bringing upstream edits down is `pull`'s job, and once a pull
does, the local hash changes and the course is scanned again.

## Branch guard

Skilljar has one live state and knows nothing about branches. If your content
repository is on a feature branch that's behind its main line, a push from it
silently overwrites whatever landed there in the meantime.

So `push`, and every other push command, refuses to write unless the git
repository holding the files it pushes is on `dev` or `main`. A detached
HEAD, or a content directory that isn't a git repository, is refused too.
`--dry-run` and `--diff-only` work from any branch.

```bash
syncjar push --allow-branch feat/new-lesson    # name another branch explicitly
```

The guard checks *which* branch you're on, not whether it's up to date. Pull,
in both git and Syncjar, before you push.
