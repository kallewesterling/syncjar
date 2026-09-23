import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import {
  DEFAULT_ALLOWED_BRANCHES,
  getCurrentBranch,
  isBranchAllowed
} from '../scripts/branch-guard.mjs';

// Builds a throwaway git repo with one commit, checked out on `branch`.
// Committer identity is set locally so the test doesn't depend on, or touch,
// the machine's git config.
async function makeRepo(branch) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncjar-branch-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

  git('init', '--quiet', '--initial-branch', branch);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(root, 'README.md'), 'content');
  git('add', '.');
  git('commit', '--quiet', '-m', 'initial');

  return { root, git };
}

test('getCurrentBranch reports the checked-out branch', async () => {
  const { root } = await makeRepo('dev');
  assert.equal(getCurrentBranch(root), 'dev');
});

test('getCurrentBranch returns null outside a git repo', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncjar-branch-test-'));
  assert.equal(getCurrentBranch(root), null);
});

// A detached HEAD has no branch name to check against the allowlist, so it
// has to read as "unknown", not as the literal branch called HEAD.
test('getCurrentBranch returns null on a detached HEAD', async () => {
  const { root, git } = await makeRepo('dev');
  git('checkout', '--quiet', '--detach', 'HEAD');
  assert.equal(getCurrentBranch(root), null);
});

test('isBranchAllowed accepts the default branches', () => {
  for (const branch of DEFAULT_ALLOWED_BRANCHES) {
    assert.equal(isBranchAllowed(branch), true);
  }
});

test('isBranchAllowed rejects a feature branch', () => {
  assert.equal(isBranchAllowed('feat/new-lesson'), false);
});

// An unknown branch is the case the guard exists for: nothing established
// that the content is current, so it must not be assumed safe.
test('isBranchAllowed rejects an undeterminable branch', () => {
  assert.equal(isBranchAllowed(null), false);
});

test('isBranchAllowed accepts a branch named via --allow-branch', () => {
  const allowed = [...DEFAULT_ALLOWED_BRANCHES, 'feat/new-lesson'];
  assert.equal(isBranchAllowed('feat/new-lesson', allowed), true);
  assert.equal(isBranchAllowed('feat/other', allowed), false);
});

// --allow-branch names one branch; it is not a blanket bypass, so a null
// branch stays refused however the allowlist was extended.
test('--allow-branch does not unlock an undeterminable branch', () => {
  assert.equal(isBranchAllowed(null, [...DEFAULT_ALLOWED_BRANCHES, 'feat/x']), false);
});

test('branch matching is exact, not a prefix or substring match', () => {
  assert.equal(isBranchAllowed('main-backup'), false);
  assert.equal(isBranchAllowed('feature/main'), false);
  assert.equal(isBranchAllowed('Main'), false);
});
