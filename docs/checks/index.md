---
title: Checks
nav_order: 5
has_children: true
permalink: /checks/
---

# Checks

Read-only commands that tell you something before you act. None of them
writes to Skilljar.

| Command | Answers | Exit code |
|---|---|---|
| [`check:drift`]({{ site.baseurl }}{% link checks/drift.md %}) | Has anyone edited content in the dashboard since my last pull? | `2` if so, for scripts |
| [`check:visibility`]({{ site.baseurl }}{% link checks/visibility.md %}) | Who can see each course and path, and what looks wrong? | always `0` |
| [`check:settings`]({{ site.baseurl }}{% link checks/settings.md %}) | Which courses' settings differ from the rest? | `1` with `--fail-on-outliers` |
| [`check:links`]({{ site.baseurl }}{% link checks/settings.md %}#broken-links-checklinks) | Which links in my content are broken? | always `0` |
| [`check:membership`]({{ site.baseurl }}{% link students/groups.md %}#checking-membership-checkmembership) | Is this person still in that group? | always `0` |
