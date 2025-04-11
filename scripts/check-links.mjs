import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const coursesPath = path.join(__dirname, '..', 'public', 'courses');
const outputReport = path.join(__dirname, '..', 'public', 'data', 'link-report.json');

const isIgnorable = href =>
  href.startsWith('#') ||
  href.startsWith('mailto:') ||
  href.includes('localhost') ||
  href.includes('accounts.example.com') ||
  href.includes('foocorp-registry.com');

const allLinks = new Map();

const files = glob.sync(`${coursesPath}/**/*.html`);

console.log(`🔍 Scanning ${files.length} HTML files...`);

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

console.log(`🔗 Found ${allLinks.size} unique links. Checking...`);

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

console.log(`✅ Finished. Report saved to ${outputReport}`);
