import http from 'http';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, '..', 'public');
const configPath = path.join(__dirname, '..', 'preview.config.json');
const courseContentPath = process.env.COURSE_CONTENT_PATH || path.join(__dirname, '..', 'local-skilljar');

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

async function readConfig() {
  try {
    return await fs.readJson(configPath);
  } catch {
    return { theme: { css: [], js: [] } };
  }
}

async function buildCourseIndex() {
  const index = {};

  let slugs;
  try {
    slugs = await fs.readdir(courseContentPath);
  } catch {
    return index;
  }

  await Promise.all(slugs.map(async (slug) => {
    const detailsPath = path.join(courseContentPath, slug, 'details.json');
    const metaPath    = path.join(courseContentPath, slug, 'lessons-meta.json');

    if (!(await fs.pathExists(detailsPath)) || !(await fs.pathExists(metaPath))) return;

    try {
      const [details, lessons] = await Promise.all([
        fs.readJson(detailsPath),
        fs.readJson(metaPath),
      ]);

      const lessonEntries = {};
      for (const lesson of lessons.sort((a, b) => a.order - b.order)) {
        let items = (lesson.content_items || [])
          .sort((a, b) => a.order - b.order)
          .map(item => `/course-content/${slug}/lessons/${lesson.slug}/${path.basename(item.file)}`);

        // Fallback: if meta has no content items, scan the folder directly
        if (items.length === 0) {
          const lessonDir = path.join(courseContentPath, slug, 'lessons', lesson.slug);
          try {
            const files = (await fs.readdir(lessonDir))
              .filter(f => f.endsWith('.html'))
              .sort();
            items = files.map(f => `/course-content/${slug}/lessons/${lesson.slug}/${f}`);
          } catch {
            // folder missing — leave empty
          }
        }

        lessonEntries[lesson.title] = items;
      }

      index[details.title] = { Lessons: lessonEntries };
    } catch (err) {
      console.warn(`⚠️  Skipping ${slug}: ${err.message}`);
    }
  }));

  return index;
}

async function serveFile(filePath, res) {
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    console.log(`→ ${req.method} ${url.pathname}`);

    // Preview config
    if (url.pathname === '/preview-config.json') {
      const config = await readConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
      return;
    }

    // Dynamic course index — reads COURSE_CONTENT_PATH live on every request
    if (url.pathname === '/api/courses') {
      const index = await buildCourseIndex();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(index));
      return;
    }

    // Course content files served directly from COURSE_CONTENT_PATH
    if (url.pathname.startsWith('/course-content/')) {
      const rel = url.pathname.slice('/course-content/'.length);
      await serveFile(path.join(courseContentPath, rel), res);
      return;
    }

    // Static files from public/
    let filePath = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);

    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    await serveFile(filePath, res);

  } catch (err) {
    console.error(`❌ ${req.method} ${req.url} — ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n🔍 Preview server running at http://localhost:${PORT}`);
  console.log(`   Courses: ${courseContentPath}`);
  console.log(`   Config:  ${configPath}\n`);
});
