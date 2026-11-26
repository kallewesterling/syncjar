import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildOutputs,
  collectPages,
  navOrder,
  parseConfig,
  parsePage,
  toPlainMarkdown,
} from '../tools/llms-docs.mjs';

const docsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const config = { title: 'Site', description: 'A site.', url: 'https://example.com', baseurl: '/docs' };
const page = (rel, data, body = `# ${data.title}\n`) => ({ path: rel, data: { description: 'About it.', ...data }, body });
const url = (target) => `https://example.com/docs/${target}`;

test('Liquid page links become absolute links to the Markdown copy', () => {
  const body = 'See [it]({{ site.baseurl }}{% link a/b.md %}#part).\n';
  assert.equal(toPlainMarkdown(body, url), 'See [it](https://example.com/docs/a/b.md#part).\n');
});

test('a link to a page that is not published fails the build', () => {
  const pages = [page('a.md', { title: 'A' }, 'See [b]({{ site.baseurl }}{% link b.md %}).\n')];
  assert.throws(() => buildOutputs(config, pages), /a\.md: Link to a page that isn't published: b\.md/);
});

test('Liquid that cannot be rewritten fails rather than reaching the output', () => {
  assert.throws(() => toPlainMarkdown('Version {{ site.version }}\n', url), /site\.version/);
});

test('kramdown attributes and the generated TOC are removed', () => {
  const body = '# Title\n{: .no_toc }\n\n1. TOC\n{:toc}\n\n[Go](x){: .btn .fs-5 }\n';
  assert.equal(toPlainMarkdown(body, url), '# Title\n\n[Go](x)\n');
});

test('a callout becomes a labelled blockquote', () => {
  const body = '{: .warning }\nIt emails\npeople.\n\nAfter.\n';
  assert.equal(toPlainMarkdown(body, url), '> **Warning:** It emails\n> people.\n\nAfter.\n');
});

test('code blocks are left alone', () => {
  const body = '```yaml\n{: .warning }\n1. TOC\n{:toc}\n```\n';
  assert.equal(toPlainMarkdown(body, url), body);
});

test('a file without front matter is not a page', () => {
  assert.equal(parsePage('# Just text\n'), null);
  assert.deepEqual(parsePage('---\ntitle: "A: b"\n---\nBody\n'), { data: { title: 'A: b' }, body: 'Body\n' });
});

test('the exclude list is read from the config', () => {
  const parsed = parseConfig('title: T\nfooter: >-\n  text\nexclude:\n  - plans/\n  - x.md\nother: 1\n');
  assert.deepEqual(parsed.exclude, ['plans/', 'x.md']);
  assert.equal(parsed.title, 'T');
  assert.equal(parsed.footer, undefined);
});

test('pages are in navigation order, children after their parent', () => {
  const pages = [
    page('z.md', { title: 'Z', nav_order: '3' }),
    page('p/b.md', { title: 'B', parent: 'P', nav_order: '2' }),
    page('p/index.md', { title: 'P', nav_order: '2' }),
    page('p/a.md', { title: 'A', parent: 'P', nav_order: '1' }),
    page('index.md', { title: 'Home', nav_order: '1' }),
  ];
  assert.deepEqual(navOrder(pages).map((p) => p.path), ['index.md', 'p/index.md', 'p/a.md', 'p/b.md', 'z.md']);
});

test('a page without a description fails the build', () => {
  const pages = [page('a.md', { title: 'A', description: '' })];
  assert.throws(() => buildOutputs(config, pages), /without a description: a\.md/);
});

test('llms.txt lists every page, and llms-full.txt holds every page', () => {
  const outputs = buildOutputs(config, [page('index.md', { title: 'Home', nav_order: '1' }), page('b.md', { title: 'B', nav_order: '2' })]);
  assert.match(outputs['llms.txt'], /^# Site\n\n> A site\.\n/);
  assert.match(outputs['llms.txt'], /^- \[Home\]\(https:\/\/example\.com\/docs\/index\.md\): About it\.$/m);
  assert.match(outputs['llms.txt'], /^- \[B\]\(https:\/\/example\.com\/docs\/b\.md\): About it\.$/m);
  assert.match(outputs['llms-full.txt'], /Source: https:\/\/example\.com\/docs\/b\.md\n\n# B\n/);
});

test('the real docs build, without excluded pages or leftover markup', () => {
  const siteConfig = parseConfig(fs.readFileSync(path.join(docsDir, '_config.yml'), 'utf8'));
  const outputs = buildOutputs(siteConfig, collectPages(docsDir, siteConfig.exclude));
  assert.ok(outputs['index.md']);
  assert.ok(!Object.keys(outputs).some((rel) => rel.startsWith('plans/')), 'docs/plans/ is not published');
  assert.doesNotMatch(outputs['llms-full.txt'], /\{\{|\{%|\{:/);
});
