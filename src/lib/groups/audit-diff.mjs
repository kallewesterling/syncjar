/**
 * group-audit-diff.mjs — the logic behind group-audit.mjs, kept here so it
 * can be tested without a Skilljar key. Does nothing on import.
 *
 * The question it answers: who is in this group but not on the roster of
 * people who should be? The output CSV is the input format revoke-access.mjs
 * reads, so the audit and the removal are two steps with a human read of the
 * CSV in between.
 */

/**
 * Splits one CSV line, honouring double-quoted fields. Rosters exported from
 * HR or Slack routinely quote a title or display name containing a comma, and
 * a naive split shifts every column after it — which here would read the
 * wrong cell as the email and report an active person as departed.
 */
export function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

/**
 * Lowercased emails from a roster CSV with an `email` column. Throws if there
 * is no such column: an empty roster would mark every member for removal.
 */
export function parseRoster(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('Roster is empty.');

  const header = splitCsvLine(lines.shift()).map((h) => h.toLowerCase());
  const emailIdx = header.indexOf('email');
  if (emailIdx === -1) throw new Error('Roster has no email column.');

  const emails = new Set();
  for (const line of lines) {
    const email = (splitCsvLine(line)[emailIdx] ?? '').toLowerCase();
    if (email) emails.add(email);
  }
  if (!emails.size) throw new Error('Roster has an email column but no emails.');
  return emails;
}

/**
 * Normalises group-member rows from the API to `{ id, email, name }`,
 * dropping any without an email, since there is nothing to match them on.
 */
export function toMembers(rows) {
  const members = [];
  for (const row of rows) {
    const u = row.user ?? row;
    const email = (u?.email ?? '').trim();
    if (!email) continue;
    members.push({
      id: u.id ?? '',
      email,
      name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim()
    });
  }
  return members;
}

/**
 * Members whose email is not on the roster, sorted by email.
 */
export function membersNotOnRoster(members, rosterEmails) {
  return members
    .filter((m) => !rosterEmails.has(m.email.toLowerCase()))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * The CSV revoke-access.mjs reads. It splits naively on commas, so `id` and
 * `email` are written unquoted, and `name` — the only field that can contain
 * a comma — goes last, where extra splits cannot shift the columns it reads.
 */
export function toRevokeCsv(members) {
  const rows = members.map((m) => `${m.id},${m.email},"${m.name.replace(/"/g, '""')}"`);
  return ['skilljar_id,email,name', ...rows].join('\n') + '\n';
}
