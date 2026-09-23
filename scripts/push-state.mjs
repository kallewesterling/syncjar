/**
 * push-state.mjs — remember what was already in sync, so push can skip it.
 *
 * Batching and parallelism got a full push from ten minutes to about 77
 * seconds, but the shape of the work was still wrong: every run re-read all
 * 66 courses, 649 lessons and 822 content items to discover that two of them
 * had changed. The cheapest request is the one you don't make.
 *
 * A course is skipped when both are true:
 *
 *   1. its local content hashes to what it hashed to at the last push, and
 *   2. the course's upstream `modified_at` is what it was then.
 *
 * (2) costs nothing: `push` already fetches the whole catalogue in one request
 * for course titles, and `modified_at` comes along in the same response.
 *
 * WHY THIS IS SAFE EVEN IF `modified_at` LIES
 *
 * The obvious worry is (2). If Skilljar does not bump a course's
 * `modified_at` when someone edits a content item in its web UI, a skip could
 * miss that edit. That question turns out to be unanswerable from the
 * evidence available: across every nightly-sync commit in the content repo,
 * no pre-existing course has ever had its normalised content change upstream,
 * so the case has simply never occurred. Lessons and content items carry no
 * timestamps of their own, so there is nothing finer to check.
 *
 * It does not matter, because **skipping never writes**. A skipped course
 * produces no actions, so nothing of its upstream copy can be overwritten.
 * The failure mode of a wrong skip is that `push` does not *report* drift it
 * would otherwise have shown — and that reporting is better done by `pull`,
 * which is what actually reconciles upstream edits into the tree. Once a pull
 * brings such an edit down, the local content hash changes and the course is
 * scanned again.
 *
 * Compare that with the pre-skip behaviour, which on finding drift offered to
 * overwrite the newer upstream copy with the older local one. Skipping is the
 * more conservative of the two in the direction that loses work.
 *
 * So (2) is not load-bearing. It is kept because it is free and, if
 * `modified_at` does track content edits, it buys extra drift reporting.
 */
import crypto from 'crypto';
import fs from 'fs-extra';
import { normalizeHtml } from './push-plan.mjs';

// Bump when the fingerprint's inputs change, so stale entries computed under
// the old rules are ignored rather than trusted.
export const STATE_VERSION = 2;

export const DEFAULT_STATE_FILE = '.syncjar-push-state.json';

/**
 * Hashes everything about a course that `push` is capable of writing: the
 * course title, each lesson's title, and each content item's body. Anything
 * else in the tree — ordering, descriptions, the directory name — is not
 * pushed, so a change to it must not force a rescan.
 *
 * Bodies are hashed *normalised*. The comparison in push-plan.mjs treats
 * markup that differs only in incidental whitespace as unchanged, and the
 * fingerprint has to agree with it or the two disagree about what "changed"
 * means. This is not hypothetical: the content repo's own history shows the
 * pull rewriting trailing newlines on files nobody edited, which under a raw
 * hash would rescan those courses forever.
 */
export function fingerprintCourse({ courseDetails, lessons, localHtmlByItemId }) {
  // Sort so the fingerprint depends on content rather than on the order the
  // tree happened to be read in.
  const byId = (a, b) => String(a.id).localeCompare(String(b.id));

  const canonical = {
    title: courseDetails.title ?? '',
    lessons: [...lessons].sort(byId).map(lesson => ({
      id: lesson.id,
      title: lesson.title ?? '',
      items: [...(lesson.content_items ?? [])].sort(byId).map(item => {
        const body = localHtmlByItemId.get(item.id);
        return {
          id: item.id,
          // A missing file is its own state: `null` must not hash the same as
          // a file that exists and is empty, or a deletion goes unnoticed.
          body: body === undefined ? null : normalizeHtml(body)
        };
      })
    }))
  };

  // JSON rather than a delimiter-joined string: it quotes and escapes every
  // field, so no title containing the delimiter can shift a value across a
  // field boundary and collide with a different course.
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export async function readState(file) {
  try {
    const state = await fs.readJson(file);
    if (state?.version !== STATE_VERSION) return { version: STATE_VERSION, courses: {} };
    return { version: STATE_VERSION, courses: state.courses ?? {} };
  } catch {
    // No state file, or an unreadable one. Both mean "scan everything", which
    // is the safe direction: the cost is a slow run, not a wrong one.
    return { version: STATE_VERSION, courses: {} };
  }
}

export async function writeState(file, state) {
  await fs.outputJson(file, { ...state, version: STATE_VERSION }, { spaces: 2 });
}

/**
 * Whether a course can be skipped entirely, making no requests for it.
 *
 * Every unknown answers "no". An absent entry, a fingerprint that does not
 * match, an upstream timestamp that has moved, or a course whose upstream
 * record we could not find all fall through to a full scan.
 */
export function shouldSkip(entry, { fingerprint, upstreamModifiedAt }) {
  if (!entry) return false;
  if (entry.fingerprint !== fingerprint) return false;
  // A course with no upstream timestamp at all cannot be confirmed unchanged.
  if (!upstreamModifiedAt || !entry.upstreamModifiedAt) return false;
  return entry.upstreamModifiedAt === upstreamModifiedAt;
}

/**
 * Records a course as verified in sync, as of this moment.
 *
 * Only ever called for a course that finished the run with nothing
 * outstanding. A course whose prompts were partly declined is still out of
 * sync, and recording it would skip the remaining changes on the next run —
 * which is the one way this cache could actually lose an edit.
 */
export function recordCourse(state, courseId, { dir, fingerprint, upstreamModifiedAt }) {
  state.courses[courseId] = {
    dir,
    fingerprint,
    upstreamModifiedAt,
    verifiedAt: new Date().toISOString()
  };
  return state;
}
