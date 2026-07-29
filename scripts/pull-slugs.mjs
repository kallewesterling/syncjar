/**
 * pull-slugs.mjs — pull authoritative, per-domain URL slugs from Skilljar.
 *
 * Skilljar's /v1/courses object has no slug. The slug lives on a PublishedCourse,
 * one per domain (GET /v1/domains/{domain}/published-courses). Slugs are unique
 * per domain and mutable, so we key everything by the stable course id and store
 * the slug(s) as metadata. This replaces the og:title scraping in
 * courses/tools/course-recommendations/resolve-course-slugs.py.
 *
 * Output: one file per course dir at  <COURSE_CONTENT_PATH>/<dir>/published.json
 * matching the published.schema.json shape, joined to the local course by id.
 *
 * Env (.env):
 *   SKILLJAR_API_KEY      required (used by skilljar-client.mjs)
 *   COURSE_CONTENT_PATH   required, e.g. ../courses/courses
 *   SKILLJAR_DOMAINS      optional, comma-separated; overridden by --domain
 *
 * Usage:
 *   node scripts/pull-slugs.mjs
 *   node scripts/pull-slugs.mjs --domain courses.chainguard.dev --domain chainguard-test.skilljar.com
 *   node scripts/pull-slugs.mjs --dry-run
 *   node scripts/pull-slugs.mjs --check        # CI: exit non-zero if any published.json is stale/missing
 */
import fs from 'fs-extra';
import path from 'path';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { createSkilljarClient } from './skilljar-client.mjs';

dotenv.config();

const DEFAULT_DOMAINS = ['courses.chainguard.dev', 'chainguard-test.skilljar.com'];

const argv = yargs(hideBin(process.argv))
  .option('domain', { type: 'array', description: 'Skilljar domain host (repeatable). Overrides SKILLJAR_DOMAINS.' })
  .option('dry-run', { type: 'boolean', default: false, description: 'Print what would be written; write nothing.' })
  .option('check', { type: 'boolean', default: false, description: 'Verify existing published.json files match the API; exit non-zero on drift.' })
  .argv;

const client = createSkilljarClient();

const domains = (argv.domain && argv.domain.length ? argv.domain
  : (process.env.SKILLJAR_DOMAINS ? process.env.SKILLJAR_DOMAINS.split(',').map(s => s.trim()) : DEFAULT_DOMAINS));

const contentPath = process.env.COURSE_CONTENT_PATH;
if (!contentPath) { console.error('COURSE_CONTENT_PATH is not set'); process.exit(1); }

// GET /v1/domains/{domain}/published-courses (paginated)
async function fetchPublished(domain) {
  const out = [];
  let page = 1;
  while (true) {
    const { data } = await client.get(`/domains/${domain}/published-courses`, {
      params: { page, page_size: 100 }
    });
    out.push(...(data.results || []));
    if (!data.next) break;
    page += 1;
  }
  return out; // each: { id, slug, live, hidden, course: { id, title } }
}

// Map local course id -> directory name, by reading each details.json.
async function localCourseDirs() {
  const byId = {};
  for (const dir of await fs.readdir(contentPath)) {
    const detailsPath = path.join(contentPath, dir, 'details.json');
    if (!(await fs.pathExists(detailsPath))) continue;
    const details = await fs.readJson(detailsPath);
    if (details.id) byId[details.id] = dir;
  }
  return byId;
}

(async () => {
  const byId = await localCourseDirs();
  console.log(chalk.gray(`Local courses: ${Object.keys(byId).length}. Domains: ${domains.join(', ')}`));

  // Collect: courseId -> { domain -> { slug, published_course_id, live, hidden } }
  const collected = {};
  const titles = {};
  for (const domain of domains) {
    const published = await fetchPublished(domain);
    console.log(chalk.gray(`  ${domain}: ${published.length} published course(s)`));
    for (const pc of published) {
      const cid = pc.course?.id;
      if (!cid) continue;
      titles[cid] = pc.course?.title || titles[cid];
      (collected[cid] ??= {})[domain] = {
        slug: pc.slug,
        published_course_id: pc.id,
        hidden: pc.hidden ?? false
      };
    }
  }

  let written = 0, unchanged = 0, drift = 0;
  const missingLocal = [];   // published in Skilljar but no local course dir
  const unpublished = [];    // local course dir with no published entry

  for (const [cid, domainMap] of Object.entries(collected)) {
    const dir = byId[cid];
    if (!dir) { missingLocal.push(`${cid} (${titles[cid] || '?'})`); continue; }

    const payload = {
      course_id: cid,
      generated_at: new Date().toISOString(),
      domains: domainMap
    };
    const target = path.join(contentPath, dir, 'published.json');

    if (argv.check) {
      const prev = (await fs.pathExists(target)) ? await fs.readJson(target) : null;
      // Compare ignoring generated_at.
      const norm = o => o ? JSON.stringify({ course_id: o.course_id, domains: o.domains }) : null;
      if (norm(prev) !== norm(payload)) { drift++; console.log(chalk.red(`DRIFT ${dir}`)); }
      continue;
    }

    const prev = (await fs.pathExists(target)) ? await fs.readJson(target) : null;
    const same = prev && JSON.stringify(prev.domains) === JSON.stringify(payload.domains);
    if (same) { unchanged++; continue; }

    if (argv['dry-run']) console.log(chalk.yellow(`would write ${dir}/published.json`));
    else { await fs.writeJson(target, payload, { spaces: 2 }); written++; }
  }

  for (const cid of Object.keys(byId)) if (!collected[cid]) unpublished.push(byId[cid]);

  console.log();
  if (argv.check) {
    console.log(`${drift} file(s) stale/missing.`);
    process.exit(drift ? 1 : 0);
  }
  console.log(chalk.green(`Wrote ${written}, unchanged ${unchanged}.`));
  if (missingLocal.length) console.log(chalk.yellow(`Published but no local dir (${missingLocal.length}): ${missingLocal.join(', ')}`));
  if (unpublished.length) console.log(chalk.gray(`Local but not published on any domain (${unpublished.length}): ${unpublished.join(', ')}`));
})();
