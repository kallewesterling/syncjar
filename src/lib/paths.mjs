import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The root of the Syncjar install. In a clone this is the clone; after
 * `npm install -g` it is a directory inside npm's global `node_modules`,
 * which `syncjar update` replaces wholesale.
 */
export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * True when Syncjar is running from a git clone, including one linked
 * globally with `npm link`, rather than from a packaged install.
 */
export const isCheckout = fs.existsSync(path.join(repoRoot, '.git'));

/**
 * Where default outputs and content trees such as `public/data/` and
 * `local-skilljar/` live: the clone when running from one, and otherwise the
 * directory the command was run from. A packaged install must not be written
 * into, because the next `syncjar update` deletes it, student exports and
 * pulled content included.
 *
 * Resolved against this rather than against the file that names a default,
 * so moving a command to a different depth in `src/commands/` cannot
 * silently move its output somewhere else.
 */
export const workRoot = isCheckout ? repoRoot : process.cwd();
