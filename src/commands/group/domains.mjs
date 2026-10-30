/**
 * syncjar group:domains  (npm run group:domains)
 *
 * Lists a group's auto-add email domains, or adds and removes them, through
 * the v2 API. Needs SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET for an API
 * client with the scopes student-groups:read and student-groups:write.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --confirm.
 *
 *   syncjar group:domains --group-name "Partner: Example"
 *   syncjar group:domains --group-name "Partner: Example" --add example.com
 *   syncjar group:domains --group <id> --add example.com --remove old.example --confirm
 */
import 'dotenv/config';
import { hideBin } from 'yargs/helpers';
import { domainsCommand } from '#lib/groups/domains-run.mjs';

process.exitCode = await domainsCommand(hideBin(process.argv));
