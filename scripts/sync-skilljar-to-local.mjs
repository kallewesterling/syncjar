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

async function syncCourse(course) {
  const slug = slugify(course.title);
  const exportDir = path.join(process.env.COURSE_CONTENT_PATH, slug) || path.join(__dirname, '..', 'local-skilljar', slug);
  const lessonsDir = path.join(exportDir, 'lessons');

  console.log(`📦 Syncing course: ${course.title}`);

  // Write course details
  await fs.outputJson(path.join(exportDir, 'details.json'), course, { spaces: 2 });

  // Fetch lessons
  const lessons = await fetchLessons(course.id);
  const lessonMetaList = [];

  for (const lesson of lessons) {
    const lessonSlug = `${lesson.order.toString().padStart(2, '0')}-${slugify(lesson.title)}`;
    const lessonFolder = path.join(lessonsDir, lessonSlug);
    await fs.ensureDir(lessonFolder);

    const contentItems = await fetchContentItems(lesson.id);
    const contentItemsMeta = [];

    for (const item of contentItems.filter(i => i.content_html)) {
      const prefix = slugify(item.header) || "content"
      const filename = `${prefix}-${item.id}.html`;
      const relPath = path.join('lessons', lessonSlug, filename);
      const fullPath = path.join(exportDir, relPath);

      await fs.outputFile(fullPath, item.content_html || '');

      contentItemsMeta.push({
        id: item.id,
        file: relPath,
        order: item.order
      });
    }

    lessonMetaList.push({
      id: lesson.id,
      slug: lessonSlug,
      title: lesson.title,
      order: lesson.order,
      description_html: lesson.description_html || '',
      content_items: contentItemsMeta
    });
  }

  await fs.outputJson(path.join(exportDir, 'lessons-meta.json'), lessonMetaList, { spaces: 2 });
  console.log(`✅ Done: ${course.title} (${lessons.length} lessons)\n`);
}

// MAIN
(async () => {
  let courses = await fetchCourses();

  // Most recently updated first
  courses.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  if (argv.course) {
    const filter = argv.course.toLowerCase();
    courses = courses.filter(c => slugify(c.title).toLowerCase().includes(filter));
    if (courses.length === 0) {
      console.error(`No courses matched --course "${argv.course}"`);
      process.exit(1);
    }
  }

  for (const course of courses) {
    await syncCourse(course);
  }

  console.log('🎉 All courses synced locally.');
})();