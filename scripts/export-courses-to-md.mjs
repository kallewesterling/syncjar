import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { htmlToText } from 'html-to-text';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const exportDir = path.resolve(process.env.COURSE_CONTENT_PATH || path.join(__dirname, '..', 'local-skilljar'));
const outputDir = path.resolve('./courses-plaintext');

await fs.ensureDir(outputDir);

function stripExtension(filename) {
    return filename.replace(/\.html$/, '');
}

async function processCourse(courseFolder) {
    const coursePath = path.join(exportDir, courseFolder);
    const detailsPath = path.join(coursePath, 'details.json');
    const lessonsMetaPath = path.join(coursePath, 'lessons-meta.json');

    if (!(await fs.pathExists(detailsPath)) || !(await fs.pathExists(lessonsMetaPath))) {
        console.warn(`⚠️ Skipping ${courseFolder}, missing metadata`);
        return;
    }

    const course = await fs.readJson(detailsPath);
    const lessons = await fs.readJson(lessonsMetaPath);

    let output = `# ${course.title}\n\n`;

    for (const lesson of lessons.sort((a, b) => a.order - b.order)) {
        output += `## ${lesson.order.toString().padStart(2, '0')} – ${lesson.title}\n\n`;

        for (const item of lesson.content_items.sort((a, b) => a.order - b.order)) {
            const contentPath = path.join(coursePath, item.file);
            if (!(await fs.pathExists(contentPath))) continue;

            const rawHtml = await fs.readFile(contentPath, 'utf8');
            const plainText = htmlToText(rawHtml, {
                wordwrap: false,
                baseElements: { selectors: ['body'] },
                selectors: [
                    {
                        selector: 'a',
                        options: {
                            format: 'inlineLink',
                        },
                    },
                    {
                        selector: 'img',
                        options: {
                            format: 'inline',
                        },
                    },
                ],
                options: {
                    uppercase: false,
                }
            });

            const header = stripExtension(path.basename(item.file));
            // output += `### ${header}\n\n${plainText.trim()}\n\n`;
            output += `${plainText.trim()}\n\n`;
        }
    }

    const outputPath = path.join(outputDir, `${courseFolder}.md`);
    await fs.writeFile(outputPath, output, 'utf8');
    console.log(`✅ Wrote: ${outputPath}`);
}

// MAIN
const courseFolders = await fs.readdir(exportDir);
for (const folder of courseFolders) {
    const stats = await fs.stat(path.join(exportDir, folder));
    if (stats.isDirectory()) {
        await processCourse(folder);
    }
}

console.log('📚 All courses exported to Markdown.');
