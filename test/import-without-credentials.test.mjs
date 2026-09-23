import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Imports `module` in a child process with no Skilljar credentials, which is
 * what CI looks like. Returns the child's stderr on failure, or null on
 * success.
 *
 * A child process is the only honest way to test this: the parent already
 * has the key loaded from .env, and unsetting it in-process would not undo
 * an import that has already happened.
 *
 * The child runs from a temp directory, because `dotenv.config()` reads
 * `<cwd>/.env` — running it from the repo would load the developer's own key
 * and the test would pass for the very reason it is meant to catch. Bare
 * specifiers still resolve, since ESM resolves those from the importing
 * file's location rather than from cwd.
 */
function importWithoutCredentials(relativeModule) {
  const env = { ...process.env };
  delete env.SKILLJAR_API_KEY;
  delete env.SKILLJAR_CLIENT_ID;
  delete env.SKILLJAR_CLIENT_SECRET;

  const url = pathToFileURL(path.join(root, relativeModule)).href;

  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
      cwd: os.tmpdir(),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return null;
  } catch (err) {
    return err.stderr?.toString() || err.message;
  }
}

// The whole suite passed locally and failed on the first CI run, because
// sync-users.mjs built its Skilljar client at import time and every
// developer machine has a .env. A module the tests import must not need
// credentials merely to be loaded — the credentials are for making requests,
// and no test makes one.
test('modules the tests import load without Skilljar credentials', () => {
  for (const mod of [
    './scripts/sync-users.mjs',
    './scripts/push-state.mjs',
    './scripts/push-plan.mjs',
    './scripts/push-args.mjs',
    './scripts/render-diff.mjs',
    './scripts/skilljar-fetch.mjs',
    './scripts/concurrency.mjs',
    './scripts/course-dirs.mjs',
    './scripts/lesson-dirs.mjs',
    './scripts/branch-guard.mjs',
    './scripts/ui.mjs'
  ]) {
    const failure = importWithoutCredentials(mod);
    assert.equal(failure, null, `importing ${mod} without credentials failed:\n${failure}`);
  }
});

// The client itself is allowed — required, even — to refuse without a key.
// This pins that the check above is not passing because the key requirement
// quietly went away.
test('createSkilljarClient still refuses to build without a key', () => {
  const failure = importWithoutCredentials('./test/fixtures/build-client.mjs');
  assert.ok(failure, 'expected createSkilljarClient() to throw without SKILLJAR_API_KEY');
  assert.match(failure, /SKILLJAR_API_KEY is not set/);
});
