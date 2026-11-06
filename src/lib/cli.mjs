/**
 * cli.mjs — what the global `syncjar` command needs to know, kept apart from
 * `bin/syncjar.mjs` so it can be tested without spawning anything.
 *
 * The npm scripts in package.json stay the single list of commands: `syncjar
 * push:quizzes` runs exactly what `npm run push:quizzes` runs, so a new
 * script is a new subcommand the day it is added.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

/**
 * Commands that read or write the preview site under the install's own
 * `public/`, which mixes tracked files with generated ones. From a packaged
 * install they would write into a directory `syncjar update` replaces, so
 * they only run from a clone.
 */
export const CHECKOUT_ONLY = new Set(['serve', 'generate:courses', 'build:preview', 'check:links']);

const NODE_SCRIPT = /^node\s+(src\/commands\/\S+\.mjs)$/;
const NPM_RUN = /^npm run (\S+)$/;

/**
 * Maps each npm script to the command files it runs, in order. A plain
 * `node src/commands/….mjs` script is one step; `npm run a && npm run b` is
 * the steps of `a` then `b`. Scripts in any other form (`test`) are not
 * subcommands.
 *
 * @returns {Map<string, string[]>} script name → command files, relative to the package root
 */
export function commandTable(scripts) {
  const table = new Map();
  const resolve = (name, seen = new Set()) => {
    const body = scripts[name]?.trim();
    if (!body || seen.has(name)) return null;
    const direct = body.match(NODE_SCRIPT);
    if (direct) return [direct[1]];
    const steps = [];
    for (const part of body.split('&&').map((p) => p.trim())) {
      const run = part.match(NPM_RUN);
      const files = run && resolve(run[1], new Set([...seen, name]));
      if (!files) return null;
      steps.push(...files);
    }
    return steps;
  };
  for (const name of Object.keys(scripts)) {
    const files = resolve(name);
    if (files) table.set(name, files);
  }
  return table;
}

/**
 * The directory holding a user-level `.env`, for running syncjar from
 * anywhere: `$XDG_CONFIG_HOME/syncjar`, else `~/.config/syncjar`, or
 * `%APPDATA%\syncjar` on Windows.
 */
export function configDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'syncjar');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'syncjar');
}

/**
 * The `.env` files a command can draw on, lowest precedence first. Each
 * command calls `dotenv.config()` itself, which reads only `<cwd>/.env` and
 * never overrides a variable already set, so the CLI layers the rest
 * underneath before spawning it.
 */
export function envFiles({ cwd = process.cwd(), checkoutRoot = null, userConfigDir = configDir() } = {}) {
  const files = [path.join(userConfigDir, '.env')];
  if (checkoutRoot) files.push(path.join(checkoutRoot, '.env'));
  files.push(path.join(cwd, '.env'));
  return [...new Set(files)];
}

/**
 * Merges `files` (lowest precedence first) under `baseEnv`, so a variable set
 * in the shell always wins. Missing files are skipped.
 */
export function layeredEnv(files, baseEnv = process.env, readFile = fs.readFileSync) {
  const merged = {};
  for (const file of files) {
    let text;
    try {
      text = readFile(file, 'utf8');
    } catch {
      continue;
    }
    Object.assign(merged, dotenv.parse(text));
  }
  return { ...merged, ...baseEnv };
}

/**
 * `owner/name` from package.json's `repository`, which npm accepts as a
 * string or as `{ url }`. Null if it does not name a GitHub repository.
 */
export function githubRepo(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  const match = url?.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
    || url?.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Whether a package.json, read from the ref about to be installed, still
 * provides the `syncjar` command. Installing one that doesn't removes the
 * command along with the old install, leaving nothing to run
 * `syncjar update` from to get back. Every ref from before the CLI existed
 * is one of those.
 */
export function providesCommand(packageJson) {
  return typeof packageJson?.bin?.syncjar === 'string';
}

/**
 * The URL of package.json at `ref` of a public GitHub repository.
 */
export function rawPackageUrl(repo, ref) {
  return `https://raw.githubusercontent.com/${repo}/${encodeURI(ref)}/package.json`;
}

/**
 * The spec `npm install --global` takes to install `ref` of `repo` straight
 * from GitHub. `ref` is a branch, tag or commit.
 */
export function installSpec(repo, ref) {
  if (!/^[\w./-]+$/.test(ref) || ref.startsWith('-')) {
    throw new Error(`Not a usable git ref: ${JSON.stringify(ref)}`);
  }
  return `github:${repo}#${ref}`;
}
