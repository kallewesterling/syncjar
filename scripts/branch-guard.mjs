/**
 * branch-guard.mjs — refuse to push to Skilljar from an unapproved git branch.
 *
 * Skilljar has no concept of git branches; it just holds one live state. If
 * a feature branch's `courses/` content is stale relative to Skilljar (e.g.
 * because a fix landed on dev/main after that branch was created), pushing
 * from that stale branch silently overwrites the live fix with old content.
 * Git itself can't catch this — the danger is entirely in which branch
 * happens to be checked out locally when `push` runs.
 *
 * So `push` refuses to run against anything other than dev or main unless
 * explicitly told otherwise with --allow-branch. This only guards an actual
 * push: --dry-run and --diff-only never write to Skilljar, so they're
 * unaffected regardless of branch.
 */
import { execFileSync } from 'child_process';

export const DEFAULT_ALLOWED_BRANCHES = ['dev', 'main'];

/**
 * Returns the git branch currently checked out at `dir`, or null if it
 * can't be determined (not a git repo, detached HEAD, etc.) — treated as
 * "not allowed" by isBranchAllowed rather than assumed safe.
 */
export function getCurrentBranch(dir) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

export function isBranchAllowed(branch, allowedBranches = DEFAULT_ALLOWED_BRANCHES) {
  return branch !== null && allowedBranches.includes(branch);
}
