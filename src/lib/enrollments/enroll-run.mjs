/**
 * enroll-run.mjs — the run behind `enroll:add` and `enroll:remove`.
 *
 * DRY RUN BY DEFAULT. A dry run makes only reads: it resolves the course and
 * the published course, then looks up every email, the student's
 * enrollment in that published course and, for an add, their domain
 * membership. What it prints is what a real run would send.
 *
 * With --confirm, and SYNCJAR_ENROLL_WRITES=1 until the write path has been
 * tested against Skilljar, it asks for the action and count to be typed
 * back, sends the batches, stops at the first batch that fails as a whole,
 * reads every student's enrollment back, and writes an audit CSV of every
 * email either way.
 */
import fs from 'fs-extra';
import path from 'path';
import readline from 'node:readline/promises';
import yargs from 'yargs';
import { parse } from 'json2csv';
import { workRoot } from '#lib/paths.mjs';
import { mapWithConcurrency } from '#lib/concurrency.mjs';
import { failCleanly } from '#lib/skilljar/client.mjs';
import { createSkilljarV2Client, listAllV2, V2_CREDENTIALS_HINT } from '#lib/skilljar/client-v2.mjs';
import { chunk, classifyLookups, normaliseEmails, parseEmailList } from '#lib/groups/membership.mjs';
import { describe } from '#lib/groups/membership-run.mjs';
import { fail, heading, muted, ok, skip, warn } from '#lib/ui.mjs';
import {
  ACTIONS,
  AUDIT_FIELDS,
  ENROLL_BATCH_SIZE,
  ENROLL_WRITES_ENV,
  SUCCESS_RESULTS,
  choosePublishedCourse,
  deactivateBody,
  domainMembership,
  enrollBody,
  enrollmentState,
  finalResult,
  parseExpiresAt,
  planEnrollments,
  readBackMismatch,
  readBatchResult,
  reactivateBody,
  resolveCourse,
  writesUnlocked
} from '#lib/enrollments/enroll-plan.mjs';

const LOOKUP_CONCURRENCY = 4;
const SAMPLE_ROWS = 10;

export function parseEnrollArgs(action, argv) {
  const add = action === 'add';
  const parser = yargs(argv)
    .scriptName(`syncjar enroll:${action}`)
    .usage(`$0 --course <id|title> [--domain <name>] (--in <file> | --email <address>…)${add ? ' [--expires-at <date>] [--reactivate]' : ''} [--confirm]\n\n` +
      `${add ? 'Enrolls existing Skilljar students in' : 'Deactivates students\' enrollments in'} a course, by email. ` +
      'Dry run unless --confirm is passed.')
    .option('course', { type: 'string', demandOption: true, describe: 'v2 id or exact title of the course' })
    .option('domain', { type: 'string', describe: 'Domain name the course is published on; needed when it is on more than one' })
    .option('in', { type: 'string', describe: 'CSV with an email column, or one address per line' })
    .option('email', { type: 'array', string: true, default: [], describe: 'An address to act on; repeatable' })
    .option('confirm', { type: 'boolean', default: false, describe: 'Actually write. Without this it is a dry run.' })
    .option('audit-dir', { type: 'string', default: path.join(workRoot, 'public', 'data'), describe: 'Where the audit CSV is written' });
  if (add) {
    parser
      .option('expires-at', { type: 'string', describe: 'When the new enrollments expire (ISO 8601; a bare date is midnight UTC)' })
      .option('reactivate', { type: 'boolean', default: false, describe: 'Also reactivate deactivated enrollments, in place, keeping their progress' });
  }
  return parser
    .check((a) => {
      if (!a.in && !a.email.length) throw new Error('Pass --in <file> or at least one --email.');
      return true;
    })
    .strict()
    .help()
    .parse();
}

async function readEmails(argv, readFile) {
  const fromFile = argv.in ? parseEmailList(await readFile(argv.in, 'utf8')) : { emails: [], invalid: [], repeated: 0 };
  const merged = normaliseEmails([...fromFile.emails, ...argv.email]);
  return {
    emails: merged.emails,
    invalid: [...fromFile.invalid, ...merged.invalid],
    repeated: fromFile.repeated + merged.repeated
  };
}

/**
 * A student's enrollment rows in one course, on every domain. One page of
 * 100 is far more than one student can have in one course, so a second
 * page means the filters were not applied, and the read is refused rather
 * than walking every enrollment in the organisation.
 */
