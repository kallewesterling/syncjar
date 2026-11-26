#!/usr/bin/env node
/**
 * Adds the LLM-readable versions of the docs site to a built `_site`:
 *
 * - a plain-Markdown copy of each page, at its source path (`badges/issuing.md`
 *   beside `badges/issuing.html`);
 * - `llms.txt`, an index of those copies (https://llmstxt.org/);
 * - `llms-full.txt`, every page in one file.
 *
 *   node tools/llms-docs.mjs docs _site
 *
 * Built from the Markdown sources rather than the HTML, so Jekyll's Liquid
 * links and kramdown attributes are rewritten here. Anything it can't
 * rewrite, a page without a `description`, or a link to a page that isn't
 * published fails the run, so the docs build fails with it.
 *
 * Only Node built-ins: the docs workflow runs it without `npm ci`.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

/** `key: value` lines of a YAML block; enough for front matter and `_config.yml`. */
function parseYamlScalars(text) {
  const data = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (!match || match[2] === '' || match[2] === '>-' || match[2] === '|') continue;
    data[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return data;
}

/** The scalars of `_config.yml`, plus its `exclude:` list. */
export function parseConfig(text) {
  const config = parseYamlScalars(text);
  const block = text.match(/^exclude:\s*\n((?:[ \t]+-.*\n?)+)/m);
  config.exclude = block
    ? block[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
    : [];
  return config;
}

/** Splits a page into its front matter and body. A file without front matter isn't a page. */
export function parsePage(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  return { data: parseYamlScalars(match[1]), body: match[2] };
}

/**
 * The body of a page as plain Markdown. `pageUrl(path)` gives the absolute
 * URL of another page's Markdown copy, or throws if there is none.
 */
export function toPlainMarkdown(body, pageUrl) {
  const linked = body.replace(
    /\{\{\s*site\.baseurl\s*\}\}\{%\s*link\s+(\S+?)\s*%\}/g,
    (_, target) => pageUrl(target)
  );

  const out = [];
  let inFence = false;
  let callout = null;
  const lines = linked.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) {
      out.push(line);
      continue;
    }
    if (/^1\. TOC\s*$/.test(line) && /^\{:\s*toc\s*\}\s*$/.test(lines[i + 1] ?? '')) {
      i++;
      continue;
    }
    const attribute = line.match(/^\{:\s*([^}]*)\}\s*$/);
    if (attribute) {
      const name = attribute[1].trim().match(/^\.(warning|note)$/);
      if (name) callout = name[1][0].toUpperCase() + name[1].slice(1);
      continue;
    }
    const plain = line.replace(/\{:[^}]*\}/g, '');
    if (callout !== null) {
      if (plain.trim() === '') {
        callout = null;
        out.push(plain);
      } else {
        out.push(out.at(-1)?.startsWith('> ') ? `> ${plain}` : `> **${callout}:** ${plain}`);
      }
      continue;
    }
    out.push(plain);
  }

  const markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const leftover = markdown.match(/\{\{.*?\}\}|\{%.*?%\}/);
  if (leftover) throw new Error(`Liquid that can't be rewritten: ${leftover[0]}`);
  return markdown;
}

/** Published pages under `docsDir`, as `{ path, data, body }` with `path` relative and `/`-separated. */
export function collectPages(docsDir, exclude = []) {
  const pages = [];
  const excluded = (rel) =>
    exclude.some((e) => rel === e.replace(/\/$/, '') || rel.startsWith(e.endsWith('/') ? e : `${e}/`));
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (/^[._]/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(docsDir, full).split(path.sep).join('/');
      if (excluded(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) {
        const page = parsePage(fs.readFileSync(full, 'utf8'));
        if (page) pages.push({ path: rel, ...page });
      }
    }
  };
  walk(docsDir);
  return pages;
}

/** Pages in navigation order: top-level by `nav_order`, each followed by its children. */
export function navOrder(pages) {
  const byOrder = (a, b) =>
    (Number(a.data.nav_order) || Infinity) - (Number(b.data.nav_order) || Infinity) ||
    a.path.localeCompare(b.path);
  const ordered = [];
  for (const page of pages.filter((p) => !p.data.parent).sort(byOrder)) {
    ordered.push(page);
    ordered.push(...pages.filter((p) => p.data.parent === page.data.title).sort(byOrder));
  }
  const orphans = pages.filter((p) => !ordered.includes(p));
  if (orphans.length) {
    throw new Error(`Pages whose parent isn't a page: ${orphans.map((p) => p.path).join(', ')}`);
  }
  return ordered;
}

/**
 * Every output file, as `{ [relativePath]: contents }`. Pure, so the tests
 * can check it without a build.
 */
export function buildOutputs(config, pages) {
  const root = `${(config.url ?? '').replace(/\/$/, '')}${(config.baseurl ?? '').replace(/\/$/, '')}`;
  const known = new Set(pages.map((p) => p.path));
  const pageUrl = (target) => {
    if (!known.has(target)) throw new Error(`Link to a page that isn't published: ${target}`);
    return `${root}/${target}`;
  };

  const missing = pages.filter((p) => !p.data.description).map((p) => p.path);
  if (missing.length) throw new Error(`Pages without a description: ${missing.join(', ')}`);

  const outputs = {};
  const ordered = navOrder(pages);
  for (const page of ordered) {
    try {
      outputs[page.path] = toPlainMarkdown(page.body, pageUrl);
    } catch (err) {
      throw new Error(`${page.path}: ${err.message}`);
    }
  }

  const header = `# ${config.title}\n\n> ${config.description}\n`;
  outputs['llms.txt'] = [
    header,
    `Each link is a plain-Markdown copy of a page on ${root}/. ` +
      `[llms-full.txt](${root}/llms-full.txt) has all of them in one file.\n`,
    '## Docs\n',
    ...ordered.map((p) => `- [${p.data.title}](${root}/${p.path}): ${p.data.description}`),
    '',
  ].join('\n');

  outputs['llms-full.txt'] = [
    header,
    ...ordered.map((p) => `---\n\nSource: ${root}/${p.path}\n\n${outputs[p.path]}`),
  ].join('\n');

  return outputs;
}

function main([docsDir, siteDir] = process.argv.slice(2)) {
  if (!docsDir || !siteDir) {
    console.error('Usage: node tools/llms-docs.mjs <docs dir> <built site dir>');
    process.exit(2);
  }
  const config = parseConfig(fs.readFileSync(path.join(docsDir, '_config.yml'), 'utf8'));
  const outputs = buildOutputs(config, collectPages(docsDir, config.exclude));
  for (const [rel, contents] of Object.entries(outputs)) {
    const target = path.join(siteDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  console.log(`Wrote llms.txt, llms-full.txt and ${Object.keys(outputs).length - 2} Markdown pages to ${siteDir}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(`llms-docs: ${err.message}`);
    process.exit(1);
  }
}
