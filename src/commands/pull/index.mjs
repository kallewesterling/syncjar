import fs from 'fs-extra';
import path from 'path';
import { repoRoot } from '#lib/paths.mjs';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { createSkilljarClient, failCleanly } from '#lib/skilljar/client.mjs';
import { slugify, readCourseDirIndex, resolveCourseDirName } from '#lib/content/course-dirs.mjs';
import { readLessonDirIndex, resolveLessonDirName } from '#lib/content/lesson-dirs.mjs';
import { mapWithConcurrency } from '#lib/concurrency.mjs';
import {
  fetchCourses,
  fetchLessons,
  fetchContentItems,
  fetchQuizzes,
  fetchQuizQuestions,
  fetchQuestionBanks,
  fetchQuizQuestionBanks
} from '#lib/skilljar/fetch.mjs';
import { splitContentItems, buildLessonEntry } from '#lib/content/lesson-meta.mjs';
import {
  quizFileName,
  buildQuizFile,
  collectLinkedQuizIds,
  banksInUse,
  findStaleQuizFiles
} from '#lib/content/quiz-files.mjs';

dotenv.config();

const argv = yargs(hideBin(process.argv))
  .option('course', {
    type: 'string',
    description: 'Only sync the course matching this slug (partial match, case-insensitive)'
  })
  .argv;

// Axios client for Skilljar (auto-retries on 429/5xx, honouring Retry-After)
const client = createSkilljarClient();

// Fall back on the env var itself. `path.join(undefined, x) || fallback` throws
// inside path.join before `||` is ever read.
const contentPath = process.env.COURSE_CONTENT_PATH
  || path.join(repoRoot, 'local-skilljar');

const quizContentPath = process.env.QUIZ_CONTENT_PATH
  || path.join(repoRoot, 'local-skilljar-quizzes');

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class SyncTable {
  // Rows are keyed by directory name, not title: titles are not unique, so a
  // title key can mark the wrong row done.
  constructor(targets) {
    this.rows = targets.map(({ course, dirName }) => ({
      key: dirName, title: course.title, status: 'pending', lessons: null, frame: 0
    }));
    this.titleWidth = Math.max(...this.rows.map(r => r.title.length), 'Course'.length);
    this._interval = null;
  }

  _renderRow(row) {
    const lessonStr = row.lessons !== null ? String(row.lessons) : '-';
    if (row.status === 'done') {
      return `  ${chalk.green('✓')}  ${row.title.padEnd(this.titleWidth)}  ${lessonStr.padStart(7)}`;
    }
    if (row.status === 'syncing') {
      const frame = chalk.yellow(SPINNER_FRAMES[row.frame % SPINNER_FRAMES.length]);
      return `  ${frame}  ${chalk.yellow(row.title.padEnd(this.titleWidth))}  ${lessonStr.padStart(7)}`;
    }
    return `  ${chalk.gray('·')}  ${chalk.gray(row.title.padEnd(this.titleWidth))}  ${lessonStr.padStart(7)}`;
  }

  _draw(initial = false) {
    const totalLines = this.rows.length + 2;
    if (!initial) process.stdout.write(`\x1B[${totalLines}A`);
    process.stdout.write(`\x1B[2K  ${chalk.bold('   ' + 'Course'.padEnd(this.titleWidth))}  ${chalk.bold('Lessons')}\n`);
    process.stdout.write(`\x1B[2K  ${'─'.repeat(this.titleWidth + 12)}\n`);
    for (const row of this.rows) {
      process.stdout.write(`\x1B[2K${this._renderRow(row)}\n`);
    }
  }

  start() {
    this._draw(true);
    this._interval = setInterval(() => {
      for (const row of this.rows) {
        if (row.status === 'syncing') row.frame++;
      }
      this._draw();
    }, 80);
  }

  setStarted(key) {
    const row = this.rows.find(r => r.key === key);
    if (row) row.status = 'syncing';
  }

  setDone(key, lessons) {
    const row = this.rows.find(r => r.key === key);
    if (row) { row.status = 'done'; row.lessons = lessons; }
    if (this.rows.every(r => r.status === 'done')) {
      clearInterval(this._interval);
      this._draw();
    }
  }
}

// The three list reads now live in skilljar-fetch.mjs, because push needs the
// same ones: it used to fetch each course, lesson and content item by id, one
// round trip apiece, which is what made it take ten minutes.

