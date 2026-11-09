#!/usr/bin/env node
/**
 * syncjar — the global command.
 *
 *   syncjar <command> [options]   run an npm script, e.g. `syncjar push:quizzes --dry-run`
 *   syncjar update [--ref <ref>]  reinstall from GitHub (default ref: main)
 *   syncjar help                  list commands
 *
 * Each command runs as its own process, from the current directory, exactly
 * as `npm run <command> -- [options]` would from a clone.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { repoRoot, isCheckout } from '#lib/paths.mjs';
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
import { fail, heading, muted, ok } from '#lib/ui.mjs';

const DEFAULT_REF = 'main';

const readPackage = () => JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const pkg = readPackage();
const commands = commandTable(pkg.scripts);

function usage() {
  const userEnv = path.join(configDir(), '.env');
  console.log(`${heading('syncjar')} ${pkg.version} ${muted(isCheckout ? `(clone at ${repoRoot})` : '')}

${heading('Usage')}
  syncjar <command> [options]
  syncjar update [--ref <branch|tag|commit>]   reinstall from GitHub (default: ${DEFAULT_REF})
  syncjar <command> --help                     options for one command

${heading('Commands')}`);
  for (const name of commands.keys()) {
    const note = !isCheckout && CHECKOUT_ONLY.has(name) ? muted('  (needs a clone)') : '';
    console.log(`  ${name}${note}`);
  }
  console.log(`
${heading('Credentials')}
  Read from .env in the current directory, then ${userEnv}.
  A variable already set in the shell wins over both.
  Outputs go to ${isCheckout ? 'the clone' : 'the current directory'}.`);
}

/**
 * Runs `cmd` with inherited stdio and resolves with its exit code. Ctrl+C
 * reaches the child directly (same process group), so the CLI ignores it
 * and lets the child clean up and exit; pulls remove their temp files that
 * way.
 */
function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const ignore = () => {};
    process.on('SIGINT', ignore);
    const child = spawn(cmd, args, { stdio: 'inherit', ...options });
    child.on('error', (err) => {
      console.error(fail(`Could not start ${cmd}: ${err.message}`));
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', ignore);
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });
}

async function update(args) {
  if (isCheckout) {
    console.error(fail(`This syncjar runs from a git clone at ${repoRoot}.`));
    console.error(muted('  Update it there with git pull; `syncjar update` is for installs made with npm install -g.'));
    return 1;
  }

  const refAt = args.findIndex((a) => a === '--ref' || a.startsWith('--ref='));
  const ref = refAt === -1 ? DEFAULT_REF : (args[refAt].split('=')[1] ?? args[refAt + 1]);
  const repo = githubRepo(pkg.repository);
  if (!repo) {
    console.error(fail('package.json has no GitHub repository to update from.'));
    return 1;
  }

  let spec;
  try {
    spec = installSpec(repo, ref ?? '');
  } catch (err) {
    console.error(fail(err.message));
    return 1;
  }

  let target;
  try {
    const res = await fetch(rawPackageUrl(repo, ref));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    target = await res.json();
  } catch (err) {
    console.error(fail(`Could not read package.json at ${repo}#${ref} (${err.message}).`));
    console.error(muted('  Check the ref exists on GitHub. Nothing was changed.'));
    return 1;
  }
  if (!providesCommand(target)) {
    console.error(fail(`${repo}#${ref} does not provide the syncjar command yet.`));
    console.error(muted('  Installing it would remove syncjar from your machine. Nothing was changed.'));
    return 1;
  }

  console.log(`Installing ${spec} ${muted(`(currently ${pkg.version})`)}\n`);
  const code = await run('npm', ['install', '--global', spec], { shell: process.platform === 'win32' });
  if (code !== 0) {
    console.error(fail(`npm install exited with ${code}. The previous install is unchanged.`));
    return code;
  }
  console.log(`\n${ok(`syncjar ${readPackage().version} installed from ${ref}`)}`);
  console.log(muted('  package.json records the last release, so a branch install can show the same version.'));
  return 0;
}

async function main(argv) {
  const [name, ...args] = argv;

  if (!name || name === 'help' || name === '--help' || name === '-h') {
    usage();
    return 0;
  }
  if (name === '--version' || name === '-v') {
    console.log(pkg.version);
    return 0;
  }
  if (name === 'update') return update(args);

  const files = commands.get(name);
  if (!files) {
    console.error(fail(`Unknown command: ${name}`));
    console.error(muted('  Run `syncjar help` for the list.'));
    return 1;
  }
  if (!isCheckout && CHECKOUT_ONLY.has(name)) {
    console.error(fail(`${name} works on the preview site inside a clone, so it only runs from one.`));
    console.error(muted('  Clone the repository and use npm run instead.'));
    return 1;
  }

  const env = layeredEnv(envFiles({ checkoutRoot: isCheckout ? repoRoot : null }));
  for (const file of files) {
    const code = await run(process.execPath, [path.join(repoRoot, file), ...args], { env });
    if (code !== 0) return code;
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
