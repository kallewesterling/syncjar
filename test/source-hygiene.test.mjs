import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFiles() {
  const out = [];
  for (const dir of ['scripts', 'test']) {
    for (const name of await fs.readdir(path.join(root, dir))) {
      if (name.endsWith('.mjs')) out.push(path.join(dir, name));
    }
  }
  return out;
}

// A stray NUL is invisible in an editor and does not break the parser, so it
// survives review — but git classifies the file as binary and stops showing
// its diff entirely, which is how a 345-line change can reach a pull request
// as "Bin 0 -> 12264 bytes" with nothing to read. Both new modules in this
// repo picked one up before anyone noticed.
test('no source file contains a NUL byte', async () => {
  for (const rel of await sourceFiles()) {
    const buf = await fs.readFile(path.join(root, rel));
    assert.equal(buf.indexOf(0), -1, `${rel} contains a NUL byte at offset ${buf.indexOf(0)}`);
  }
});

// Anything else in the C0 range has the same effect on git and no legitimate
// use here. Tab, newline and carriage return are exempt.
test('no source file contains stray control characters', async () => {
  const allowed = new Set([0x09, 0x0a, 0x0d]);
  for (const rel of await sourceFiles()) {
    const buf = await fs.readFile(path.join(root, rel));
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b < 0x20 && !allowed.has(b)) {
        assert.fail(`${rel} has control byte 0x${b.toString(16)} at offset ${i}`);
      }
    }
  }
});
