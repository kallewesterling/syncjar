import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { createSkilljarClient } from './skilljar-client.mjs';
import { slugify, readCourseDirIndex, resolveCourseDirName } from './course-dirs.mjs';

dotenv.config();

const argv = yargs(hideBin(process.argv))
  .option('course', {
    type: 'string',
    description: 'Only sync the course matching this slug (partial match, case-insensitive)'
  })
  .argv;

// ESM __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Axios client for Skilljar (auto-retries on 429/5xx, honouring Retry-After)
const client = createSkilljarClient();

// Fall back on the env var itself. `path.join(undefined, x) || fallback` throws
// inside path.join before `||` is ever read.
const contentPath = process.env.COURSE_CONTENT_PATH
  || path.join(__dirname, '..', 'local-skilljar');

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

// Fetch paginated courses
async function fetchCourses() {
  let allCourses = [];
  let page = 1;

  while (true) {
    const { data } = await client.get('/courses', {
      params: { page, page_size: 100 }
    });

    allCourses.push(...data.results);
    if (!data.next) break;
    page += 1;
  }

  return allCourses;
}

async function fetchLessons(courseId) {
  let allLessons = [];
  let page = 1;

  while (true) {
    const { data } = await client.get('/lessons', {
      params: { course_id: courseId, page, page_size: 100 }
    });

    allLessons.push(...data.results);
    if (!data.next) break;
    page += 1;
  }

  return allLessons;
}

async function fetchContentItems(lessonId) {
  const { data } = await client.get(`/lessons/${lessonId}/content-items`, {
    params: { include_content: true }
  });
  return data.results || [];
}

async function withConcurrency(items, limit, fn) {
  const executing = new Set();
  for (const item of items) {
    const p = fn(item).finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.allSettled([...executing]);
}

// Like items.map(fn) with Promise.all, but bounds how many run at once and
// preserves result order. Keeps us from firing hundreds of content-item
// requests in a single burst (which is what trips Skilljar's rate limit).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
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

  const [lessons] = await Promise.all([
    fetchLessons(course.id),
    fs.outputJson(path.join(exportDir, 'details.json'), course, { spaces: 2 })
  ]);

  const lessonMetaList = await mapWithConcurrency(lessons, LESSON_CONCURRENCY, async (lesson) => {
    const lessonSlug = `${lesson.order.toString().padStart(2, '0')}-${slugify(lesson.title)}`;
    const lessonFolder = path.join(lessonsDir, lessonSlug);

    const [contentItems] = await Promise.all([
      fetchContentItems(lesson.id),
      fs.ensureDir(lessonFolder)
    ]);

    // Write files for items that have HTML content from the API
    const contentItemsMeta = await Promise.all(
      contentItems.filter(i => i.content_html).map(async (item) => {
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

    return {
      id: lesson.id,
      slug: lessonSlug,
      title: lesson.title,
      order: lesson.order,
      description_html: lesson.description_html || '',
      content_items: [...contentItemsMeta, ...diskOnlyMeta]
    };
  });

  await fs.outputJson(path.join(exportDir, 'lessons-meta.json'), lessonMetaList, { spaces: 2 });
  table.setDone(dirName, lessons.length);
}

// MAIN
(async () => {
  let courses = await fetchCourses();

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
      `⚠️  Course id ${id} is in ${dirs.length} directories: ${dirs.join(', ')}. ` +
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

  process.stdout.write('\n🎉 All courses synced.\n');
})();