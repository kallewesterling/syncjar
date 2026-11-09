/**
 * format.mjs — the terminal rendering of a drift report.
 *
 * Content edits are the ones a push destroys, so they lead and are marked
 * with the warning glyph; structure changes follow; settings and titles are
 * muted. Actors appear only when the caller passes `showActors` and the
 * report was built with them.
 */
import chalk from 'chalk';
import { muted, symbols } from '#lib/ui.mjs';

export const shortTime = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : '');

function range(c) {
  const first = shortTime(c.first);
  const last = shortTime(c.last);
  return first === last ? last : `${first} → ${last}`;
}

function countsText(counts) {
  return ['content', 'structure', 'settings']
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${k}`)
    .join(', ');
}

function changeLine(c, indent, { showActors }) {
  const glyph = c.kind === 'content' ? chalk.yellow(symbols.warn) : c.kind === 'structure' ? chalk.cyan(symbols.change) : chalk.gray(symbols.skip);
  const label = `${c.label}${c.count > 1 ? ` ×${c.count}` : ''}`;
  const styled = c.kind === 'content' ? chalk.bold.yellow(label) : c.kind === 'structure' ? chalk.cyan(label) : chalk.gray(label);
  const who = showActors && c.actors?.length ? muted(`  by ${c.actors.join(', ')}`) : '';
  return `${indent}${glyph} ${styled}  ${muted(range(c))}${who}`;
}

/**
 * Describes where the since point came from, in a line or two.
 */
export function describeSince(sinceInfo) {
  const at = `${shortTime(sinceInfo.since)} UTC`;
  if (sinceInfo.source === 'date') return [`since ${at} (--since)`];
  if (sinceInfo.source === 'ref') {
    return [`since ${at}, the date of commit ${sinceInfo.commit.sha.slice(0, 8)} "${sinceInfo.commit.subject}" (--since)`];
  }
  const lines = [`since ${at}, the last pull in the content repo: ${sinceInfo.commit.sha.slice(0, 8)} "${sinceInfo.commit.subject}"`];
  if (sinceInfo.localAfterSync) {
    lines.push(`${sinceInfo.localAfterSync} later commit(s) touch the tree, the newest on ${shortTime(sinceInfo.latest.date)}; they are local edits and brought nothing down from Skilljar, so they do not move the start.`);
  }
  return lines;
}

/**
 * The report as lines of terminal text.
 */
export function formatDriftReport(report, { showActors = false } = {}) {
  const lines = [];
  const opts = { showActors };

  for (const course of report.courses.filter((c) => c.inTree)) {
    const mark = course.counts.content ? chalk.yellow(symbols.warn) : chalk.cyan(symbols.change);
    lines.push('');
    lines.push(`${mark} ${chalk.bold(course.title)}  ${muted(`${course.dir} — ${countsText(course.counts)}; last ${shortTime(course.last)}`)}`);
    for (const c of course.changes) lines.push(changeLine({ ...c, label: `course: ${c.label}` }, '    ', opts));
    for (const lesson of course.lessons) {
      const notes = [lesson.type === 'SECTION' || lesson.type === 'section' ? 'section' : null, lesson.inTree ? null : 'not in the local tree', lesson.existsUpstream ? null : 'deleted upstream']
        .filter(Boolean);
      lines.push(`    ${lesson.title}${notes.length ? muted(` (${notes.join(', ')})`) : ''}`);
      for (const c of lesson.changes) lines.push(changeLine(c, '      ', opts));
    }
  }

  const upstreamOnly = report.courses.filter((c) => !c.inTree);
  if (upstreamOnly.length || report.deleted.length) {
    lines.push('');
    lines.push(chalk.bold('Not in the local tree'));
    for (const course of upstreamOnly) {
      const summary = `${countsText(course.counts)}; last ${shortTime(course.last)}`;
      if (course.existsUpstream) {
        lines.push(`  ${chalk.cyan('+')} course "${course.title}" ${muted(`(${course.id}) exists upstream but was never pulled — ${summary}`)}`);
      } else {
        const lessons = course.lessons.length ? `, ${course.lessons.length} of its lessons still read back` : '';
        lines.push(`  ${chalk.red(symbols.fail)} course "${course.title}" ${muted(`(${course.id}) was deleted upstream${lessons} — ${summary}`)}`);
      }
    }
    for (const d of report.deleted) {
      lines.push(`  ${chalk.red(symbols.fail)} ${d.targetType} "${d.title}" ${muted(`(${d.id}) no longer exists upstream`)}`);
      for (const c of d.changes) lines.push(changeLine(c, '      ', opts));
    }
  }
  return lines;
}
