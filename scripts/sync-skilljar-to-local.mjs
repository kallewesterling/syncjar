import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

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
  const { data } = await client.get(`/lessons/${lessonId}/content-items`);
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

async function syncCourse(course, progress) {
  const slug = slugify(course.title);
  const exportDir = path.join(process.env.COURSE_CONTENT_PATH, slug) || path.join(__dirname, '..', 'local-skilljar', slug);
  const lessonsDir = path.join(exportDir, 'lessons');

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

    const contentItemsMeta = await Promise.all(
      contentItems.filter(i => i.content_html).map(async (item) => {
        const prefix = slugify(item.header) || 'content';
        const filename = `${prefix}-${item.id}.html`;
        const relPath = path.join('lessons', lessonSlug, filename);
        await fs.outputFile(path.join(exportDir, relPath), item.content_html || '');
        return { id: item.id, file: relPath, order: item.order };
      })
    );

    return {
      id: lesson.id,
      slug: lessonSlug,
      title: lesson.title,
      order: lesson.order,
      description_html: lesson.description_html || '',
      content_items: contentItemsMeta
    };
  }));

  await fs.outputJson(path.join(exportDir, 'lessons-meta.json'), lessonMetaList, { spaces: 2 });

  const done = ++progress.done;
  const width = progress.total.toString().length;
  console.log(`[${done.toString().padStart(width)}/${progress.total}] ✅ ${course.title} (${lessons.length} lessons)`);
}

// MAIN
(async () => {
  let courses = await fetchCourses();

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

  const progress = { done: 0, total: courses.length };
  console.log(`Syncing ${courses.length} course${courses.length === 1 ? '' : 's'}...\n`);

  await withConcurrency(courses, 3, course => syncCourse(course, progress));

  console.log('\n🎉 All courses synced.');
})();