import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = yargs(hideBin(process.argv))
  .option('limit', { type: 'number', describe: 'Max number of users to process' })
  .option('dry-run', { type: 'boolean', default: false })
  .option('start-after', { type: 'string', describe: 'User ID to start after (for resuming)' })
  .help()
  .argv;

const client = axios.create({
  baseURL: 'https://api.skilljar.com/v1',
  auth: {
    username: process.env.SKILLJAR_API_KEY,
    password: ''
  }
});

const outputDir = path.join(__dirname, '..', 'public', 'data');
const userListPath = path.join(outputDir, 'users.json');
const perUserDir = path.join(outputDir, 'user-progress');
const mergedPath = path.join(outputDir, 'user-progress.json');

async function fetchPaginated(endpoint, params = {}, pageSize = 100) {
    let page = 1;
    let allResults = [];
  
    while (true) {
      const res = await client.get(endpoint, {
        params: { ...params, page, page_size: pageSize }
      });
  
      const data = res.data;
  
      if (Array.isArray(data.results)) {
        allResults.push(...data.results);
      } else if (Array.isArray(data)) {
        // Some endpoints might return raw arrays
        allResults.push(...data);
        break;
      } else if (Object.keys(data).length === 0) {
        console.warn(`⚠️ Empty response from ${endpoint}. Skipping.`);
        break;
      } else {
        console.warn(`⚠️ Unexpected response from ${endpoint}:\n`, data);
        break;
      }
  
      console.log(`📦 Fetched ${allResults.length} items from ${endpoint}`);

      if (!data.next) break;
      page += 1;
    }
  
    return allResults;
  }
  
async function fetchLessonProgress(userId, publishedCourseId) {
  const endpoint = `/users/${userId}/published-courses/${publishedCourseId}/lessons`;
  return await fetchPaginated(endpoint, {}, 100);
}

async function fetchCourseProgress(userId) {
  const courses = await fetchPaginated(`/users/${userId}/published-courses`, {}, 1000);

  for (const course of courses) {
    const lessons = await fetchLessonProgress(userId, course.published_course_id);
    course.lessons = lessons;
  }

  return courses;
}

async function syncUsers() {
  console.log('🔄 Syncing users and course progress...');
  await fs.ensureDir(perUserDir);

  const users = await fetchPaginated('/users', {}, 100);
  const processed = [];
  let skipping = !!argv['start-after'];
  let count = 0;

  for (const entry of users) {
    const userData = entry.user;
    const userId = userData?.id;
    const userEmail = userData?.email || 'unknown';

    if (!userId) {
      console.warn(`⚠️ Skipping entry with missing user ID:`, entry);
      continue;
    }

    if (argv['start-after'] && skipping) {
      if (userId === argv['start-after']) {
        skipping = false;
      }
      continue;
    }

    if (argv.limit && count >= argv.limit) break;

    console.log(`👤 Processing ${userEmail} (${userId})...`);

    const userFile = path.join(perUserDir, `${userId}.json`);
    if (!argv.dryRun && await fs.pathExists(userFile)) {
      console.log(`↪️ Already processed. Skipping ${userId}.`);
      continue;
    }

    try {
      const courses = await fetchCourseProgress(userId);

      const fullUserRecord = {
        id: userId,
        email: userEmail,
        name: `${userData.first_name || ''} ${userData.last_name || ''}`.trim(),
        signed_up_at: entry.signed_up_at,
        latest_activity: entry.latest_activity,
        courses
      };

      if (!argv.dryRun) {
        await fs.writeJson(userFile, fullUserRecord, { spaces: 2 });
      }

      processed.push(fullUserRecord);
      count += 1;
    } catch (err) {
      console.error(`❌ Failed to process ${userEmail} (${userId}):`, err.message);
    }
  }

  if (!argv.dryRun) {
    await fs.writeJson(userListPath, users, { spaces: 2 });
    await fs.writeJson(mergedPath, processed, { spaces: 2 });

    console.log(`✅ Saved flat user list: ${userListPath}`);
    console.log(`✅ Saved merged progress: ${mergedPath}`);
  } else {
    console.log('💡 Dry run mode: no files written.');
  }

  console.log(`🎉 Sync complete. Processed ${processed.length} user(s).`);
}

syncUsers().catch(err => {
  console.error('❌ Sync failed:', err.message);
});
