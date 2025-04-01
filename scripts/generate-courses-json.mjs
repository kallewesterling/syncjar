import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

// __dirname workaround for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function slugify(text) {
  return text
    .toString()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

async function generateCoursesJson() {
  const exportedDir = path.join(__dirname, '..', 'local-skilljar');
  const outputPath = path.join(__dirname, '..', 'public', 'data', 'courses.json');
  const publicCoursesDir = path.join(__dirname, '..', 'public', 'courses');

  const courseDirs = await fs.readdir(exportedDir);
  const courseIndex = {};

  for (const courseSlug of courseDirs) {
    const coursePath = path.join(exportedDir, courseSlug);
    const detailsPath = path.join(coursePath, 'details.json');
    const metaPath = path.join(coursePath, 'lessons-meta.json');

    if (!(await fs.pathExists(detailsPath)) || !(await fs.pathExists(metaPath))) {
      console.warn(`⚠️ Skipping ${courseSlug}: missing details or lesson metadata`);
      continue;
    }

    const courseDetails = await fs.readJson(detailsPath);
    const lessonsMeta = await fs.readJson(metaPath);
    const courseTitle = courseDetails.title;

    courseIndex[courseTitle] = { Lessons: {} };

    for (const lesson of lessonsMeta.sort((a, b) => a.order - b.order)) {
      for (const item of lesson.content_items.sort((a, b) => a.order - b.order)) {
        const destPath = path.join(publicCoursesDir, courseSlug, 'lessons', lesson.slug);
        await fs.ensureDir(destPath);

        const srcFile = path.join(exportedDir, courseSlug, item.file);
        const fileName = path.basename(item.file);
        const finalPath = path.join(destPath, fileName);

        await fs.copyFile(srcFile, finalPath);

        const relativePath = path.relative(
          path.join(__dirname, '..', 'public'),
          finalPath
        ).replace(/\\/g, '/');

        const lessonKey = `${lesson.title} [${item.order}]`;
        courseIndex[courseTitle]["Lessons"][lessonKey] = relativePath;
      }
    }
  }

  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeJson(outputPath, courseIndex, { spaces: 2 });

  console.log('✅ Generated courses.json');
}

generateCoursesJson().catch(err => {
  console.error('❌ Error generating course index:', err);
});
