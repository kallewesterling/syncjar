import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import {
  slugify,
  listCourseDirs,
  readCourseDirIndex,
  resolveCourseDirName
} from '../scripts/course-dirs.mjs';

// Builds a throwaway content path. `tree` maps a directory name to the object
// written as its details.json, to a raw string written verbatim, or to null for
// a directory with no details.json at all.
async function makeTree(tree, files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncjar-test-'));
  for (const [dir, details] of Object.entries(tree)) {
    await fs.ensureDir(path.join(root, dir));
    if (details === null) continue;
    const target = path.join(root, dir, 'details.json');
    if (typeof details === 'string') await fs.writeFile(target, details);
    else await fs.writeJson(target, details);
  }
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), body);
  }
  return root;
}

test('listCourseDirs ignores non-directories and dotfiles', async () => {
  const root = await makeTree(
    { 'Crush-your-CVEs': { id: 'a1' }, '.git': null, '.cache': null },
    { 'course-urls.json': '{}', 'course-keywords.json': '{}' }
  );
  assert.deepEqual(await listCourseDirs(root), ['Crush-your-CVEs']);
});

test('listCourseDirs returns empty for a missing content path', async () => {
  assert.deepEqual(await listCourseDirs('/no/such/path/anywhere'), []);
});

// This is the regression the fix exists for. On courses@6d363fd8 the pull wrote
// courses/Build-your-first-Chainguard-container next to the existing
// courses/Build-Your-First-Chainguard-Container, both holding id 3j1nxo2spsxv2.
test('an existing course id keeps its directory name after a title change', async () => {
  const root = await makeTree({
    'Build-Your-First-Chainguard-Container': { id: '3j1nxo2spsxv2', title: 'Build Your First Chainguard Container' }
  });
  const index = await readCourseDirIndex(root);

  const dirName = resolveCourseDirName(index, {
    id: '3j1nxo2spsxv2',
    title: 'Build your first Chainguard container'
  });

  assert.equal(dirName, 'Build-Your-First-Chainguard-Container');
  assert.notEqual(dirName, slugify('Build your first Chainguard container'));
});

test('a course id new to the tree is named from its title', async () => {
  const root = await makeTree({ 'Crush-your-CVEs': { id: 'a1' } });
  const index = await readCourseDirIndex(root);

  assert.equal(
    resolveCourseDirName(index, { id: 'new1', title: 'Registry Rockstar' }),
    'Registry-Rockstar'
  );
});

test('a duplicated course id resolves to one directory and is reported', async () => {
  const root = await makeTree({
    'Zebra-course': { id: 'dup', title: 'Zebra course' },
    'Alpha-course': { id: 'dup', title: 'Alpha course' }
  });
  const index = await readCourseDirIndex(root);

  // First in sort order wins, so the choice is stable between runs.
  assert.equal(index.byId.get('dup'), 'Alpha-course');
  assert.deepEqual(index.duplicates.get('dup'), ['Alpha-course', 'Zebra-course']);
  assert.equal(resolveCourseDirName(index, { id: 'dup', title: 'Zebra course' }), 'Alpha-course');
});

test('directories without a usable course id are ignored but keep their names', async () => {
  const root = await makeTree({
    'No-details': null,
    'No-id': { title: 'Has no id field' },
    'Bad-json': 'this is not json',
    'Null-id': { id: null, title: 'Null id' },
    'Empty-id': { id: '', title: 'Empty id' }
  });
  const index = await readCourseDirIndex(root);

  assert.equal(index.byId.size, 0);
  assert.deepEqual(
    index.unidentified,
    ['Bad-json', 'Empty-id', 'No-details', 'No-id', 'Null-id']
  );

  // The name is still occupied on disk, so a new course must not claim it.
  const dirName = resolveCourseDirName(index, { id: 'new1', title: 'No details' });
  assert.equal(dirName, 'No-details-new1');
});

test('a new name that collides case-insensitively gets the course id appended', async () => {
  const root = await makeTree({ 'Registry-Rockstar': { id: 'a1', title: 'Registry Rockstar' } });
  const index = await readCourseDirIndex(root);

  // A different course, same title in different case. macOS would treat
  // "Registry-rockstar" and "Registry-Rockstar" as one directory.
  assert.equal(
    resolveCourseDirName(index, { id: 'b2', title: 'Registry rockstar' }),
    'Registry-rockstar-b2'
  );
});

test('two new courses sharing a title get separate directories', async () => {
  const root = await makeTree({});
  const index = await readCourseDirIndex(root);

  const first = resolveCourseDirName(index, { id: 'x1', title: 'Migration Guidance' });
  const second = resolveCourseDirName(index, { id: 'x2', title: 'Migration Guidance' });

  assert.equal(first, 'Migration-Guidance');
  assert.equal(second, 'Migration-Guidance-x2');
  assert.notEqual(first.toLowerCase(), second.toLowerCase());
});

test('resolving the same course twice returns the same directory', async () => {
  const root = await makeTree({});
  const index = await readCourseDirIndex(root);
  const course = { id: 'x1', title: 'Migration Guidance' };

  assert.equal(resolveCourseDirName(index, course), resolveCourseDirName(index, course));
});

test('a title that slugifies to nothing falls back to the course id', async () => {
  const root = await makeTree({});
  const index = await readCourseDirIndex(root);

  assert.equal(resolveCourseDirName(index, { id: 'x1', title: '???' }), 'x1');
  assert.equal(resolveCourseDirName(index, { id: 'x2', title: undefined }), 'x2');
});
