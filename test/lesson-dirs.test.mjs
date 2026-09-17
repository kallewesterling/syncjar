import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import {
  readLessonDirIndex,
  resolveLessonDirName
} from '../scripts/lesson-dirs.mjs';

// Builds a throwaway course directory. `lessonsMeta` is written verbatim as
// lessons-meta.json, or omitted for a course with none yet.
async function makeCourseDir(lessonsMeta) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncjar-lesson-test-'));
  if (lessonsMeta !== undefined) {
    await fs.writeJson(path.join(root, 'lessons-meta.json'), lessonsMeta);
  }
  return root;
}

test('readLessonDirIndex returns empty maps when lessons-meta.json is missing', async () => {
  const root = await makeCourseDir();
  const index = await readLessonDirIndex(root);
  assert.equal(index.byId.size, 0);
  assert.equal(index.takenLower.size, 0);
});

test('readLessonDirIndex returns empty maps for malformed lessons-meta.json', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncjar-lesson-test-'));
  await fs.writeFile(path.join(root, 'lessons-meta.json'), 'not json');
  const index = await readLessonDirIndex(root);
  assert.equal(index.byId.size, 0);
});

// This is the regression the fix exists for. Re-casing or rewording a lesson
// title in Skilljar used to create a second lesson directory next to the
// existing one, both holding the same lesson id.
test('an existing lesson id keeps its directory name after a title change', async () => {
  const root = await makeCourseDir([
    { id: 'lesson-a', slug: '30-Introduction-to-Package-Repositories', title: 'Introduction to Package Repositories', order: 30 }
  ]);
  const index = await readLessonDirIndex(root);

  const dirName = resolveLessonDirName(index, {
    id: 'lesson-a',
    title: 'Introduction to package repositories', // re-cased upstream
    order: 30
  });

  assert.equal(dirName, '30-Introduction-to-Package-Repositories');
});

test('an existing lesson id keeps its directory name even if reordered', () => {
  const index = { byId: new Map([['lesson-a', '30-Some-Lesson']]), takenLower: new Map([['30-some-lesson', '30-Some-Lesson']]) };
  const dirName = resolveLessonDirName(index, { id: 'lesson-a', title: 'Some Lesson', order: 50 });
  assert.equal(dirName, '30-Some-Lesson');
});

test('a lesson id new to the course is named from its order and title', async () => {
  const root = await makeCourseDir([
    { id: 'lesson-a', slug: '10-First-Lesson', title: 'First Lesson', order: 10 }
  ]);
  const index = await readLessonDirIndex(root);

  assert.equal(
    resolveLessonDirName(index, { id: 'lesson-b', title: 'Second Lesson', order: 20 }),
    '20-Second-Lesson'
  );
});

test('a new name that collides case-insensitively gets the lesson id appended', () => {
  const index = { byId: new Map([['lesson-a', '10-Overview']]), takenLower: new Map([['10-overview', '10-Overview']]) };

  // A different lesson, same order and title in different case.
  assert.equal(
    resolveLessonDirName(index, { id: 'lesson-b', title: 'overview', order: 10 }),
    '10-overview-lesson-b'
  );
});

test('two new lessons sharing an order and title get separate directories', () => {
  const index = { byId: new Map(), takenLower: new Map() };

  const first = resolveLessonDirName(index, { id: 'lesson-a', title: 'Wrap Up', order: 90 });
  const second = resolveLessonDirName(index, { id: 'lesson-b', title: 'Wrap Up', order: 90 });

  assert.equal(first, '90-Wrap-Up');
  assert.equal(second, '90-Wrap-Up-lesson-b');
  assert.notEqual(first.toLowerCase(), second.toLowerCase());
});

test('resolving the same lesson twice returns the same directory', () => {
  const index = { byId: new Map(), takenLower: new Map() };
  const lesson = { id: 'lesson-a', title: 'Wrap Up', order: 90 };
  assert.equal(resolveLessonDirName(index, lesson), resolveLessonDirName(index, lesson));
});

test('a title that slugifies to nothing falls back to the lesson id', () => {
  const index = { byId: new Map(), takenLower: new Map() };
  assert.equal(resolveLessonDirName(index, { id: 'lesson-a', title: '???', order: 5 }), '05-lesson-a');
  assert.equal(resolveLessonDirName(index, { id: 'lesson-b', title: undefined, order: 6 }), '06-lesson-b');
});
