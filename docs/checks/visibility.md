---
title: Who can see what (check:visibility)
parent: Checks
nav_order: 2
---

# Who can see what: `check:visibility`
{: .no_toc }

1. TOC
{:toc}

---

Skilljar's visibility rules combine three things: whether a published course
or path is hidden, whether strict enforcement is on, and per-group overrides.
The combination is hard to read in the dashboard. `check:visibility` works it
out, per domain, in plain words.

```bash
syncjar check:visibility                                          # every domain and group
syncjar check:visibility --domain courses.example.com --group Partners
syncjar check:visibility --json                                   # the whole model, for scripts
syncjar check:visibility --out                                    # also write public/data/visibility.csv
```

It needs a v2 client with `domains:read`, `student-groups:read`,
`published-courses:read` and `paths:read`. It only reads.

## What it reports

For each domain, it lists the published courses and paths that are
restricted (hidden, strictly enforced, or carrying group rules) and says who
can see each one. Then it lists what each group unlocks, and then likely
mistakes:

- overrides on unpublished courses, or on courses that no longer exist;
- a hidden course or path with strict enforcement and no allowed group, which
  nobody can see;
- a path listed for an audience that can see none of its courses, which
  closes its registration;
- a restricted course inside a path that more people can see.

## How each record is judged

Each record is judged for **(everyone)**, meaning anyone in none of its
groups, anonymous visitors included, and for each group, as one of:

| Verdict | Meaning |
|---|---|
| `listed` | Shows in the catalog |
| `link-only` | Not in the catalog, but a direct link opens it |
| `blocked` | Neither |
| `unpublished` | Not live on this domain |

`hidden` decides whether it's listed. Strict enforcement decides whether a
direct link still works.

The rules come from Skilljar's API specification:

- On a hidden course, only *allow* overrides matter.
- On a visible course, only *block* overrides matter.
- A published path has one group list whose meaning flips: allowed on a
  hidden path, blocked on a visible one.

## Limits

- Category-based visibility isn't modelled; the report says so where it
  applies.
- It doesn't work out what a student in several groups sees.
- The verdicts follow the specification. They haven't been confirmed by
  signing in as a member and a non-member of each group.

It exits 0 whatever it finds.
