/**
 * push-published-settings.mjs — push per-domain visibility from published.json.
 *
 * Writes only the fields in PUBLISHED_SETTINGS (published-settings.mjs),
 * `hidden` and `strict_enforce_group_visibility`, for every course and path
 * published.json under COURSE_CONTENT_PATH and PATH_CONTENT_PATH. The domains
 * are the ones the files name, so no domain configuration is needed; reading
 * costs one published-course and one published-path list per domain.
 */
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { repoRoot } from '#lib/paths.mjs';
import { createSkilljarClient, failCleanly } from '#lib/skilljar/client.mjs';
import { fetchPublishedCourses, fetchPublishedPaths } from '#lib/skilljar/fetch.mjs';
import { readDirFiles } from '#lib/content/read-dirs.mjs';
import { planSettings, verifySettings } from '#lib/push/settings.mjs';
import {
  PUBLISHED_SETTINGS,
  publishedTargets,
  publishedKey,
  withoutDerived,
  registrationWarnings
} from '#lib/push/published-settings.mjs';
import { guardBranch, runSettingsPush } from '#lib/push/settings-run.mjs';

dotenv.config();

const argv = yargs(hideBin(process.argv))
  .option('dry-run', { type: 'boolean', default: false, description: 'Show each publish record\'s before and after; write nothing' })
  .option('force', { type: 'boolean', default: false, description: 'Write without asking' })
  .option('domain', { type: 'array', string: true, default: [], description: 'Only this domain (repeatable)' })
  .option('allow-branch', { type: 'array', string: true, default: [], description: 'Also allow pushing from this content branch' })
  .strict()
  .argv;

const coursesDir = process.env.COURSE_CONTENT_PATH || path.join(repoRoot, 'local-skilljar');
const pathsDir = process.env.PATH_CONTENT_PATH || path.join(repoRoot, 'local-skilljar-paths');

(async () => {
  if (!guardBranch({ argv, command: 'push:published-settings', dir: coursesDir })) return;
  if (pathsDir !== coursesDir && !guardBranch({ argv, command: 'push:published-settings', dir: pathsDir })) return;

  const toLocals = (entries) => entries.map(({ dir, data }) => ({ dir, published: data }));
  const courseLocals = toLocals(await readDirFiles(coursesDir, 'published.json'));
  const pathLocals = toLocals(await readDirFiles(pathsDir, 'published.json'));
  const itemsByDir = new Map((await readDirFiles(pathsDir, 'path-items.json')).map(({ dir, data }) => [dir, data]));
  for (const local of pathLocals) {
    local.courseIds = (itemsByDir.get(local.dir) ?? []).map(item => item.course?.id).filter(Boolean);
  }

  const named = new Set([...courseLocals, ...pathLocals].flatMap(l => Object.keys(l.published?.domains ?? {})));
  const domains = argv.domain.length ? argv.domain.filter(d => named.has(d)) : [...named];

  const client = createSkilljarClient();
  async function readAll() {
    const records = new Map();
    for (const domain of domains) {
      for (const pc of await fetchPublishedCourses(client, domain)) records.set(publishedKey(domain, pc.id), pc);
      if (pathLocals.length) {
        for (const pp of await fetchPublishedPaths(client, domain)) records.set(publishedKey(domain, pp.id), pp);
      }
    }
    return records;
  }

  const before = await readAll();
  const targets = [
    ...publishedTargets({ kind: 'course', locals: courseLocals, upstream: before, domains }),
    ...publishedTargets({ kind: 'path', locals: pathLocals, upstream: before, domains })
  ];
  const plan = planSettings({
    targets,
    fields: PUBLISHED_SETTINGS,
    missing: (t) => `${t.label} is not published there any more — run pull:slugs or pull:paths`
  });
  plan.warnings.push(...registrationWarnings({ changes: plan.changes, courseLocals, pathLocals, upstream: before }));
  const strip = (records) => new Map([...records].map(([k, r]) => [k, withoutDerived(r)]));

  await runSettingsPush({
    argv,
    noun: 'publish record',
    compared: targets.length,
    plan,
    write: (endpoint, body) => client.patch(endpoint, body),
    verify: async () => verifySettings({
      changes: plan.changes,
      fields: PUBLISHED_SETTINGS,
      before: strip(before),
      after: strip(await readAll()),
      alwaysChanges: ['modified_at']
    })
  });
})().catch(err => failCleanly(err, 'Push of published settings failed.'));
