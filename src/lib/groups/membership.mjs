/**
 * membership.mjs — adding existing students to a group, and removing them,
 * through the v2 API. The pure half: reading the list, batching it, and
 * reading the batch responses back. `membership-run.mjs` does the I/O.
 *
 * What v2 offers, and what it doesn't:
 *
 *   POST   /groups/{id}/relationships/students/   add, up to 100 per request
 *   DELETE /groups/{id}/relationships/students/   remove, up to 100 per request
 *
 * Both are idempotent and report per item, with 200 when every item
 * succeeded and 207 when some failed. There is **no v2 read of a group's
 * members**, so a run cannot know in advance who is already in the group.
 * An add finds out afterwards: a succeeded item's membership `created_at`
 * predates the request when the student was already a member. A remove
 * cannot tell, since v2 answers `deleted` either way.
 *
 * Students are identified by email and looked up with
 * `GET /students/?filter[email]=` (exact, case-insensitive). Nobody is
 * created: an email with no Skilljar account is reported and skipped.
 */

export const ACTIONS = {
  add: { method: 'post', verb: 'add', past: 'added' },
  remove: { method: 'delete', verb: 'remove', past: 'removed' }
};

// The spec's maxItems for both membership envelopes.
export const MEMBERSHIP_BATCH_SIZE = 100;

// Without a Date header, a membership created this long before its batch
// was sent was already there: wide enough to absorb clock skew between this
// machine and Skilljar's. A membership made in that window reads as newly
// added, which is the harmless direction.
export const ALREADY_MEMBER_MARGIN_MS = 5 * 60_000;

// With one: the header is whole seconds, so allow for that and a little
// network asymmetry.
const SERVER_DATE_SLACK_MS = 2_000;

/**
 * The time before which a membership's `created_at` means the student was
 * already a member. Skilljar returns the original `created_at` when a
 * student is added again. Measured against the response's `Date` header,
 * Skilljar's own clock, this catches a membership made seconds before the
 * run; without the header it falls back to the local clock and the wide
 * margin.
 */
export function alreadyMemberCutoff({ sentAt, receivedAt, serverDate }) {
  const server = Date.parse(serverDate ?? '');
  if (!Number.isFinite(server)) return sentAt - ALREADY_MEMBER_MARGIN_MS;
  return server - (receivedAt - sentAt) - SERVER_DATE_SLACK_MS;
}

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** Splits one CSV line, honouring double-quoted cells. */
function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

/**
 * Reads email addresses from a CSV with an `email` column (any case, any
 * position), or from a plain list with one address per line. Addresses are
 * lowercased, since Skilljar matches them case-insensitively, and repeats
 * are dropped.
 *
 * @returns {{ emails: string[], invalid: string[], repeated: number }}
 */
export function parseEmailList(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return { emails: [], invalid: [], repeated: 0 };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const column = header.indexOf('email');
  const values = column === -1
    ? lines.map((l) => splitCsvLine(l)[0])
    : lines.slice(1).map((l) => splitCsvLine(l)[column] ?? '');

  return normaliseEmails(values);
}

/** Lowercases, validates and dedupes a list of addresses. */
export function normaliseEmails(values) {
  const seen = new Set();
  const invalid = [];
  let repeated = 0;
  for (const raw of values) {
    const email = String(raw ?? '').trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL.test(email)) { invalid.push(raw); continue; }
    if (seen.has(email)) { repeated += 1; continue; }
    seen.add(email);
  }
  return { emails: [...seen], invalid, repeated };
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The JSON:API body both membership endpoints take. */
export function membershipBody(studentIds) {
  return { data: studentIds.map((id) => ({ type: 'students', id })) };
}

/**
 * Sorts lookups (`{ email, matches }`, where `matches` is what
 * `GET /students/?filter[email]=` returned) into students the run can act
 * on and emails it must skip.
 */
export function classifyLookups(lookups) {
  const found = [];
  const missing = [];
  const ambiguous = [];
  for (const { email, matches } of lookups) {
    if (!matches.length) missing.push(email);
    else if (matches.length > 1) ambiguous.push(email);
    else {
      const [student] = matches;
      found.push({
        email,
        id: student.id,
        name: [student.attributes?.first_name, student.attributes?.last_name].filter(Boolean).join(' '),
        inactive: Boolean(student.attributes?.is_inactive)
      });
    }
  }
  return { found, missing, ambiguous };
}

/** The pointer index in a failed item's `source`, e.g. `/data/3/id` → 3. */
function pointerIndex(item) {
  const match = item?.error?.source?.pointer?.match(/^\/data\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Turns one batch response into an audit row per student sent. Items are
 * matched to students by id where the response carries one and by position
 * otherwise. A student with no matching item is a failure: a 200 alone is
 * not evidence that a write happened.
 *
 * @param {'add'|'remove'} action
 * @param {{ email: string, id: string }[]} sent  in request order
 * @param {object} body  the BatchResultEnvelope or BatchDeleteResultEnvelope
 * @param {number} cutoff  from `alreadyMemberCutoff`
 */
export function readBatchResult(action, sent, body, cutoff) {
  const items = Array.isArray(body?.data) ? body.data : [];
  const byId = new Map();
  items.forEach((item, i) => {
    const key = item?.result?.attributes?.student_id ?? item?.id;
    if (key != null && !byId.has(key)) byId.set(key, item);
    const at = pointerIndex(item);
    if (at != null && sent[at] && !byId.has(sent[at].id)) byId.set(sent[at].id, item);
    if (items.length === sent.length && sent[i] && !byId.has(sent[i].id)) byId.set(sent[i].id, item);
  });

  return sent.map((student) => {
    const item = byId.get(student.id);
    const row = { email: student.email, student_id: student.id, before: '', after: '', result: '', is_manager: '', error: '' };
    if (!item) return { ...row, result: 'failed', error: 'no result for this student in the response' };

    if (item.status === 'failed') {
      const code = item.error?.code ?? 'unknown';
      return { ...row, result: 'failed', error: [code, item.error?.detail].filter(Boolean).join(': ') };
    }

    if (action === 'add' && item.status === 'succeeded') {
      const attrs = item.result?.attributes ?? {};
      const createdAt = Date.parse(attrs.created_at);
      const already = Number.isFinite(createdAt) && createdAt < cutoff;
      return {
        ...row,
        before: already ? 'member' : 'not_member',
        after: 'member',
        result: already ? 'already_member' : 'added',
        is_manager: attrs.is_manager === undefined ? '' : String(attrs.is_manager)
      };
    }

    if (action === 'remove' && item.status === 'deleted') {
      return { ...row, before: 'unknown', after: 'not_member', result: 'removed' };
    }

    return { ...row, result: 'failed', error: `unexpected item status: ${item.status}` };
  });
}

export const AUDIT_FIELDS = ['email', 'student_id', 'name', 'group_id', 'group_name', 'action', 'before', 'after', 'result', 'is_manager', 'error'];
