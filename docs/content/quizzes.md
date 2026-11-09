---
title: Quizzes
parent: Course content
nav_order: 4
---

# Quizzes
{: .no_toc }

1. TOC
{:toc}

---

`pull` writes every quiz to `QUIZ_CONTENT_PATH` as `quiz-<quiz_id>.json`
(see [Pulling]({{ site.baseurl }}{% link content/pulling.md %}#quizzes)).
`push:quizzes` creates new quizzes from files and pushes edits to pulled
ones.

```bash
syncjar push:quizzes --dry-run      # validate, and show what would change
syncjar push:quizzes                # make the changes, asking about each quiz
```

## Writing a new quiz

Create a file named `quiz-new-<anything>.json` in the quiz directory. The
easiest start is a copy of a pulled quiz with every `"id"` line deleted; the
rest of a pulled file is accepted as it is. A minimal quiz:

```json
{
  "name": "Sample: container basics check",
  "html": "<p>Three questions on the lesson you just read.</p>",
  "passing_percentage_correct": 70,
  "questions": [
    {
      "type": "MULTIPLE_CHOICE",
      "html": "<p>Which file lists an image's packages?</p>",
      "answers": [
        { "answer_text": "An SBOM", "correct": true },
        { "answer_text": "A Dockerfile", "correct": false }
      ]
    }
  ]
}
```

| Question type | Answers |
|---|---|
| `MULTIPLE_CHOICE` | Exactly one correct |
| `MULTIPLE_ANSWER` | One or more correct |
| `FILL_IN_THE_BLANK` | Every answer is accepted, so each is `"correct": true` |
| `FREEFORM` | None |

Questions appear in the order they're listed.

Every new quiz file is checked before anything is created, and one that
fails stops the run. Unknown fields are errors: Skilljar silently ignores
fields it doesn't recognise, so a typo would otherwise lose a setting without
telling you.

Each new quiz is read back after it's created and compared with the file. If
anything differs, or a request fails, the half-made quiz is deleted. On
success, the draft is replaced by the pulled form, `quiz-<id>.json`. A quiz
whose name already exists in Skilljar is refused, since that usually means an
earlier run created it; `--allow-duplicate-name` overrides that.

### Attaching it to a lesson

A new quiz isn't attached to any lesson, so learners can't see it yet. Add
it to its lesson in Skilljar, or name the lesson when you create it:

```bash
syncjar push:quizzes --file quiz-new-sbom-basics.json --attach <lesson_id>
```

A lesson's id is in its course's `lessons-meta.json`. `--attach` only works
with `--file`, so it's always clear which quiz goes where.

{: .warning }
Attaching can't be undone through the API, because Skilljar's API can't
remove a content item from a lesson. To detach a quiz, remove it in the
Skilljar dashboard.

## Editing a quiz

Edit a pulled `quiz-<id>.json` and run `push:quizzes`. It compares the file
with Skilljar and shows each change before making it. Changes come in two
kinds, and they matter differently to learners who have already taken the
quiz:

| Change | How it's made | Learners who took the quiz |
|---|---|---|
| Quiz settings; a question's text, type, feedback or grading flags | Edited in place | The question keeps its response history |
| A question's answers or position; a new question anywhere but the end | That question is recreated, and so is every question after it | Those questions' response history leaves the quiz analytics, and learners can no longer review their past answers. Scores and completions are kept. |
| Removing a question | Deleted | The same as above, for that question |

Skilljar's API can't change answers or question order in place, and a new
question always goes to the end. So keeping the file's order means
recreating everything after the first such change.

In-place edits are prompted, and `--force` skips those prompts. Anything that
recreates or removes questions is all-or-nothing for that quiz. It needs an
interactive yes, or `--recreate <quiz_id>` for that quiz, and `--force` never
covers it. New questions are created before old ones are deleted, so a
failure partway leaves extra questions, never missing ones. Every edit is
read back and verified, and the file is rewritten with Skilljar's new ids.

### Quizzes Syncjar won't write

Skilljar holds quizzes that these checks reject: feedback forms with
`LINEAR_SCALE` questions, survey questions with no correct answer, quizzes
with no description, empty "Untitled Quiz" shells. Left as pulled, they show
up as warnings and never block a run. Once edited, a quiz that fails the
checks is refused on its own and the rest of the run goes ahead.

So a quiz with a `LINEAR_SCALE` question can't be pushed from Syncjar, even
when the edit is to another question. Edit it in Skilljar.

## Skipping unchanged quizzes

A quiz file that hasn't changed since its last verified push is skipped
without a request. The record is kept in `.syncjar-quiz-state.json`;
deleting it only makes the next run slower. `--full-scan` compares every
file.

## Options

| Option | Does |
|---|---|
| `--dry-run` | Validate and show what would change; write nothing |
| `--file <name>` | Only this quiz file |
| `--attach <lesson_id>` | Attach the new quiz in `--file` to this lesson |
| `--force` | Create quizzes and make in-place edits without asking |
| `--recreate <quiz_id>` | Allow recreating or removing questions in this quiz; repeatable |
| `--full-scan` | Compare every quiz file, including unchanged ones |
| `--allow-duplicate-name` | Create a quiz even if one with the same name exists |
| `--allow-branch <name>` | Also allow this branch of the content repository |
