import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fsp from 'fs/promises';
import fse from 'fs-extra';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  writeFileAtomic,
  writeJsonAtomic,
  removeStrayTempFiles,
  isTempFile,
  tempPathFor
} from '#lib/content/atomic-write.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = pathToFileURL(path.join(root, 'src/lib/content/atomic-write.mjs')).href;

const ORIGINAL = '<p>The lesson as it was before this pull.</p>\n';
const UPDATED = '<p>The lesson as Skilljar has it now.</p>\n';

async function lessonDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncjar-atomic-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'content-abc123.html');
  await fsp.writeFile(target, ORIGINAL);
  return { dir, target };
}

// Runs `body` in a child process that SIGKILLs itself at the point given,
// which is what Ctrl+C or a cancelled CI job does to a pull.
function runAndKill(body) {
  const script = `
    import fs from 'fs';
    import fsp from 'fs/promises';
    import { writeFileAtomic } from ${JSON.stringify(moduleUrl)};
    const die = () => process.kill(process.pid, 'SIGKILL');
    ${body}
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
}

test('replaces the file and leaves no temp file behind', async (t) => {
  const { dir, target } = await lessonDir(t);
  await writeFileAtomic(target, UPDATED);
  assert.equal(await fsp.readFile(target, 'utf8'), UPDATED);
  assert.deepEqual(await fsp.readdir(dir), ['content-abc123.html']);
});

test('creates missing directories, as outputFile did', async (t) => {
  const { dir } = await lessonDir(t);
  const target = path.join(dir, 'lessons', '010-intro', 'content-new.html');
  await writeFileAtomic(target, UPDATED);
  assert.equal(await fsp.readFile(target, 'utf8'), UPDATED);
});

test('JSON is byte-for-byte what fs-extra wrote, so a pull causes no churn', async (t) => {
  const { dir } = await lessonDir(t);
  const value = { id: 'abc', title: 'Sample', nested: [{ a: 1 }, { b: 'two' }], empty: [] };
  await fse.outputJson(path.join(dir, 'old.json'), value, { spaces: 2 });
  await writeJsonAtomic(path.join(dir, 'new.json'), value);
  assert.equal(await fsp.readFile(path.join(dir, 'new.json'), 'utf8'), await fsp.readFile(path.join(dir, 'old.json'), 'utf8'));
});

test('a write that fails partway leaves the original file intact, and cleans up', async (t) => {
  const { dir, target } = await lessonDir(t);
  const ops = {
    ...fsp,
    async writeFile(file, data) {
      await fsp.writeFile(file, data.slice(0, 5));
      throw Object.assign(new Error('interrupted'), { code: 'EINTR' });
    }
  };
  await assert.rejects(writeFileAtomic(target, UPDATED, ops), /interrupted/);
  assert.equal(await fsp.readFile(target, 'utf8'), ORIGINAL);
  assert.deepEqual(await fsp.readdir(dir), ['content-abc123.html']);
});

test('a failed rename leaves the original file intact, and cleans up', async (t) => {
  const { dir, target } = await lessonDir(t);
  const ops = { ...fsp, rename: async () => { throw new Error('rename failed'); } };
  await assert.rejects(writeFileAtomic(target, UPDATED, ops), /rename failed/);
  assert.equal(await fsp.readFile(target, 'utf8'), ORIGINAL);
  assert.deepEqual(await fsp.readdir(dir), ['content-abc123.html']);
});

// The control for the test below: without it, that test would pass just as
// well if killing the child somehow never touched the target.
test('a process killed after opening a file for writing leaves it empty (the old write path)', async (t) => {
  const { target } = await lessonDir(t);
  const result = runAndKill(`fs.openSync(${JSON.stringify(target)}, 'w'); die();`);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal((await fsp.stat(target)).size, 0);
});

test('a process killed mid-write leaves the original file intact, and the next run removes the temp file', async (t) => {
  const { dir, target } = await lessonDir(t);
  // Killed with the temp file fully written but not yet renamed: the last
  // moment at which an interrupt could do damage.
  const result = runAndKill(`
    await writeFileAtomic(${JSON.stringify(target)}, ${JSON.stringify(UPDATED)}, { ...fsp, rename: die });
  `);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(await fsp.readFile(target, 'utf8'), ORIGINAL);

  const left = (await fsp.readdir(dir)).filter(n => n !== 'content-abc123.html');
  assert.equal(left.length, 1);
  const [stray] = left;
  // It can't be mistaken for content: every content reader filters on
  // .html or .json, and glob skips dotfiles.
  assert.ok(stray.startsWith('.'));
  assert.ok(!stray.endsWith('.html') && !stray.endsWith('.json'));
  assert.ok(isTempFile(stray));

  assert.deepEqual(await removeStrayTempFiles(dir), [path.join(dir, stray)]);
  assert.deepEqual(await fsp.readdir(dir), ['content-abc123.html']);
  assert.equal(await fsp.readFile(target, 'utf8'), ORIGINAL);
});

test('removeStrayTempFiles finds temp files at any depth, and nothing else', async (t) => {
  const { dir } = await lessonDir(t);
  const nested = path.join(dir, 'Some-course', 'lessons', '010-intro');
  await fsp.mkdir(nested, { recursive: true });
  const strays = [
    tempPathFor(path.join(nested, 'content-x.html')),
    tempPathFor(path.join(dir, 'Some-course', 'lessons-meta.json'))
  ];
  const keep = [
    path.join(nested, 'content-x.html'),
    path.join(nested, '.DS_Store'),
    path.join(nested, 'notes.tmp'),
    path.join(nested, '.content-x.html.syncjar-nothex.tmp')
  ];
  for (const file of [...strays, ...keep]) await fsp.writeFile(file, 'x');

  assert.deepEqual((await removeStrayTempFiles(dir)).sort(), strays.sort());
  for (const file of keep) assert.ok(await fse.pathExists(file), `${file} should be kept`);
});

test('removeStrayTempFiles on a missing directory finds nothing', async () => {
  assert.deepEqual(await removeStrayTempFiles(path.join(os.tmpdir(), 'syncjar-no-such-dir-xyz')), []);
});
