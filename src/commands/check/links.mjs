import fs from 'fs-extra';
import path from 'path';
import { repoRoot } from '#lib/paths.mjs';
import { glob } from 'glob';
import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

const coursesPath = path.join(repoRoot, 'public', 'courses');
const outputReport = path.join(repoRoot, 'public', 'data', 'link-report.json');

// Matched on the parsed host, so `https://evil.test/?localhost` is still
// checked. Subdomains of an ignored host are ignored too.
const IGNORED_HOSTS = ['localhost', 'accounts.example.com', 'foocorp-registry.com'];

const hostOf = href => {
  try {
    return new URL(href).hostname;
  } catch {
    return '';
  }
};

const isIgnorable = href => {
  if (href.startsWith('#') || href.startsWith('mailto:')) return true;
  const host = hostOf(href);
  return IGNORED_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
};

const allLinks = new Map();

const files = glob.sync(`${coursesPath}/**/*.html`);

console.log(`Scanning ${files.length} HTML files...`);

for (const file of files) {
  const html = await fs.readFile(file, 'utf8');
  const dom = new JSDOM(html);
  const anchors = dom.window.document.querySelectorAll('a[href]');

  for (const a of anchors) {
    const href = a.href;

    if (isIgnorable(href)) continue;

    if (!allLinks.has(href)) {
      allLinks.set(href, []);
    }

    allLinks.get(href).push(file.replace(`${coursesPath}/`, ''));
  }
}

console.log(`Found ${allLinks.size} unique links. Checking...`);

const result = {};

for (const [link, sources] of allLinks.entries()) {
  try {
    const res = await fetch(link, { method: 'HEAD', timeout: 5000 });

    if (res.status !== 200) {
      result[link] = {
        status: res.status,
        sources
      };
    }
  } catch (err) {
    result[link] = {
      status: 'ERROR',
      error: err.message,
      sources
    };
  }
}

await fs.ensureDir(path.dirname(outputReport));
await fs.writeJson(outputReport, result, { spaces: 2 });

console.log(`✓ Finished. Report saved to ${outputReport}`);
