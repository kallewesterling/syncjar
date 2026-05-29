import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';

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

// Axios client for Skilljar
const client = axios.create({
  baseURL: 'https://api.skilljar.com/v1',
  auth: {
    username: process.env.SKILLJAR_API_KEY,
    password: ''
  }
});

// Slugify helper
function slugify(text) {
  return text
    .toString()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class SyncTable {
  constructor(courses) {
    this.rows = courses.map(c => ({ title: c.title, status: 'pending', lessons: null, frame: 0 }));
    this.titleWidth = Math.max(...courses.map(c => c.title.length), 'Course'.length);
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

  setStarted(title) {
    const row = this.rows.find(r => r.title === title);
    if (row) row.status = 'syncing';
  }

  setDone(title, lessons) {
    const row = this.rows.find(r => r.title === title);
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

async function syncCourse(course, table) {
  const slug = slugify(course.title);
  const exportDir = path.join(process.env.COURSE_CONTENT_PATH, slug) || path.join(__dirname, '..', 'local-skilljar', slug);
  const lessonsDir = path.join(exportDir, 'lessons');
  table.setStarted(course.title);

  const [lessons] = await Promise.all([
    fetchLessons(course.id),
    fs.outputJson(path.join(exportDir, 'details.json'), course, { spaces: 2 })
  ]);

  const lessonMetaList = await Promise.all(lessons.map(async (lesson) => {
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
  }));

  await fs.outputJson(path.join(exportDir, 'lessons-meta.json'), lessonMetaList, { spaces: 2 });
  table.setDone(course.title, lessons.length);
}

// MAIN
(async () => {
  let courses = await fetchCourses();

  // Deduplicate by slug — the API sometimes returns two courses with the same
  // title (different IDs). Keep the most recently modified of each pair.
  const bySlug = new Map();
  for (const c of courses) {
    const slug = slugify(c.title);
    const existing = bySlug.get(slug);
    if (!existing || new Date(c.modified_at) > new Date(existing.modified_at)) {
      bySlug.set(slug, c);
    }
  }
  courses = [...bySlug.values()];

  // Most recently updated first
  courses.sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));

  if (argv.course) {
    const filter = argv.course.toLowerCase();
    courses = courses.filter(c => slugify(c.title).toLowerCase().includes(filter));
    if (courses.length === 0) {
      console.error(`No courses matched --course "${argv.course}"`);
      process.exit(1);
    }
  }

  const table = new SyncTable(courses);
  table.start();

  await withConcurrency(courses, 3, course => syncCourse(course, table));

  process.stdout.write('\n🎉 All courses synced.\n');
})();