async function withConcurrency(items, limit, fn) {
  const executing = new Set();
  for (const item of items) {
    const p = fn(item).finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.allSettled([...executing]);
}

// Max content-item requests in flight per course at any moment.
const LESSON_CONCURRENCY = 4;

// `dirName` must come from the caller, which resolves it from the course id.
// Deriving it from the mutable title here creates a second directory for the
// same course every time an editor rewords or re-cases a title upstream.
async function syncCourse(course, dirName, table) {
  const exportDir = path.join(contentPath, dirName);
  const lessonsDir = path.join(exportDir, 'lessons');
  table.setStarted(dirName);

  const [lessons, lessonIndex] = await Promise.all([
    fetchLessons(client, course.id),
    // Read before lessons-meta.json gets overwritten below, so an id that
    // already has a slug keeps it regardless of what the title says now.
    readLessonDirIndex(exportDir),
    fs.outputJson(path.join(exportDir, 'details.json'), course, { spaces: 2 })
  ]);

  const lessonMetaList = await mapWithConcurrency(lessons, LESSON_CONCURRENCY, async (lesson) => {
    const lessonSlug = resolveLessonDirName(lessonIndex, lesson);
    const lessonFolder = path.join(lessonsDir, lessonSlug);

    const [contentItems] = await Promise.all([
      fetchContentItems(client, lesson.id),
      fs.ensureDir(lessonFolder)
    ]);

    const { html: htmlItems, other: nonHtmlItems } = splitContentItems(contentItems);

    const contentItemsMeta = await Promise.all(
      htmlItems.map(async (item) => {
        const prefix = slugify(item.header) || 'content';
        const filename = `${prefix}-${item.id}.html`;
        const relPath = path.join('lessons', lessonSlug, filename);
        await fs.outputFile(path.join(exportDir, relPath), item.content_html);
        return { id: item.id, file: relPath, order: item.order };
      })
    );

    // Reconcile: include any HTML files on disk not covered by the API response
    // (can happen when content items are replaced in Skilljar, leaving orphaned files)
    const trackedFiles = new Set(contentItemsMeta.map(i => path.basename(i.file)));
    let diskFiles = [];
    try {
      diskFiles = (await fs.readdir(lessonFolder))
        .filter(f => f.endsWith('.html') && !trackedFiles.has(f))
        .sort();
    } catch { /* folder missing */ }

    const diskOnlyMeta = diskFiles.map((f, idx) => ({
      id: null,
      file: path.join('lessons', lessonSlug, f),
      order: (contentItemsMeta.length + idx + 1) * 10
    }));

    return buildLessonEntry({
      lesson,
      slug: lessonSlug,
      contentItems: [...contentItemsMeta, ...diskOnlyMeta],
      nonHtmlItems
    });
  });

  await fs.outputJson(path.join(exportDir, 'lessons-meta.json'), lessonMetaList, { spaces: 2 });
  lessonsByCourseDir.set(dirName, lessonMetaList);
  table.setDone(dirName, lessons.length);
}

// Filled in by syncCourse, read by pullQuizzes once every course is done.
const lessonsByCourseDir = new Map();

const QUIZ_CONCURRENCY = 6;

/**
 * Writes quizzes to `QUIZ_CONTENT_PATH`, one file per quiz.
 *
 * A full pull writes every quiz in the organisation, linked or not. A quiz
 * that push created is unattached until someone links it, and it still has to
 * refresh. A `--course` pull writes only the quizzes that course links to.
 *
 * Costs one quiz list, one bank list, and one question list per quiz. The
 * per-quiz bank check is only made when some bank is used by some quiz.
 */
async function pullQuizzes({ fullPull }) {
  let requests = 0;
  const linkedIds = new Set(
    [...lessonsByCourseDir.values()].flatMap(lessons => [...collectLinkedQuizIds(lessons)])
  );

  const [quizzes, banks] = await Promise.all([fetchQuizzes(client), fetchQuestionBanks(client)]);
  requests += 2;
  const quizById = new Map(quizzes.map(q => [q.id, q]));
  const checkBanks = banksInUse(banks);

  const warnings = [];
  for (const id of linkedIds) {
    if (!quizById.has(id)) warnings.push(`quiz ${id} is linked from a lesson but not in the quiz list — not written`);
  }

  const targets = fullPull ? quizzes : quizzes.filter(q => linkedIds.has(q.id));

  const perQuiz = await mapWithConcurrency(targets, QUIZ_CONCURRENCY, async (quiz) => {
    const [questions, bankAssignments] = await Promise.all([
      fetchQuizQuestions(client, quiz.id),
      checkBanks ? fetchQuizQuestionBanks(client, quiz.id) : Promise.resolve([])
    ]);
    requests += checkBanks ? 2 : 1;
    return { quiz, questions, bankAssignments };
  });

  for (const { quiz, questions, bankAssignments } of perQuiz) {
    await fs.outputJson(
      path.join(quizContentPath, quizFileName(quiz.id)),
      buildQuizFile(quiz, questions),
      { spaces: 2 }
    );
    if (bankAssignments.length) {
      warnings.push(
        `quiz ${quiz.id} ("${quiz.name}") draws from ${bankAssignments.length} question bank(s); ` +
        `bank questions are not in its file`
      );
    }
  }

  // Only a full pull knows the whole upstream set, so only it can call a
  // local file stale or a quiz unlinked.
  let unlinked = [];
  if (fullPull) {
    let existing = [];
    try { existing = await fs.readdir(quizContentPath); } catch { /* first pull */ }
    for (const name of findStaleQuizFiles(existing, new Set(quizById.keys()))) {
      warnings.push(`${name} is not in Skilljar any more — left in place`);
    }
    unlinked = quizzes.filter(q => !linkedIds.has(q.id));
  }

  for (const warning of warnings) console.warn(chalk.yellow(`! ${warning}`));
  if (unlinked.length) {
    console.log(chalk.gray(
      `  ${unlinked.length} quiz(zes) not linked from any lesson: ` +
      unlinked.map(q => `"${q.name}"`).join(', ')
    ));
  }
  console.log(`✓ ${perQuiz.length} quiz(zes) written to ${quizContentPath} — ${requests} request(s).`);
}

// MAIN
(async () => {
  let courses = await fetchCourses(client);

  // Deduplicate by id, in case the API returns a course twice across pages.
  // This used to deduplicate by title slug, to stop two same-titled courses
  // from racing each other into one title-derived directory. Directories now
  // come from the id, so same-titled courses get separate directories and the
  // title key would only drop a real course.
  const byId = new Map();
  for (const c of courses) {
    if (!c?.id) continue;
    const existing = byId.get(c.id);
    if (!existing || new Date(c.modified_at) > new Date(existing.modified_at)) {
      byId.set(c.id, c);
    }
  }
  courses = [...byId.values()];

  // Most recently updated first
  courses.sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));

  // Reuse the directory each course already has. Resolve every name before the
  // concurrent sync starts, so the result does not depend on completion order.
  const index = await readCourseDirIndex(contentPath);
  let targets = courses.map(course => ({
    course,
    dirName: resolveCourseDirName(index, course)
  }));

  for (const [id, dirs] of index.duplicates) {
    console.warn(chalk.yellow(
      `! Course id ${id} is in ${dirs.length} directories: ${dirs.join(', ')}. ` +
      `Writing to "${index.byId.get(id)}" only — delete the others.`
    ));
  }
  if (index.unidentified.length) {
    console.warn(chalk.gray(
      `Ignoring ${index.unidentified.length} directory/directories with no course id ` +
      `in details.json: ${index.unidentified.join(', ')}`
    ));
  }

  if (argv.course) {
    const filter = argv.course.toLowerCase();
    // Match the directory name as well as the title slug, since the two can
    // differ once a title changes upstream.
    const filtered = targets.filter(t =>
      t.dirName.toLowerCase().includes(filter)
      || slugify(t.course.title || '').toLowerCase().includes(filter));
    if (filtered.length === 0) {
      console.error(`No courses matched --course "${argv.course}"`);
      process.exit(1);
    }
    targets = filtered;
  }

  const table = new SyncTable(targets);
  table.start();

  await withConcurrency(targets, 3, ({ course, dirName }) => syncCourse(course, dirName, table));

  process.stdout.write('\n✓ All courses synced.\n');

  await pullQuizzes({ fullPull: !argv.course });
})().catch(err => failCleanly(err, 'Pull failed.'));