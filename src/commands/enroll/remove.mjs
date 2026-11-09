/**
 * syncjar enroll:remove  (npm run enroll:remove)
 *
 * Deactivates students' enrollments in a course, by email, through the v2
 * API (`active: false`; the enrollment and its progress are kept). Needs
 * SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET for an API client with
 * courses:read, published-courses:read, domains:read, students:read,
 * enrollments:read and enrollments:write.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --confirm.
 *
 *   syncjar enroll:remove --course "Intro to Chainguard" --domain courses.example.com --in emails.csv
 *   syncjar enroll:remove --course <id> --email someone@example.com --confirm
 */
import 'dotenv/config';
import { hideBin } from 'yargs/helpers';
import { enrollCommand } from '#lib/enrollments/enroll-run.mjs';

process.exitCode = await enrollCommand('remove', hideBin(process.argv));
