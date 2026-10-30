/**
 * syncjar group:remove  (npm run group:remove)
 *
 * Removes students from a group, by email, through the v2 API. Reversible
 * with group:add, except that a group manager comes back as an ordinary
 * member: v2 has no way to restore the manager flag.
 * Needs SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET for an API client with
 * the scopes student-groups:read, student-groups:write and students:read.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --confirm.
 *
 *   syncjar group:remove --group-name "Partner: Example" --in emails.csv
 *   syncjar group:remove --group-name "Partner: Example" --in emails.csv --confirm
 */
import 'dotenv/config';
import { hideBin } from 'yargs/helpers';
import { membershipCommand } from '#lib/groups/membership-run.mjs';

process.exitCode = await membershipCommand('remove', hideBin(process.argv));
