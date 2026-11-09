/**
 * since.mjs — the point `check:drift` reads the audit log from.
 *
 * A dashboard edit is only drift if the local tree has not seen it, so the
 * natural starting point is the last pull: the newest commit in the content
 * repo whose subject says it synced or pulled from Skilljar. Not simply the
 * newest commit touching the tree, because a local edit committed after a
 * dashboard edit would move the starting point past that edit and hide it,
 * which is exactly the edit a push would then overwrite.
 *
 * Git is only read: `git log` and nothing else.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Subjects seen on pulls in chainguard-dev/courses, e.g.
// "chore(content): sync Skilljar → courses/", "Sync Skilljar content (#312)",
// "sync: first pull with quiz support", "content: pull the 13 course descriptions".
// The nightly bot also authors link-fix commits, so the author says nothing.
export const SYNC_SUBJECTS = [
  /^(?:[\w-]+(?:\([^)]*\))?!?:\s*)?(?:sync|pull)\b/i,
  /\bsync(?:ed)?\s+(?:from\s+)?skilljar\b/i
];

export function isSyncCommit(subject, patterns = SYNC_SUBJECTS) {
  return patterns.some((re) => re.test(subject ?? ''));
}

/**
 * Turns a `--since` value that looks like a date into an ISO timestamp with
 * a timezone, which the audit log requires (a bare datetime is a 422).
 * A date alone means midnight UTC; a datetime without an offset is UTC too,
 * rather than whatever the machine's zone happens to be.
 *
 * Returns null for anything that does not start like a date, so the caller
 * can try it as a git ref. Throws for a date-like value that is not a date.
 */
export function parseSinceDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const withZone = /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text
    : text.length === 10 ? `${text}T00:00:00Z`
      : `${text}Z`;
  const ms = Date.parse(withZone);
  if (Number.isNaN(ms)) throw new Error(`"${value}" is not a valid date.`);
  return new Date(ms).toISOString();
}

/**
 * Parses `git log --format=%H%x1f%cI%x1f%s` output, one commit per line.
 */
export function parseGitLog(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...rest] = line.split('\x1f');
      return { sha, date: new Date(date).toISOString(), subject: rest.join('\x1f') };
    });
}

/**
 * From commits newest first, the newest sync commit, the newest commit of
 * any kind, and how many commits landed after the sync. Those later commits
 * are local edits: they did not bring anything down from Skilljar.
 */
export function pickSyncCommit(commits, patterns = SYNC_SUBJECTS) {
  const index = commits.findIndex((c) => isSyncCommit(c.subject, patterns));
  return {
    sync: index === -1 ? null : commits[index],
    latest: commits[0] ?? null,
    localAfterSync: index === -1 ? commits.length : index
  };
}

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * Works out the since point.
 *
 *   since        the --since value, if any: a date, or a git ref in the
 *                content repo, whose commit date is used
 *   contentPath  COURSE_CONTENT_PATH; its git repo is the one read
 *
 * Returns { since, source, commit?, latest?, localAfterSync? }, where source
 * is 'date', 'ref' or 'last-sync'. Throws with a message fit to print.
 */
export async function resolveSince({ since, contentPath, git = runGit, maxCommits = 1000 }) {
  if (since) {
    const date = parseSinceDate(since);
    if (date) return { since: date, source: 'date' };
    let out;
    try {
      out = await git(['log', '-1', '--format=%H%x1f%cI%x1f%s', String(since), '--'], contentPath);
    } catch {
      throw new Error(`--since "${since}" is neither a date (YYYY-MM-DD) nor a commit in the content repo at ${contentPath}.`);
    }
    const [commit] = parseGitLog(out);
    if (!commit) throw new Error(`--since "${since}" did not resolve to a commit in ${contentPath}.`);
    return { since: commit.date, source: 'ref', commit };
  }

  let out;
  try {
    out = await git(['log', `-${maxCommits}`, '--format=%H%x1f%cI%x1f%s', 'HEAD', '--', '.'], contentPath);
  } catch {
    throw new Error(`${contentPath} is not in a git repository, so there is no last pull to start from. Pass --since <date>.`);
  }
  const picked = pickSyncCommit(parseGitLog(out));
  if (!picked.sync) {
    throw new Error(`No pull commit found in the last ${maxCommits} commits touching ${contentPath}. Pass --since <date or ref>.`);
  }
  return { since: picked.sync.date, source: 'last-sync', commit: picked.sync, latest: picked.latest, localAfterSync: picked.localAfterSync };
}
