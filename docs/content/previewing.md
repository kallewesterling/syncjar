---
title: Previewing
parent: Course content
nav_order: 2
---

# Previewing
{: .no_toc }

1. TOC
{:toc}

---

{: .note }
The preview runs from a clone of the repository only, because it serves
files from the clone's own `public/` directory. The global `syncjar` command
refuses `serve`, `generate:courses` and `build:preview`.

## Build and serve

```bash
npm run build:preview      # pull, then generate the preview index
npm run serve              # http://localhost:3000
```

`build:preview` is `pull` followed by `generate:courses`. After editing
files you only need the second:

```bash
npm run generate:courses
```

The preview lists every course and lesson in `COURSE_CONTENT_PATH`. Each
lesson is rendered in an iframe as a full HTML document, so your Skilljar
theme's styles and scripts apply as they would in Skilljar. Set `PORT` to
use another port.

## Theming

Copy `preview.config.example.json` to `preview.config.json` at the root of
the clone, and fill in your Skilljar domain and theme files:

```json
{
  "baseURL": "https://courses.example.com",
  "theme": {
    "css": ["https://courses.example.com/path/to/theme.css"],
    "js": ["https://courses.example.com/path/to/theme.js"]
  }
}
```

The preview server injects these into each lesson when it renders it.
`preview.config.json` is gitignored, so your URLs stay out of the
repository. Leave the lists empty, or skip the file, to preview unstyled
content.

## Export to Markdown: `export:plaintext`

```bash
syncjar export:plaintext
```

Writes one Markdown file per course to `courses-plaintext/` in the current
directory: its lessons in order, each with its content converted to text.
That's useful for proofreading, search, or feeding a course to other tools.
