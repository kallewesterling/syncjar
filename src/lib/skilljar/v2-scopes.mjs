/**
 * v2-scopes.mjs — which OAuth scopes each v2 command needs.
 *
 * A missing scope does not show up until the call that needs it returns a
 * 403, which can be partway through a run: a client with `student-groups:*`
 * but not `students:read` reads the group and then fails the email lookup.
 * The token names its scopes, so `whoami` checks them against this table up
 * front.
 *
 * This is the one list. `test/v2-scopes.test.mjs` fails when a command in
 * package.json reaches the v2 client without an entry here, so a new v2
 * command has to say what it needs.
 */
import fs from 'fs';
import path from 'path';
import { repoRoot } from '#lib/paths.mjs';

/**
 * Command → `{ scopes, optional }`. `scopes` are needed on every run;
 * each `optional` entry adds `scopes` only when one of its `flags` is
 * passed.
 */
export const V2_COMMAND_SCOPES = {
  'group:add': { scopes: ['student-groups:read', 'student-groups:write', 'students:read'] },
  'group:remove': { scopes: ['student-groups:read', 'student-groups:write', 'students:read'] },
  'group:domains': { scopes: ['student-groups:read', 'student-groups:write'] },
  'export:analytics': {
    scopes: ['courses:read', 'analytics:read'],
    optional: [{ flags: ['--domain', '--by-domain'], scopes: ['domains:read'] }]
  },
  'check:drift': { scopes: ['audit:read', 'lessons:read', 'courses:read'] },
  'export:enrollments': { scopes: ['enrollments:read', 'published-courses:read', 'courses:read', 'students:read'] },
  'enroll:add': { scopes: ['enrollments:read', 'enrollments:write', 'published-courses:read', 'students:read'] },
  'enroll:remove': { scopes: ['enrollments:read', 'enrollments:write', 'published-courses:read', 'students:read'] },
  'check:visibility': { scopes: ['student-groups:read', 'published-courses:read', 'paths:read', 'courses:read'] }
};

/**
 * The scopes a token's claims grant, sorted. The claim is an array; a
 * space-separated string, the OAuth convention, is accepted too.
 */
export function grantedScopes(claims) {
  const raw = claims?.scopes ?? claims?.scope ?? [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/\s+/);
  return [...new Set(list.map(String).filter(Boolean))].sort();
}

/**
 * For each command in `table`, whether a client holding `granted` can run
 * it, and what it lacks for the base run and for each optional flag group.
 */
export function commandAccess(granted, table = V2_COMMAND_SCOPES) {
  const have = new Set(granted);
  const missing = (scopes) => scopes.filter((s) => !have.has(s));
  return Object.entries(table).map(([command, { scopes, optional = [] }]) => {
    const lacking = missing(scopes);
    return {
      command,
      runnable: lacking.length === 0,
      scopes: [...scopes],
      missing: lacking,
      optional: optional.map((o) => ({ flags: [...o.flags], scopes: [...o.scopes], missing: missing(o.scopes) }))
    };
  });
}

const LIB_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]#lib\/([^'"]+)['"]/g;
const V2_CLIENT = 'src/lib/skilljar/client-v2.mjs';
const V1_CLIENT = 'src/lib/skilljar/client.mjs';

/**
 * Every source file `files` reach through `#lib/` imports, themselves
 * included, as paths relative to the package root.
 */
export function importClosure(files, readSource) {
  const seen = new Set();
  const queue = [...files];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of readSource(file).matchAll(LIB_IMPORT)) queue.push(`src/lib/${spec}`);
  }
  return seen;
}

/**
 * Which credentials the command files `files` use: `v2` when they reach
 * the v2 client module, `v1` when any of them calls `createSkilljarClient`.
 * Reaching `client.mjs` alone is not v1 use, since every v2 command imports
 * it for `failCleanly`.
 */
export function credentialsUsed(files, readSource = readPackageSource) {
  const closure = importClosure(files, readSource);
  return {
    v2: closure.has(V2_CLIENT),
    v1: [...closure].some((f) => f !== V1_CLIENT && /\bcreateSkilljarClient\s*\(/.test(readSource(f)))
  };
}

export function readPackageSource(file) {
  return fs.readFileSync(path.join(repoRoot, file), 'utf8');
}
