import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  CHECKOUT_ONLY,
  commandTable,
  configDir,
  envFiles,
  githubRepo,
  installSpec,
  layeredEnv,
  providesCommand,
  rawPackageUrl
} from '#lib/cli.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('every npm script that runs a command becomes a subcommand, and test does not', () => {
  const table = commandTable(pkg.scripts);
  assert.deepEqual(table.get('push:quizzes'), ['src/commands/push/quizzes.mjs']);
  assert.deepEqual(table.get('build:preview'), [
    'src/commands/pull/index.mjs',
    'src/commands/generate/courses.mjs'
  ]);
  assert.equal(table.has('test'), false);
  for (const files of table.values()) {
    for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), `${file} does not exist`);
  }
  for (const name of CHECKOUT_ONLY) assert.ok(table.has(name), `${name} is not a script`);
});

test('a composite script with an unknown step is not a subcommand', () => {
  const table = commandTable({ a: 'node src/commands/a.mjs', b: 'npm run a && npm run missing', c: 'npm run c' });
  assert.deepEqual([...table.keys()], ['a']);
});

test('the user config dir follows XDG, then ~/.config, and APPDATA on Windows', () => {
  assert.equal(configDir({ env: { XDG_CONFIG_HOME: '/x' }, platform: 'darwin', home: '/h' }), path.join('/x', 'syncjar'));
  assert.equal(configDir({ env: {}, platform: 'linux', home: '/h' }), path.join('/h', '.config', 'syncjar'));
  assert.equal(configDir({ env: { APPDATA: 'C:\\A' }, platform: 'win32', home: '/h' }), path.join('C:\\A', 'syncjar'));
});

test('the shell beats cwd .env, which beats the clone .env, which beats the user config', () => {
  const files = envFiles({ cwd: '/work', checkoutRoot: '/clone', userConfigDir: '/cfg' });
  assert.deepEqual(files, ['/cfg/.env', '/clone/.env', '/work/.env']);

  const contents = {
    '/cfg/.env': 'A=cfg\nB=cfg\nC=cfg\nD=cfg\n',
    '/clone/.env': 'B=clone\nC=clone\nD=clone\n',
    '/work/.env': 'C=work\nD=work\n'
  };
  const read = (file) => {
    if (!(file in contents)) throw new Error('ENOENT');
    return contents[file];
  };
  assert.deepEqual(layeredEnv(files, { D: 'shell' }, read), { A: 'cfg', B: 'clone', C: 'work', D: 'shell' });
});

test('missing .env files are skipped', () => {
  const read = () => { throw new Error('ENOENT'); };
  assert.deepEqual(layeredEnv(['/nope/.env'], { X: '1' }, read), { X: '1' });
});

test('the GitHub repository is read from package.json in either form', () => {
  assert.equal(githubRepo(pkg.repository), 'kallewesterling/syncjar');
  assert.equal(githubRepo('github:o/r'), 'o/r');
  assert.equal(githubRepo('o/r'), 'o/r');
  assert.equal(githubRepo({ url: 'git@github.com:o/r.git' }), 'o/r');
  assert.equal(githubRepo({ url: 'https://gitlab.com/o/r.git' }), null);
  assert.equal(githubRepo(undefined), null);
});

test('the install spec takes branches, tags and commits, and nothing that could be an npm flag', () => {
  assert.equal(installSpec('o/r', 'main'), 'github:o/r#main');
  assert.equal(installSpec('o/r', 'feature/x'), 'github:o/r#feature/x');
  assert.equal(installSpec('o/r', 'v2.0.0'), 'github:o/r#v2.0.0');
  assert.throws(() => installSpec('o/r', ''));
  assert.throws(() => installSpec('o/r', '--registry=x'));
  assert.throws(() => installSpec('o/r', 'main; rm -rf ~'));
});

test('update only installs a ref whose package.json still provides the command', () => {
  assert.equal(providesCommand(pkg), true);
  assert.equal(providesCommand({ name: 'syncjar', scripts: {} }), false);
  assert.equal(providesCommand(undefined), false);
  assert.equal(rawPackageUrl('o/r', 'feature/x'), 'https://raw.githubusercontent.com/o/r/feature/x/package.json');
});

function syncjar(args, cwd = os.tmpdir()) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(root, 'bin', 'syncjar.mjs'), ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, out: stdout.toString() };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

test('syncjar help lists the commands, and an unknown command fails', () => {
  const help = syncjar(['help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /push:quizzes/);
  assert.match(help.out, /syncjar update/);

  const unknown = syncjar(['no-such-command']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /Unknown command: no-such-command/);
});

test('syncjar passes options through to the command', () => {
  const res = syncjar(['export:students', '--help']);
  assert.equal(res.code, 0);
  assert.match(res.out, /--out/);
});

test('syncjar update refuses to reinstall over a clone', () => {
  const res = syncjar(['update']);
  assert.equal(res.code, 1);
  assert.match(res.out, /git clone/);
});
