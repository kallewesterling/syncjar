---
title: Settings and links
parent: Checks
nav_order: 3
---

# Settings and links
{: .no_toc }

1. TOC
{:toc}

---

## Odd settings: `check:settings`

Most settings are the same on nearly every course: sequential navigation,
registration rules, progress tracking. A course that differs is usually a
dashboard slip. `check:settings` finds those, read-only.

For each course, published course, path and published path setting, it
finds the value most records use. If one value covers at least 90% of them,
every record with another value is listed. Settings that are genuinely
split, such as `hidden`, are reported as varying rather than flagged.
Nothing is hardcoded, so the norm is whatever your catalog does.

```bash
syncjar check:settings                                   # report
syncjar check:settings --domain courses.example.com      # one domain; repeatable
syncjar check:settings --threshold 0.8                   # a looser norm
syncjar check:settings --fail-on-outliers                # exit 1 if anything is flagged, for CI
```

Domains come from `--domain`, then `SKILLJAR_DOMAINS`, then every domain the
key can see. It uses the v1 API key.

## Broken links: `check:links`

```bash
npm run check:links
```

Reads every lesson in the [local preview]({{ site.baseurl }}{% link content/previewing.md %}),
collects every link, and sends each unique URL a `HEAD` request with a
five-second timeout. Anything that doesn't answer `200` is written to
`public/data/link-report.json` with the lessons that use it. Fragment
(`#…`) and `mailto:` links are skipped.

It reads the preview's copy of the content, so run `npm run generate:courses`
first, and run it from a clone.

{: .note }
Some sites answer `HEAD` with an error while working fine in a
browser, so treat the report as a list to look at rather than a list to fix.
