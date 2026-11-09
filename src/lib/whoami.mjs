/**
 * whoami.mjs — what `syncjar whoami` reports, built from a token's decoded
 * claims and the command list, so it can be tested without a token request.
 */
import { commandTable } from '#lib/cli.mjs';
import { commandAccess, credentialsUsed, grantedScopes, readPackageSource, V2_COMMAND_SCOPES } from '#lib/skilljar/v2-scopes.mjs';
import { heading, muted, ok, symbols, warn } from '#lib/ui.mjs';
import chalk from 'chalk';

/**
 * Splits package.json's commands by the credentials they use, apart from
 * those in the v2 scope table, which are reported from the table instead.
 * `unlisted` holds v2 commands missing from the table, which the tests
 * should have caught.
 */
export function classifyCommands(scripts, { table = V2_COMMAND_SCOPES, readSource = readPackageSource, exclude = ['whoami'] } = {}) {
  const v1 = [];
  const none = [];
  const unlisted = [];
  for (const [name, files] of commandTable(scripts)) {
    if (name in table || exclude.includes(name)) continue;
    const uses = credentialsUsed(files, readSource);
    if (uses.v2) unlisted.push(name);
    else if (uses.v1) v1.push(name);
    else none.push(name);
  }
  return { v1: v1.sort(), none: none.sort(), unlisted: unlisted.sort() };
}

/**
 * The whole report, as plain data: this is what `--json` prints. Nothing in
 * it is secret; the token is not passed in, and of the v1 key only whether
 * it is set.
 */
export function buildReport({ claims, expiresIn, scripts, env = process.env, table = V2_COMMAND_SCOPES, readSource = readPackageSource }) {
  const scopes = grantedScopes(claims);
  const lifetime = Number.isFinite(claims.exp) && Number.isFinite(claims.iat) ? claims.exp - claims.iat : expiresIn ?? null;
  const { v1, none, unlisted } = classifyCommands(scripts, { table, readSource });
  return {
    client_id: claims.client_id ?? null,
    organization_id: claims.organization_id ?? null,
    token_lifetime_seconds: lifetime,
    expires_at: Number.isFinite(claims.exp) ? new Date(claims.exp * 1000).toISOString() : null,
    scopes,
    v2_commands: commandAccess(scopes, table),
    v2_commands_without_scope_entry: unlisted,
    v1_commands: { api_key_set: Boolean(env.SKILLJAR_API_KEY), commands: v1 },
    no_credentials_commands: none
  };
}

function formatLifetime(seconds) {
  if (seconds == null) return 'unknown';
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds}s (${seconds / 60} min)`;
  return `${seconds}s`;
}

/**
 * The report as terminal lines.
 */
export function formatReport(report, { configuredClientId } = {}) {
  const lines = [];
  lines.push(heading('API v2 client'));
  lines.push(`  Client id:     ${report.client_id ?? muted('(not in token)')}`);
  if (configuredClientId && report.client_id && configuredClientId !== report.client_id) {
    lines.push(`  ${warn(`SKILLJAR_CLIENT_ID is ${configuredClientId}, but the token names another client.`)}`);
  }
  lines.push(`  Organisation:  ${report.organization_id ?? muted('(not in token)')}`);
  lines.push(`  Token lasts:   ${formatLifetime(report.token_lifetime_seconds)}`);
  lines.push(`  Scopes:        ${report.scopes.length ? report.scopes.length : muted('(none)')}`);
  lines.push(...wrapList(report.scopes, { indent: '    ' }));

  lines.push('', heading('API v2 commands'));
  const width = Math.max(...report.v2_commands.map((c) => c.command.length));
  for (const c of report.v2_commands) {
    lines.push(c.runnable
      ? `  ${ok(c.command)}`
      : `  ${chalk.red(symbols.fail)} ${c.command.padEnd(width)}  ${muted('missing')} ${c.missing.join(', ')}`);
    for (const o of c.optional) {
      const flags = o.flags.join(' / ');
      lines.push(o.missing.length
        ? `      ${warn(`${flags} also needs ${o.missing.join(', ')}`)}`
        : `      ${muted(`${flags}: ${symbols.ok}`)}`);
    }
  }
  for (const name of report.v2_commands_without_scope_entry) {
    lines.push(`  ${warn(`${name}  uses API v2, but its scopes are not recorded`)}`);
  }

  const { api_key_set, commands } = report.v1_commands;
  lines.push('', heading('Needs SKILLJAR_API_KEY (v1)') + '  ' + (api_key_set ? ok('set') : warn('not set')));
  lines.push(...wrapList(commands));
  if (report.no_credentials_commands.length) {
    lines.push('', heading('Needs no Skilljar credentials'));
    lines.push(...wrapList(report.no_credentials_commands));
  }
  return lines;
}

function wrapList(names, { indent = '  ', width = 78 } = {}) {
  const lines = [];
  let line = '';
  for (const name of names) {
    const next = line ? `${line}, ${name}` : name;
    if (line && indent.length + next.length > width) {
      lines.push(`${indent}${line},`);
      line = name;
    } else line = next;
  }
  if (line) lines.push(`${indent}${line}`);
  return lines;
}
