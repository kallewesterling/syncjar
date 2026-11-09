---
title: Course content
nav_order: 4
has_children: true
permalink: /content/
---

# Course content

Syncjar's content workflow is a loop:

1. **[Pull]({{ site.baseurl }}{% link content/pulling.md %})** Skilljar into
   files, and commit them.
2. **Edit** the HTML and JSON in your editor.
3. **[Preview]({{ site.baseurl }}{% link content/previewing.md %})** them with
   your theme.
4. **[Check]({{ site.baseurl }}{% link checks/drift.md %})** that nobody has
   edited the same courses in the dashboard since your pull.
5. **[Push]({{ site.baseurl }}{% link content/pushing.md %})**, reviewing a
   diff of each change.

Quizzes, learning paths and settings follow the same loop, each with its own
pull and push:

| What | Pulled by | Pushed by |
|---|---|---|
| Course and lesson titles, content items | `pull` | `push` |
| Quizzes | `pull` | `push:quizzes` |
| Learning paths | `pull:paths` | `push:paths` |
| Per-domain slugs and visibility | `pull:slugs`, `pull:paths` | `push:published-settings` |
| Course settings | `pull` | `push:course-settings` |
| Lesson settings | `pull` | `push:lesson-settings` |

Keep the content directory in its own git repository. Git history is what
shows you what changed in Skilljar between two pulls, and the branch it's on
decides whether a push is allowed.
