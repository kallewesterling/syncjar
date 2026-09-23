/**
 * pull-paths.mjs — pull Skilljar learning paths to local files.
 *
 * The course side of this tool already mirrors three upstream objects per
 * course: the course itself (details.json), its lessons (lessons-meta.json)
 * and its per-domain publish records (published.json). Skilljar models a
 * learning path the same way, so this script mirrors the same three:
 *
 *   GET /paths                          -> <dir>/details.json      (verbatim)
 *   GET /paths/{id}/path-items          -> <dir>/path-items.json   (verbatim)
 *   GET /domains/{domain}/published-paths -> <dir>/published.json
 *
 * Two things about Skilljar's path model differ from its course model, and
 * both are load-bearing here:
 *
 * 1. A published path carries the whole path object nested under `path`,
 *    where a published course carries only `{ id, title }`. So a single
 *    published-paths call would be enough for a published path — but not for
 *    an unpublished one, which appears in /paths and on no domain at all.
 *    /paths is therefore the list this script iterates, and the published
 *    records only decorate it.
 *
 * 2. Whether a path id appears on more than one domain is an instance-level
 *    fact, not a Skilljar guarantee. On the instance this was built against,
 *    every path belonged to exactly one domain, and two *different* path ids
 *    shared a slug across domains. published.json is therefore keyed by
 *    domain exactly like the course one, which represents both arrangements
 *    without assuming either.
 *
 * `path-items` has no order field, and the API does not return items in
 * display order. path-items.json preserves API order and nothing more — do
 * not read it as a sequence.
 *
 * Env (.env):
 *   SKILLJAR_API_KEY    required (used by skilljar-client.mjs)
 *   PATH_CONTENT_PATH   where path directories live; defaults to
 *                       ./local-skilljar-paths in this repo
 *   SKILLJAR_DOMAINS    optional, comma-separated. Without it (or --domain)
 *                       the run still writes details.json/path-items.json and
 *                       skips published.json, since slugs are per-domain.
 *
 * Usage:
 *   node scripts/pull-paths.mjs
 *   node scripts/pull-paths.mjs --path "onboarding"
 *   node scripts/pull-paths.mjs --domain courses.example.com
 *   node scripts/pull-paths.mjs --dry-run
 *   node scripts/pull-paths.mjs --check     # CI: exit non-zero if any file is stale/missing
 */
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { createSkilljarClient, failCleanly } from './skilljar-client.mjs';
import { slugify, readCourseDirIndex, resolveCourseDirName } from './course-dirs.mjs';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Paths get their own content root rather than a subdirectory of the course
// one, so that a tree of course directories stays a tree of course
// directories — `readCourseDirIndex` identifies a directory by the `id` in its
// details.json, and a path id sitting in that tree would be indistinguishable
// from a course id.
export const defaultContentPath = path.join(__dirname, '..', 'local-skilljar-paths');

/**
 * Directory-name and title matching for --path.
 *
 * Mirrors the --course filter in sync-skilljar-to-local.mjs: the directory
 * name and the slugified title are both matched, because the two diverge as
 * soon as a title is reworded upstream (the directory keeps the old name, on
 * purpose — see course-dirs.mjs).
 */
export function matchesFilter(dirName, title, filter) {
  const needle = filter.toLowerCase();
  return dirName.toLowerCase().includes(needle)
    || slugify(title || '').toLowerCase().includes(needle);
}

/** The fields of a published path worth recording, per domain. */
export function publishedEntry(publishedPath) {
  return {
    slug: publishedPath.slug,
    published_path_id: publishedPath.id,
    hidden: publishedPath.hidden ?? false
  };
}

/**
 * True when what's on disk already says what we just fetched.
 *
 * `generated_at` is excluded deliberately: it changes on every run, so
 * including it would report drift on every run and rewrite every file.
 */
export function samePublished(prev, next) {
  if (!prev || !next) return false;
  const norm = o => JSON.stringify({ path_id: o.path_id, domains: o.domains });
  return norm(prev) === norm(next);
}

/**
 * Whether an on-disk published.json is genuinely left over — the path is
 * published on none of the domains the file itself records.
 *
 * The domains a run was asked about are the only ones it can speak for. A file
 * recording a domain outside that set says nothing about whether the path is
 * still live there, so scoping a run to one domain must not condemn the record
 * of another. Without this, `--check --domain one-of-two` would report drift
 * forever on a tree pulled from both.
 */
export function isOrphanedPublished(prev, configuredDomains) {
  const recorded = Object.keys(prev?.domains || {});
  if (recorded.length === 0) return true;
  const asked = new Set(configuredDomains);
  return recorded.every(domain => asked.has(domain));
}

/** Deep-equality for the verbatim files, on the same "content only" basis. */
export function sameJson(prev, next) {
  if (prev === null || prev === undefined) return false;
  return JSON.stringify(prev) === JSON.stringify(next);
}

const argv = yargs(hideBin(process.argv))
  .option('domain', { type: 'array', description: 'Skilljar domain host (repeatable). Overrides SKILLJAR_DOMAINS.' })
  .option('path', { type: 'string', description: 'Only pull paths matching this (partial match on directory name or title)' })
  .option('dry-run', { type: 'boolean', default: false, description: 'Print what would be written; write nothing.' })
  .option('check', { type: 'boolean', default: false, description: 'Verify existing files match the API; exit non-zero on drift.' })
  .argv;

// Paginated GET. Every list endpoint used here pages the same way.
async function fetchAll(client, url, params = {}) {
  const out = [];
  let page = 1;
  while (true) {
    const { data } = await client.get(url, { params: { ...params, page, page_size: 100 } });
    out.push(...(data.results || []));
    if (!data.next) break;
    page += 1;
  }
  return out;
}

