/**
 * ui.mjs — the symbols and colours every script reports with.
 *
 * These scripts had accumulated 23 different emoji across 15 files — 📘 📄 🔍
 * ✨ 🎉 🔥 📁 📝 📦 ⛔ and so on — mostly decorative, and inconsistent about
 * which one meant what: ✅ marked both "already in sync" and "written
 * upstream", which are opposite outcomes for the operator.
 *
 * So there is one small fixed vocabulary, and it carries meaning rather than
 * decoration:
 *
 *   ok      something was written or verified
 *   warn    something needs a human, but the run continues
 *   fail    the run is stopping
 *   skip    deliberately not done
 *   change  a difference that is about to be reviewed
 *
 * Colour is the emphasis; the glyph is there so the meaning survives a log
 * file, a CI transcript, or a colour-blind reader.
 */
import chalk from 'chalk';

export const symbols = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  skip: '·',
  change: '~',
  bullet: '-'
};

export const ok = (msg) => `${chalk.green(symbols.ok)} ${msg}`;
export const warn = (msg) => `${chalk.yellow(symbols.warn)} ${msg}`;
export const fail = (msg) => `${chalk.red(symbols.fail)} ${msg}`;
export const skip = (msg) => `${chalk.gray(`${symbols.skip} ${msg}`)}`;
export const change = (msg) => `${chalk.yellow(symbols.change)} ${msg}`;

// For counts and timings trailing a headline — present, but not competing
// with it for attention.
export const muted = (msg) => chalk.gray(msg);

export const heading = (msg) => chalk.bold(msg);
