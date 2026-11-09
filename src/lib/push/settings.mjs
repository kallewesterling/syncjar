/**
 * settings.mjs — the planning and checking shared by the settings pushes.
 *
 * `push:course-settings`, `push:paths`, `push:lesson-settings` and
 * `push:published-settings` all do the same thing to a different object:
 * compare an allowlist of fields in a local file with the upstream record,
 * PATCH only the fields that differ, then read the records back and fail if
 * a value did not land or any other field moved. Each command supplies the
 * targets and the field rules; this module supplies the rest, so the rules
 * for "what counts as a change" and "what counts as a clean write" are the
 * same everywhere.
 *
 * Every field any command lists was set, read back and restored on throwaway
 * staging objects on 2026-10-28. See CLAUDE.md, "Settings writes".
 */
import { normalizeHtml } from '#lib/push/plan.mjs';

// Skilljar trims strings on write, so " x" reads back as "x".
const trimmed = (v) => (typeof v === 'string' ? v.trim() : v);

export const boolean = {
  validate: (value) => (typeof value === 'boolean' ? null : 'not true or false'),
  equal: (a, b) => a === b
};

/** A plain string. `required` refuses blank, for fields the API will not clear. */
export function text({ required = false } = {}) {
  return {
    validate(value) {
      if (typeof value !== 'string') return 'not a string';
      if (required && value.trim() === '') return 'blank, and Skilljar does not allow it';
      return null;
    },
    equal: (a, b) => trimmed(a ?? '') === trimmed(b ?? '')
  };
}

/**
 * HTML, compared the way `push` compares content: Skilljar and the pull
 * wrap and indent markup differently without anyone editing it.
 */
export const html = {
  validate: (value) => (typeof value === 'string' ? null : 'not a string'),
  equal: (a, b) => normalizeHtml(a ?? '') === normalizeHtml(b ?? '')
};

/**
 * Compares local values with upstream records.
 *
 *   targets  [{ id, label, endpoint, local, upstream, where }] — `local`
 *            holds the values from the file, `upstream` the record from
 *            Skilljar, or undefined when Skilljar has no such object. `where`
 *            names the file in warnings, and defaults to `label`
 *   fields   { name: { validate(value, context), equal(a, b) } }
 *   context  passed to every validate()
 *   missing  the warning for a target with no upstream record
 *
 * Returns `{ changes, inSync, warnings }`. Each change is
 * `{ id, label, endpoint, field, from, to }`. A local record without the
 * field is not a change: it has no opinion, and an older pull would not have
 * written it.
 */
export function planSettings({ targets, fields, context = {}, missing = (t) => `${t.label} is not in Skilljar — pull to reconcile` }) {
  const changes = [];
  const warnings = [];
  let inSync = 0;

  for (const target of targets) {
    if (!target.upstream) {
      warnings.push(missing(target));
      continue;
    }
    for (const [field, spec] of Object.entries(fields)) {
      if (!(field in target.local)) continue;
      const to = target.local[field];
      if (spec.equal(target.upstream[field], to)) {
        inSync += 1;
        continue;
      }
      const problem = spec.validate(to, context);
      if (problem) {
        warnings.push(`${target.where ?? target.label}: ${field} is ${JSON.stringify(to)}, ${problem} — not pushing it`);
        continue;
      }
      changes.push({
        id: target.id,
        label: target.label,
        endpoint: target.endpoint,
        field,
        from: target.upstream[field],
        to
      });
    }
  }

  return { changes, inSync, warnings };
}

/**
 * Groups changes into one PATCH body per target, in first-seen order.
 * Returns `[{ id, label, endpoint, body }]`.
 */
export function patchBodies(changes) {
  const byTarget = new Map();
  for (const c of changes) {
    if (!byTarget.has(c.id)) byTarget.set(c.id, { id: c.id, label: c.label, endpoint: c.endpoint, body: {} });
    byTarget.get(c.id).body[c.field] = c.to;
  }
  return [...byTarget.values()];
}

/**
 * Checks records read after the writes against records read before them. A
 * 200 is not taken as proof: Skilljar has accepted writes before and changed
 * nothing (see CLAUDE.md, "Quiz writes").
 *
 *   before, after   Map id -> record
 *   alwaysChanges   fields Skilljar sets on every write, such as modified_at
 *   derived         { field: [sources] } — read-only fields Skilljar
 *                   recomputes when one of the sources is written
 *   gone            the problem for a written record missing afterwards
 *
 * Returns a list of problems; empty means every intended value landed and no
 * other field on any written record moved.
 */
export function verifySettings({
  changes, fields, before, after, alwaysChanges = [], derived = {},
  gone = (label) => `${label}: missing from Skilljar after the write`
}) {
  const problems = [];
  const always = new Set(alwaysChanges);

  for (const { id, label, body } of patchBodies(changes)) {
    const was = before.get(id);
    const now = after.get(id);
    if (!now) {
      problems.push(gone(label));
      continue;
    }

    for (const [field, value] of Object.entries(body)) {
      if (!fields[field].equal(now[field], value)) {
        problems.push(`${label}: ${field} is ${JSON.stringify(now[field])} upstream, expected ${JSON.stringify(value)}`);
      }
    }

    const keys = new Set([...Object.keys(was ?? {}), ...Object.keys(now)]);
    for (const key of keys) {
      if (key in body || always.has(key)) continue;
      if (derived[key]?.some(source => source in body)) continue;
      if (JSON.stringify(was?.[key]) !== JSON.stringify(now[key])) {
        problems.push(`${label}: ${key} changed unexpectedly (${JSON.stringify(was?.[key])} → ${JSON.stringify(now[key])})`);
      }
    }
  }

  return problems;
}