async function main() {
  const client = createSkilljarClient();

  const contentPath = process.env.PATH_CONTENT_PATH || defaultContentPath;
  const domains = (argv.domain?.length ? argv.domain
    : (process.env.SKILLJAR_DOMAINS || '').split(',').map(s => s.trim())
  ).filter(Boolean);

  // failCleanly() exits, so nothing below a catch block runs.
  let paths;
  try {
    paths = await fetchAll(client, '/paths');
  } catch (err) {
    failCleanly(err, 'Could not list learning paths (GET /paths).');
  }
  console.log(chalk.gray(`Skilljar learning paths: ${paths.length}`));

  if (!domains.length) {
    console.log(chalk.yellow('No Skilljar domains configured — skipping published.json.'));
    console.log(chalk.gray('  Set SKILLJAR_DOMAINS in .env (comma-separated), or pass --domain,'));
    console.log(chalk.gray('  to record each path\'s per-domain slug.'));
  }

  // path id -> { domain -> { slug, published_path_id, hidden } }
  const published = {};
  for (const domain of domains) {
    let records;
    try {
      records = await fetchAll(client, `/domains/${domain}/published-paths`);
    } catch (err) {
      failCleanly(err, `Could not list published paths for ${domain}.`);
    }
    console.log(chalk.gray(`  ${domain}: ${records.length} published path(s)`));
    for (const record of records) {
      const id = record.path?.id;
      if (!id) continue;
      (published[id] ??= {})[domain] = publishedEntry(record);
    }
  }

  // Reuses the course index: it identifies a directory by the `id` in its
  // details.json and names a new one from its title, neither of which is
  // course-specific. Same guarantee, then — a retitled path keeps its
  // directory instead of growing a second one.
  //
  // No ensureDir: an absent content path reads as an empty index, and
  // fs.outputJson() creates what it needs. So --dry-run and --check leave no
  // directory behind on a first run.
  const index = await readCourseDirIndex(contentPath);
  for (const [id, dirs] of index.duplicates) {
    console.log(chalk.yellow(
      `! Path id ${id} is in ${dirs.length} directories: ${dirs.join(', ')}. ` +
      `Writing to "${index.byId.get(id)}" only — delete the others.`
    ));
  }

  let targets = paths.map(p => ({ path: p, dirName: resolveCourseDirName(index, p) }));

  if (argv.path) {
    const filtered = targets.filter(t => matchesFilter(t.dirName, t.path.title, argv.path));
    if (filtered.length === 0) {
      console.error(`No paths matched --path "${argv.path}"`);
      process.exit(1);
    }
    targets = filtered;
  }

  let written = 0, unchanged = 0, stale = 0;
  const unpublished = [];
  const orphanedPublished = [];

  for (const { path: p, dirName } of targets) {
    const dir = path.join(contentPath, dirName);

    let items;
    try {
      items = await fetchAll(client, `/paths/${p.id}/path-items`);
    } catch (err) {
      failCleanly(err, `Could not list items for path ${p.id} (${p.title || '?'}).`);
    }

    const domainMap = published[p.id];
    if (!domainMap && domains.length) unpublished.push(dirName);

    // [file name, what it should contain, how to compare it]
    const files = [
      ['details.json', p, sameJson],
      ['path-items.json', items, sameJson]
    ];
    if (domainMap) {
      files.push(['published.json', {
        path_id: p.id,
        generated_at: new Date().toISOString(),
        domains: domainMap
      }, samePublished]);
    } else if (domains.length) {
      // Nothing published on the domains this run asked about, but an earlier
      // run may have left a published.json saying otherwise. Report it rather
      // than deleting it: the file may be the only remaining record of the
      // slug a path used to live at, and it is cheap to remove by hand once
      // that has been checked.
      const target = path.join(dir, 'published.json');
      const prev = (await fs.pathExists(target)) ? await fs.readJson(target) : null;
      if (prev && isOrphanedPublished(prev, domains)) {
        orphanedPublished.push(dirName);
        if (argv.check) {
          stale++;
          console.log(chalk.red(`STALE ${dirName}/published.json — no longer published`));
        }
      }
    }

    for (const [name, payload, same] of files) {
      const target = path.join(dir, name);
      const prev = (await fs.pathExists(target)) ? await fs.readJson(target) : null;

      if (same(prev, payload)) { unchanged++; continue; }

      if (argv.check) {
        stale++;
        console.log(chalk.red(`DRIFT ${dirName}/${name}`));
      } else if (argv['dry-run']) {
        console.log(chalk.yellow(`would write ${dirName}/${name}`));
      } else {
        await fs.outputJson(target, payload, { spaces: 2 });
        written++;
      }
    }
  }

  console.log();
  if (argv.check) {
    console.log(`${stale} file(s) stale/missing.`);
    process.exit(stale ? 1 : 0);
  }
  console.log(chalk.green(`Wrote ${written}, unchanged ${unchanged}.`));
  // Every orphan is also unpublished, so list each directory once, under the
  // more specific of the two headings.
  const orphans = new Set(orphanedPublished);
  const quietlyUnpublished = unpublished.filter(dir => !orphans.has(dir));

  if (quietlyUnpublished.length) {
    console.log(chalk.gray(
      `Not published on any configured domain (${quietlyUnpublished.length}): ` +
      `${quietlyUnpublished.join(', ')}`
    ));
  }
  if (orphanedPublished.length) {
    console.log(chalk.yellow(
      `! Not published on any configured domain, but published.json is still on ` +
      `disk from an earlier run (${orphanedPublished.length}): ${orphanedPublished.join(', ')}`
    ));
  }
}

// Importable for tests without running the pull, and without needing an API
// key — createSkilljarClient() throws without one, so it is called in main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => failCleanly(err, 'pull-paths failed.'));
}
