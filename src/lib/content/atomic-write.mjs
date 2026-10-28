/**
 * atomic-write.mjs — write a file so that an interrupted run leaves the old
 * file or the new one, never a partial or empty one.
 *
 * `fs.writeFile`, and fs-extra's `outputFile`, `outputJson` and `writeJson`
 * on top of it, open the target with O_TRUNC and then write. Pull used them
 * for every file. A Ctrl+C between the open and the write left the file
 * empty, and git shows that as an ordinary edit deleting every line: easy to
 * commit, and a push of that commit would empty the live lesson.
 *
 * So the data goes to a temp file in the target's directory, which keeps it
 * on the same filesystem so the rename is atomic. The temp file is flushed,
 * then renamed over the target.
 *
 * A temp file is named `.<target name>.syncjar-<12 hex>.tmp`: a dotfile,
 * which glob skips by default, ending in `.tmp`, which no content reader
 * matches (they all filter on `.html` or `.json`). A run killed outright
 * still leaves one behind, so pulls call removeStrayTempFiles() first.
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const TEMP_FILE = /^\..+\.syncjar-[0-9a-f]{12}\.tmp$/;

export function tempPathFor(target) {
  const suffix = crypto.randomBytes(6).toString('hex');
  return path.join(path.dirname(target), `.${path.basename(target)}.syncjar-${suffix}.tmp`);
}

export function isTempFile(name) {
  return TEMP_FILE.test(path.basename(name));
}

/**
 * Writes `data` to `target` atomically, creating its directory if needed.
 * `ops` swaps the filesystem calls, so tests can fail one partway.
 */
export async function writeFileAtomic(target, data, ops = fs) {
  await ops.mkdir(path.dirname(target), { recursive: true });
  const tmp = tempPathFor(target);
  try {
    await ops.writeFile(tmp, data, { flush: true });
    await ops.rename(tmp, target);
  } catch (err) {
    await ops.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Byte-for-byte what fs-extra's `outputJson(file, value, { spaces: 2 })` wrote. */
export function writeJsonAtomic(target, value, ops = fs) {
  return writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, ops);
}

/**
 * Removes temp files left under `dir` by a run that was killed before it
 * could rename or remove them. Returns their paths. A missing `dir` has none.
 */
export async function removeStrayTempFiles(dir) {
  let names;
  try {
    names = await fs.readdir(dir, { recursive: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const stray = names.filter(isTempFile).map(name => path.join(dir, name));
  await Promise.all(stray.map(file => fs.rm(file, { force: true })));
  return stray;
}
