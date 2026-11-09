/**
 * syncjar enroll:add  (npm run enroll:add)
 *
 * Enrolls existing Skilljar students in a course, by email, through the v2
 * API. Needs SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET for an API client
 * with courses:read, published-courses:read, domains:read, students:read,
 * enrollments:read and enrollments:write.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --confirm.
 *
 *   syncjar enroll:add --course "Intro to Chainguard" --domain courses.example.com --in emails.csv
 *   syncjar enroll:add --course <id> --email someone@example.com --expires-at 2027-01-31 --confirm
 */
import 'dotenv/config';
import { hideBin } from 'yargs/helpers';
import { enrollCommand } from '#lib/enrollments/enroll-run.mjs';

process.exitCode = await enrollCommand('add', hideBin(process.argv));
