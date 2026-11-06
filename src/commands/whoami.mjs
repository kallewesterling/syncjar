/**
 * syncjar whoami  (npm run whoami)
 *
 * Shows which API v2 client SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET
 * name, the scopes it holds, and which commands it can therefore run, so a
 * missing scope shows up before a run rather than as a 403 partway through.
 * Lists the commands that need the v1 key instead, and whether it is set.
 *
 *   syncjar whoami
 *   syncjar whoami --json
 *
 * Makes one request, the token exchange. The scopes are read from the token
 * itself, decoded locally; the token is never printed.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { repoRoot } from '#lib/paths.mjs';
import { failCleanly } from '#lib/skilljar/client.mjs';
import { decodeTokenClaims, fetchAccessToken, V2_CREDENTIALS_HINT } from '#lib/skilljar/client-v2.mjs';
import { buildReport, formatReport } from '#lib/whoami.mjs';
import { fail } from '#lib/ui.mjs';

const argv = yargs(hideBin(process.argv))
  .scriptName('syncjar whoami')
  .option('json', { type: 'boolean', default: false, describe: 'Print the report as JSON' })
  .strict()
  .help()
  .parse();

let token;
try {
  token = await fetchAccessToken();
} catch (err) {
  if (!err.response && !err.code) {
    console.error(fail(err.message));
    process.exit(1);
  }
  failCleanly(err, 'Could not get an API v2 token', { credentialsHint: V2_CREDENTIALS_HINT });
}

let claims;
try {
  claims = decodeTokenClaims(token.accessToken);
} catch (err) {
  console.error(fail(err.message));
  process.exit(1);
}

const { scripts } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const report = buildReport({ claims, expiresIn: token.expiresIn, scripts });

if (argv.json) console.log(JSON.stringify(report, null, 2));
else console.log(formatReport(report, { configuredClientId: process.env.SKILLJAR_CLIENT_ID }).join('\n'));
