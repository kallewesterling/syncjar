import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The root of the Syncjar clone. Defaults such as `public/data/` and
 * `local-skilljar/` are resolved against it rather than against the file
 * that names them, so moving a command to a different depth in
 * `src/commands/` cannot silently move its output somewhere else.
 */
export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
