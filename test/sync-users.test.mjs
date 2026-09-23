import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { readAllCachedUsers } from '../scripts/sync-users.mjs';

// Builds a throwaway user-progress cache. `records` maps a user id to the
// object written as that user's JSON file, or to a raw string written
// verbatim (for the truncated-file case).
async function makeCache(records, extras = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncjar-users-'));
  for (const [id, record] of Object.entries(records)) {
    const target = path.join(dir, `${id}.json`);
    if (typeof record === 'string') await fs.writeFile(target, record);
    else await fs.writeJson(target, record);
  }
  for (const [name, body] of Object.entries(extras)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

const user = (id) => ({ id, email: `${id}@example.com`, courses: [] });

// The regression this file exists for. The merged progress file used to be
// written from the users fetched in that run, and a user whose cache file
// already existed was skipped without being counted — so a second run wrote a
// file containing nobody. Reading the cache back makes a re-run that fetches
// nothing still produce the complete list.
test('a re-run that fetches nobody still yields every cached user', async () => {
  const dir = await makeCache({ u1: user('u1'), u2: user('u2'), u3: user('u3') });
  const merged = await readAllCachedUsers(dir);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((u) => u.id).sort(), ['u1', 'u2', 'u3']);
});

test('records survive the round trip intact', async () => {
  const record = {
    id: 'u1',
    email: 'u1@example.com',
    name: 'Ada Lovelace',
    courses: [{ published_course_id: 'pc1', lessons: [{ id: 'l1', completed: true }] }]
  };
  const dir = await makeCache({ u1: record });
  assert.deepEqual(await readAllCachedUsers(dir), [record]);
});

// An interrupted write leaves a truncated file behind. Taking the whole export
// down for one bad file would be worse than reporting it and continuing, since
// the remaining users are still wanted.
test('a truncated cache file is skipped rather than failing the export', async () => {
  const dir = await makeCache({ u1: user('u1'), u2: '{"id": "u2", "cour', u3: user('u3') });
  const merged = await readAllCachedUsers(dir);
  assert.deepEqual(merged.map((u) => u.id).sort(), ['u1', 'u3']);
});

test('non-JSON files in the cache directory are ignored', async () => {
  const dir = await makeCache({ u1: user('u1') }, { '.DS_Store': 'junk', 'notes.txt': 'hi' });
  assert.deepEqual(await readAllCachedUsers(dir), [user('u1')]);
});

test('a missing cache directory yields no users rather than throwing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncjar-users-'));
  assert.deepEqual(await readAllCachedUsers(path.join(dir, 'nope')), []);
});
