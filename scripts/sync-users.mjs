import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createSkilljarClient } from './skilljar-client.mjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = yargs(hideBin(process.argv))
  .option('limit', { type: 'number', describe: 'Max number of users to process' })
  .option('dry-run', { type: 'boolean', default: false })
  .option('start-after', { type: 'string', describe: 'User ID to start after (for resuming)' })
  .help()
  .argv;

// Auto-retries on 429/5xx, honouring the server's Retry-After header.
const client = createSkilljarClient();

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
      console.log(`↪️ Already cached. Skipping fetch for ${userId}.`);
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

    // Build the merged file from every per-user record on disk, not from the
    // ones this run happened to fetch. A user whose cache file already existed
    // is skipped above to avoid re-fetching — but skipping the fetch must not
    // mean dropping them from the output. Writing `processed` here meant that
    // on any re-run the merged file held only the users touched that run, and
    // an audit reading a short file sees a clean result rather than an error.
    const merged = await readAllCachedUsers();
    await fs.writeJson(mergedPath, merged, { spaces: 2 });

    console.log(`✅ Saved flat user list: ${userListPath}`);
    console.log(`✅ Saved merged progress: ${mergedPath} (${merged.length} user(s))`);

    // --limit and --start-after deliberately cut the run short, and a user who
    // has never been fetched has no cache file to merge, so say plainly that
    // the merged file is not the whole population.
    const expected = users.filter((e) => e.user?.id).length;
    if (merged.length < expected) {
      console.warn(`⚠️ ${mergedPath} covers ${merged.length} of ${expected} users.`);
      console.warn('   Re-run without --limit/--start-after for a complete file.');
    }
  } else {
    console.log('💡 Dry run mode: no files written.');
  }

  console.log(`🎉 Sync complete. Fetched ${processed.length} user(s) this run.`);
}

// The per-user files are the durable record; the merged file is a view over
// them. Reading them back keeps the two consistent no matter how many partial
// or resumed runs it took to build the cache up.
export async function readAllCachedUsers(dir = perUserDir) {
  if (!(await fs.pathExists(dir))) return [];

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  const records = [];

  for (const file of files) {
    try {
      records.push(await fs.readJson(path.join(dir, file)));
    } catch (err) {
      // A truncated file from an interrupted write would otherwise take the
      // whole export down with it. Name it and move on.
      console.warn(`⚠️ Skipping unreadable cache file ${file}: ${err.message}`);
    }
  }

  return records;
}

// Only sync when run directly, so the merge logic above can be imported by the
// tests without kicking off thousands of API calls.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncUsers().catch(err => {
    console.error('❌ Sync failed:', err.message);
  });
}