async function readEnrollmentRows(client, email, courseId) {
  const { data } = await client.get('/enrollments/', {
    params: { 'filter[student.email]': email, 'filter[course.id]': courseId, 'page[size]': 100 }
  });
  if (data.links?.next) throw new Error('more than 100 enrollments came back for one student in one course; the filters were not applied');
  return data.data ?? [];
}

async function askTyped(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const list = (items) => `${items.slice(0, 5).join(', ')}${items.length > 5 ? ', …' : ''}`;

const SKIP_REASONS = {
  skipped_inactive_account: 'have a deactivated Skilljar account',
  skipped_already_enrolled: 'are already enrolled (active)',
  skipped_deactivated: 'have a deactivated enrollment; pass --reactivate to reactivate it, keeping its progress',
  skipped_expired: 'have an expired enrollment; reactivating one has not been tested, so do it in the dashboard',
  skipped_several_enrollments: 'have more than one enrollment in this published course; choose which to reactivate in the dashboard',
  skipped_domain_not_member: 'are not members of the domain; what Skilljar does with them is not yet verified',
  skipped_domain_inactive_member: 'have an inactive membership of the domain; what Skilljar does with them is not yet verified',
  skipped_not_enrolled: 'are not enrolled in the course on this domain',
  skipped_already_inactive: 'already have an inactive (deactivated or expired) enrollment',
  skipped_several_active_enrollments: 'have more than one active enrollment in this published course, which this command does not handle'
};

/**
 * Runs one add or remove. Returns the exit code. `client` is a v2 client
 * (or a stand-in with get/post/patch); the rest is injectable for tests.
 */
export async function runEnroll(action, argv, {
  client,
  env = process.env,
  log = console.log,
  prompt = askTyped,
  readFile = fs.readFile,
  writeFile = fs.outputFile,
  now = Date.now,
  onApiError
}) {
  const { verb } = ACTIONS[action];
  const apiError = onApiError ?? ((err, context) => {
    log(fail(`${context}: ${describe(err)}`));
    return 1;
  });

  if (argv.confirm && !writesUnlocked(env)) {
    log(fail(`enroll:${action} --confirm is locked: its write path has not yet been verified against Skilljar.`));
    log(muted('  It was built from the API spec and tested against fakes only. Run it without --confirm for a dry run,'));
    log(muted(`  or set ${ENROLL_WRITES_ENV}=1 if you are running the live test on a throwaway course.`));
    return 1;
  }

  let expiresAt = null;
  if (argv.expiresAt != null) {
    const parsed = parseExpiresAt(argv.expiresAt, now());
    if (parsed.error) {
      log(fail(parsed.error));
      return 1;
    }
    expiresAt = parsed.iso;
  }

  const { emails, invalid, repeated } = await readEmails(argv, readFile);
  if (invalid.length) log(warn(`${invalid.length} entries are not email addresses and are ignored: ${list(invalid)}`));
  if (repeated) log(muted(`  ${repeated} repeated addresses dropped`));
  if (!emails.length) {
    log(fail('No email addresses to act on.'));
    return 1;
  }

  let course;
  try {
    const resolved = resolveCourse(await listAllV2(client, '/courses/'), argv.course);
    if (resolved.error) {
      log(fail(resolved.error));
      return 1;
    }
    course = resolved.course;
  } catch (err) {
    return apiError(err, 'Could not list courses');
  }

  let publishedCourse;
  let domain;
  try {
    const domains = new Map((await listAllV2(client, '/domains/')).map((d) => [d.id, d.attributes?.name]));
    if (argv.domain && ![...domains.values()].some((n) => n?.toLowerCase() === argv.domain.toLowerCase())) {
      log(fail(`Not a Skilljar domain: ${argv.domain}. Known: ${[...domains.values()].join(', ')}`));
      return 1;
    }
    const records = await listAllV2(client, '/published-courses/', { 'filter[course]': course.id });
    const chosen = choosePublishedCourse(records.filter((pc) => pc.relationships?.course?.data?.id === course.id), domains, argv.domain);
    if (chosen.error) {
      log(fail(chosen.error));
      return 1;
    }
    ({ publishedCourse, domain } = chosen);
  } catch (err) {
    return apiError(err, `Could not read where "${course.attributes?.title}" is published`);
  }
  if (action === 'add' && publishedCourse.attributes?.live === false) {
    log(fail(`"${course.attributes?.title}" is unpublished on ${domain.name}. Publish it before enrolling anyone.`));
    return 1;
  }

  let lookups;
  try {
    lookups = await mapWithConcurrency(emails, LOOKUP_CONCURRENCY, async (email) => {
      const { data } = await client.get('/students/', { params: { 'filter[email]': email, 'page[size]': 2 } });
      return { email, matches: data.data ?? [] };
    });
  } catch (err) {
    return apiError(err, 'Could not look up students by email');
  }
  const { found, missing, ambiguous } = classifyLookups(lookups);

  const stateOf = async (s) => enrollmentState(await readEnrollmentRows(client, s.email, course.id), {
    studentId: s.id, publishedCourseId: publishedCourse.id, now: now()
  });

  let students;
  try {
    students = await mapWithConcurrency(found, LOOKUP_CONCURRENCY, async (s) => {
      const enrollment = await stateOf(s);
      if (action !== 'add') return { ...s, enrollment };
      const memberships = await listAllV2(client, `/students/${encodeURIComponent(s.id)}/relationships/domain-memberships/`);
      return { ...s, enrollment, domain: domainMembership(memberships, domain.id) };
    });
  } catch (err) {
    return apiError(err, 'Could not read the students\' enrollments');
  }
  const { send, skipped } = planEnrollments(action, students, { reactivate: Boolean(argv.reactivate) });

  log(heading(`\n${verb.toUpperCase()}  ${send.length} students ${action === 'add' ? 'in' : 'from'} "${course.attributes?.title}" on ${domain.name}`));
  log(muted(`  course id ${course.id}, published course id ${publishedCourse.id}`));
  if (expiresAt) log(muted(`  new enrollments expire at ${expiresAt}`));
  log(muted(`  ${emails.length} emails: ${found.length} students found, ${missing.length} without an account, ${ambiguous.length} ambiguous`));
  if (missing.length) log(warn(`${missing.length} emails have no Skilljar account and are skipped (nobody is created): ${list(missing)}`));
  if (ambiguous.length) log(warn(`${ambiguous.length} emails match more than one student and are skipped: ${list(ambiguous)}`));
  for (const [result, reason] of Object.entries(SKIP_REASONS)) {
    const these = skipped.filter((s) => s.result === result);
    if (these.length) log(warn(`${these.length} students ${reason}: ${list(these.map((s) => s.email))}`));
  }
  const reactivating = send.filter((s) => s.intent === 'reactivate');
  if (reactivating.length) {
    log(muted(`  ${reactivating.length} deactivated enrollment(s) will be reactivated in place, keeping their progress`));
    if (expiresAt) log(warn('--expires-at applies to new enrollments only, not to reactivated ones.'));
  }
  if (action === 'remove') {
    log(muted('  Deactivating keeps the enrollment and its progress, and ends the learner\'s access; it is not a deletion.'));
    log(muted('  enroll:add --reactivate undoes it.'));
  }
  const jobs = action === 'add'
    ? [
        ...chunk(send.filter((s) => s.intent === 'enroll'), ENROLL_BATCH_SIZE).map((batch) => ({ kind: 'add', batch })),
        ...chunk(reactivating, ENROLL_BATCH_SIZE).map((batch) => ({ kind: 'reactivate', batch }))
      ]
    : chunk(send, ENROLL_BATCH_SIZE).map((batch) => ({ kind: 'remove', batch }));
  log(muted(`  ${jobs.length} write request(s) of up to ${ENROLL_BATCH_SIZE}\n`));

  if (!send.length) {
    log(fail('Nobody to send. Nothing to do.'));
    return 1;
  }

  if (!argv.confirm) {
    for (const s of send.slice(0, SAMPLE_ROWS)) {
      log(`  ${s.intent.padEnd(10)} ${s.email}${muted(`  now ${s.enrollment.state}${s.enrollment.progress ? `, ${s.enrollment.progress}` : ''}`)}`);
    }
    if (send.length > SAMPLE_ROWS) log(muted(`  … and ${send.length - SAMPLE_ROWS} more`));
    log(`\n${skip('DRY RUN: nothing was written. Re-run with --confirm to apply.')}\n`);
    return 0;
  }

  const expected = `${verb} ${send.length}`;
  const answer = await prompt(`Type "${expected}" to proceed: `);
  if (String(answer).trim() !== expected) {
    log(fail('Aborted. Nothing was written.'));
    return 1;
  }

  const responses = new Map();
  let stopped = null;
  for (const { kind, batch } of jobs) {
    if (stopped) {
      for (const s of batch) responses.set(s.email, { response: 'not_attempted', error: 'an earlier batch failed' });
      continue;
    }
    try {
      const ids = batch.map((s) => s.enrollment.enrollmentId);
      const res = kind === 'add'
        ? await client.post('/enrollments/', enrollBody(publishedCourse.id, batch.map((s) => s.email), expiresAt))
        : await client.patch('/enrollments/', kind === 'reactivate' ? reactivateBody(ids) : deactivateBody(ids));
      for (const row of readBatchResult(kind, batch, res.data)) responses.set(row.email, row);
    } catch (err) {
      stopped = describe(err);
      for (const s of batch) responses.set(s.email, { response: 'request_failed', error: stopped });
    }
  }

  log(muted('  Reading every enrollment back...'));
  const rows = await mapWithConcurrency(send, LOOKUP_CONCURRENCY, async (s) => {
    const sent = responses.get(s.email);
    const row = {
      email: s.email,
      student_id: s.id,
      name: s.name,
      enrollment_id: sent.enrollment_id || s.enrollment.enrollmentId || '',
      before: s.enrollment.state,
      progress_before: s.enrollment.progress ?? '',
      expires_at_before: s.enrollment.expiresAt ?? '',
      response: sent.response,
      error: sent.error ?? ''
    };
    if (sent.response === 'not_attempted') return { ...row, result: 'not_attempted' };
    try {
      const after = await stateOf(s);
      const mismatch = readBackMismatch(action, s, after, { expiresAt: s.intent === 'enroll' ? expiresAt : null });
      return {
        ...row,
        enrollment_id: row.enrollment_id || after.enrollmentId || '',
        after: after.state,
        expires_at_after: after.expiresAt ?? '',
        result: finalResult(action, s.intent, sent.response, mismatch, null),
        error: [row.error, mismatch].filter(Boolean).join('; ')
      };
    } catch (err) {
      return { ...row, result: 'unverified', error: [row.error, `read-back failed: ${describe(err)}`].filter(Boolean).join('; ') };
    }
  });

  const audit = [
    ...rows,
    ...skipped.map((s) => ({
      email: s.email, student_id: s.id, name: s.name, enrollment_id: s.enrollment.enrollmentId ?? '',
      before: s.enrollment.state, progress_before: s.enrollment.progress ?? '', expires_at_before: s.enrollment.expiresAt ?? '',
      result: s.result
    })),
    ...missing.map((email) => ({ email, result: 'skipped_no_account' })),
    ...ambiguous.map((email) => ({ email, result: 'skipped_ambiguous' }))
  ].map((r) => ({
    ...r,
    course_id: course.id,
    course_title: course.attributes?.title ?? '',
    published_course_id: publishedCourse.id,
    domain: domain.name,
    action
  }));

  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const auditPath = path.join(argv.auditDir, `enroll-${action}-audit-${stamp}.csv`);
  await writeFile(auditPath, parse(audit, { fields: AUDIT_FIELDS }));

  const count = (result) => rows.filter((r) => r.result === result).length;
  const failed = rows.filter((r) => !SUCCESS_RESULTS.has(r.result));
  log('');
  if (action === 'add') {
    log(ok(`${count('enrolled')} enrolled`) + muted(`, ${count('reactivated')} reactivated, ${count('already_enrolled')} already enrolled, all read back`));
  } else {
    log(ok(`${count('deactivated')} deactivated, read back`));
  }
  if (failed.length) {
    log(fail(`${failed.length} failed, unverified or not attempted: ${list(failed.map((r) => `${r.email} (${r.result})`))}`));
  }
  if (stopped) log(fail(`Stopped after a batch failed: ${stopped}`));
  log(muted(`  Audit trail: ${auditPath}`));
  log(muted('  It holds names and email addresses. Delete it once it is no longer needed.\n'));
  return failed.length ? 1 : 0;
}

/**
 * The whole of `enroll:add` and `enroll:remove`. Options are parsed before
 * the client is built, so --help works without credentials.
 */
export async function enrollCommand(action, rawArgv) {
  const argv = parseEnrollArgs(action, rawArgv);
  let client;
  try {
    client = createSkilljarV2Client();
  } catch (err) {
    console.error(fail(err.message));
    return 1;
  }
  return runEnroll(action, argv, {
    client,
    onApiError: (err, context) => failCleanly(err, context, { credentialsHint: V2_CREDENTIALS_HINT })
  });
}
