/**
 * syncjar group:add  (npm run group:add)
 *
 * Adds existing Skilljar students to a group, by email, through the v2 API.
 * Needs SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET for an API client with
 * the scopes student-groups:read, student-groups:write and students:read.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --confirm.
 *
 *   syncjar group:add --group-name "Partner: Example" --in emails.csv
 *   syncjar group:add --group-name "Partner: Example" --in emails.csv --confirm
 *   syncjar group:add --group <id> --email someone@example.com --confirm
 */
import 'dotenv/config';
import { hideBin } from 'yargs/helpers';
import { membershipCommand } from '#lib/groups/membership-run.mjs';

process.exitCode = await membershipCommand('add', hideBin(process.argv));
