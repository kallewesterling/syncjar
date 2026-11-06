import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { commandTable } from '#lib/cli.mjs';
import { commandAccess, credentialsUsed, grantedScopes, importClosure, V2_COMMAND_SCOPES } from '#lib/skilljar/v2-scopes.mjs';
import { buildReport, classifyCommands, formatReport } from '#lib/whoami.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const commands = commandTable(pkg.scripts);

// whoami reaches the v2 client to read the token, and needs no scope to do it.
const NEEDS_NO_SCOPE = new Set(['whoami']);

// The table is what tells a partner whether their client can run a command,
// so it must not fall behind package.json in either direction. Commands in
// the table that package.json does not have yet are being built elsewhere,
// and are allowed.
test('every package.json command that reaches the v2 client has a scope entry', () => {
  const found = [];
  for (const [name, files] of commands) {
    if (NEEDS_NO_SCOPE.has(name) || !credentialsUsed(files).v2) continue;
    found.push(name);
    assert.ok(name in V2_COMMAND_SCOPES, `${name} uses API v2 but is not in V2_COMMAND_SCOPES`);
  }
  assert.ok(found.includes('group:add'), 'detection found none of the known v2 commands');
});

test('every scope entry that names a package.json command is a v2 command', () => {
  for (const name of Object.keys(V2_COMMAND_SCOPES)) {
    if (!commands.has(name)) continue;
    assert.ok(credentialsUsed(commands.get(name)).v2, `${name} is in V2_COMMAND_SCOPES but does not reach the v2 client`);
  }
});

test('detection follows #lib imports, and importing client.mjs for failCleanly is not v1 use', () => {
  const sources = {
    'src/commands/a.mjs': "import { run } from '#lib/run.mjs';",
    'src/lib/run.mjs': "import { failCleanly } from '#lib/skilljar/client.mjs';\nconst m = await import('#lib/skilljar/client-v2.mjs');",
    'src/lib/skilljar/client-v2.mjs': "import { attachRetries } from '#lib/skilljar/client.mjs';",
    'src/lib/skilljar/client.mjs': 'export function createSkilljarClient() {}',
    'src/commands/b.mjs': "import { createSkilljarClient } from '#lib/skilljar/client.mjs';\nconst c = createSkilljarClient();"
  };
  const read = (f) => sources[f];
  assert.deepEqual([...importClosure(['src/commands/a.mjs'], read)].sort(), [
    'src/commands/a.mjs', 'src/lib/run.mjs', 'src/lib/skilljar/client-v2.mjs', 'src/lib/skilljar/client.mjs'
  ]);
  assert.deepEqual(credentialsUsed(['src/commands/a.mjs'], read), { v2: true, v1: false });
  assert.deepEqual(credentialsUsed(['src/commands/b.mjs'], read), { v2: false, v1: true });
});

test('the real v1 and keyless commands are classified as such', () => {
  const { v1, none, unlisted } = classifyCommands(pkg.scripts);
  assert.deepEqual(unlisted, []);
  for (const name of ['pull', 'push', 'build:preview', 'group:revoke', 'export:students']) assert.ok(v1.includes(name), `${name} should need the v1 key`);
  for (const name of ['serve', 'generate:courses']) assert.ok(none.includes(name), `${name} should need no credentials`);
  assert.ok(!v1.includes('whoami') && !none.includes('whoami'));
});

test('granted scopes are sorted and deduplicated, from an array or a string', () => {
  assert.deepEqual(grantedScopes({ scopes: ['students:read', 'courses:read', 'students:read'] }), ['courses:read', 'students:read']);
  assert.deepEqual(grantedScopes({ scope: 'b:read a:read' }), ['a:read', 'b:read']);
  assert.deepEqual(grantedScopes({}), []);
});

test('a command is runnable only with every required scope, and optional flags are reported apart', () => {
  const table = {
    x: { scopes: ['a:read', 'b:write'] },
    y: { scopes: ['a:read'], optional: [{ flags: ['--z'], scopes: ['z:read'] }] }
  };
  const [x, y] = commandAccess(['a:read'], table);
  assert.equal(x.runnable, false);
  assert.deepEqual(x.missing, ['b:write']);
  assert.equal(y.runnable, true);
  assert.deepEqual(y.optional, [{ flags: ['--z'], scopes: ['z:read'], missing: ['z:read'] }]);
});

test('the group client can run the group commands, and nothing else in v2', () => {
  const access = commandAccess(['students:read', 'student-groups:read', 'student-groups:write']);
  const runnable = access.filter((c) => c.runnable).map((c) => c.command).sort();
  assert.deepEqual(runnable, ['group:add', 'group:domains', 'group:remove']);
});

test('the report says whether the v1 key is set, never what it is', () => {
  const claims = { client_id: 'cid', organization_id: 'org', iat: 1000, exp: 1900, scopes: ['courses:read', 'analytics:read'] };
  const key = 'sk-notarealkey';
  const report = buildReport({ claims, expiresIn: 900, scripts: pkg.scripts, env: { SKILLJAR_API_KEY: key } });
  assert.equal(report.token_lifetime_seconds, 900);
  assert.equal(report.expires_at, new Date(1900_000).toISOString());
  assert.deepEqual(report.scopes, ['analytics:read', 'courses:read']);
  assert.equal(report.v1_commands.api_key_set, true);
  const analytics = report.v2_commands.find((c) => c.command === 'export:analytics');
  assert.equal(analytics.runnable, true);
  assert.deepEqual(analytics.optional[0].missing, ['domains:read']);

  const text = formatReport(report).join('\n') + JSON.stringify(report);
  assert.doesNotMatch(text, new RegExp(key));
  assert.match(formatReport(report).join('\n'), /900s \(15 min\)/);
  assert.equal(buildReport({ claims, scripts: pkg.scripts, env: {} }).v1_commands.api_key_set, false);
});
