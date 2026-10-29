/**
 * push-paths.mjs — push learning-path details from each path's details.json.
 *
 * Writes only the fields in PATH_SETTINGS (path-settings.mjs): the title,
 * both descriptions, the header, and what the path calls its items. One
 * `GET /paths` reads them all, so a dry run is one request. A real run asks
 * once, PATCHes each changed path with only its changed fields, then reads
 * the paths again and fails on any mismatch.
 */
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { repoRoot } from '#lib/paths.mjs';
import { createSkilljarClient, failCleanly } from '#lib/skilljar/client.mjs';
import { fetchPaths } from '#lib/skilljar/fetch.mjs';
import { readDirFiles, filterByDirOrId } from '#lib/content/read-dirs.mjs';
import { planSettings, verifySettings } from '#lib/push/settings.mjs';
import { PATH_SETTINGS, pathTargets } from '#lib/push/path-settings.mjs';
import { guardBranch, runSettingsPush } from '#lib/push/settings-run.mjs';
import { fail } from '#lib/ui.mjs';

dotenv.config();

const argv = yargs(hideBin(process.argv))
  .option('dry-run', { type: 'boolean', default: false, description: 'Show each path\'s before and after; write nothing' })
  .option('force', { type: 'boolean', default: false, description: 'Write without asking' })
  .option('path', { type: 'array', string: true, default: [], description: 'Only this path directory name or path id (repeatable)' })
  .option('allow-branch', { type: 'array', string: true, default: [], description: 'Also allow pushing from this content branch' })
  .strict()
  .argv;

const contentPath = process.env.PATH_CONTENT_PATH || path.join(repoRoot, 'local-skilljar-paths');

(async () => {
  if (!guardBranch({ argv, command: 'push:paths', dir: contentPath })) return;

  const all = (await readDirFiles(contentPath, 'details.json')).map(({ dir, data }) => ({ dir, details: data }));
  const { kept: locals, unmatched } = filterByDirOrId(all, argv.path, e => e.details.id);
  if (unmatched.length) {
    console.error(fail(`No local path matches: ${unmatched.join(', ')}`));
    process.exitCode = 1;
    return;
  }

  const client = createSkilljarClient();
  const before = new Map((await fetchPaths(client)).map(p => [p.id, p]));
  const plan = planSettings({ targets: pathTargets(locals, before), fields: PATH_SETTINGS });

  await runSettingsPush({
    argv,
    noun: 'path',
    compared: locals.length,
    plan,
    write: (endpoint, body) => client.patch(endpoint, body),
    verify: async () => verifySettings({
      changes: plan.changes,
      fields: PATH_SETTINGS,
      before,
      after: new Map((await fetchPaths(client)).map(p => [p.id, p]))
    })
  });
})().catch(err => failCleanly(err, 'Push of path details failed.'));
