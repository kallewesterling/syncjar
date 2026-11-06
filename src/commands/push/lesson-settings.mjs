/**
 * push-lesson-settings.mjs — push lesson settings from lessons-meta.json.
 *
 * Writes only the fields in LESSON_SETTINGS (lesson-settings.mjs): whether a
 * lesson is optional, its description, and its tooltip. Titles and content
 * stay with `push`. Reads one lesson list per course, the floor the API
 * allows. A real run asks once, PATCHes each changed lesson with only its
 * changed fields, then reads the touched courses' lessons again and fails on
 * any mismatch.
 */
import fs from 'fs-extra';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { workRoot } from '#lib/paths.mjs';
import { createSkilljarClient, failCleanly } from '#lib/skilljar/client.mjs';
import { fetchLessons } from '#lib/skilljar/fetch.mjs';
import { mapWithConcurrency } from '#lib/concurrency.mjs';
import { readDirFiles, filterByDirOrId } from '#lib/content/read-dirs.mjs';
import { planSettings, verifySettings } from '#lib/push/settings.mjs';
import { LESSON_SETTINGS, lessonTargets } from '#lib/push/lesson-settings.mjs';
import { guardBranch, runSettingsPush } from '#lib/push/settings-run.mjs';
import { fail } from '#lib/ui.mjs';

dotenv.config();

const argv = yargs(hideBin(process.argv))
  .option('dry-run', { type: 'boolean', default: false, description: 'Show each lesson\'s before and after; write nothing' })
  .option('force', { type: 'boolean', default: false, description: 'Write without asking' })
  .option('course', { type: 'array', string: true, default: [], description: 'Only this course directory name or course id (repeatable)' })
  .option('concurrency', { type: 'number', default: 6, description: 'Lesson lists read at once' })
  .option('allow-branch', { type: 'array', string: true, default: [], description: 'Also allow pushing from this content branch' })
  .strict()
  .argv;

const coursesDir = process.env.COURSE_CONTENT_PATH || path.join(workRoot, 'local-skilljar');

async function readCourses() {
  const out = [];
  for (const { dir, data: details } of await readDirFiles(coursesDir, 'details.json')) {
    const metaPath = path.join(coursesDir, dir, 'lessons-meta.json');
    if (!(await fs.pathExists(metaPath))) continue;
    out.push({ dir, details, lessons: await fs.readJson(metaPath) });
  }
  return out;
}

(async () => {
  if (!guardBranch({ argv, command: 'push:lesson-settings', dir: coursesDir })) return;

  const { kept: courses, unmatched } = filterByDirOrId(await readCourses(), argv.course, c => c.details.id);
  if (unmatched.length) {
    console.error(fail(`No local course matches: ${unmatched.join(', ')}`));
    process.exitCode = 1;
    return;
  }

  const client = createSkilljarClient();
  const limit = Math.max(1, argv.concurrency);
  const readLessons = async (list) => {
    const perCourse = await mapWithConcurrency(list, limit, c => fetchLessons(client, c.details.id));
    return new Map(perCourse.flat().map(l => [l.id, l]));
  };

  const before = await readLessons(courses);
  const targets = courses.flatMap(c => lessonTargets({ courseDir: c.dir, lessons: c.lessons, upstreamById: before }));
  const plan = planSettings({ targets, fields: LESSON_SETTINGS });

  await runSettingsPush({
    argv,
    noun: 'lesson',
    compared: targets.length,
    plan,
    write: (endpoint, body) => client.patch(endpoint, body),
    verify: async () => {
      const touched = new Set(plan.changes.map(c => c.id));
      const again = courses.filter(c => c.lessons.some(l => touched.has(l.id)));
      return verifySettings({ changes: plan.changes, fields: LESSON_SETTINGS, before, after: await readLessons(again) });
    }
  });
})().catch(err => failCleanly(err, 'Push of lesson settings failed.'));
