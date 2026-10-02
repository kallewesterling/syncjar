import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitCsvLine,
  parseRoster,
  toMembers,
  membersNotOnRoster,
  toRevokeCsv
} from '../scripts/group-audit-diff.mjs';

// Invented sample data, shaped like `GET /groups/{id}/users`.
const rows = [
  { user: { id: 'u1', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' } },
  { user: { id: 'u2', email: 'Grace@Example.com', first_name: 'Grace', last_name: 'Hopper' } },
  { id: 'u3', email: 'left@example.com', first_name: 'Former', last_name: 'Staff, Jr.' },
  { user: { id: 'u4', email: '' } }
];

test('splitCsvLine keeps a quoted comma inside its field', () => {
  assert.deepEqual(splitCsvLine('a,"b, c",d'), ['a', 'b, c', 'd']);
  assert.deepEqual(splitCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
});

test('parseRoster reads the email column even after a quoted comma', () => {
  const roster = parseRoster('name,title,email\nAda,"Engineer, Staff",Ada@Example.com\n');
  assert.deepEqual([...roster], ['ada@example.com']);
});

test('parseRoster refuses a roster that would mark everyone for removal', () => {
  assert.throws(() => parseRoster(''), /empty/);
  assert.throws(() => parseRoster('name\nAda\n'), /no email column/);
  assert.throws(() => parseRoster('email\n\n'), /empty|no emails/);
});

test('toMembers accepts both row shapes and drops rows with no email', () => {
  const members = toMembers(rows);
  assert.deepEqual(members.map((m) => m.id), ['u1', 'u2', 'u3']);
  assert.equal(members[2].name, 'Former Staff, Jr.');
});

test('membersNotOnRoster matches case-insensitively', () => {
  const roster = new Set(['ada@example.com', 'grace@example.com']);
  const stale = membersNotOnRoster(toMembers(rows), roster);
  assert.deepEqual(stale.map((m) => m.email), ['left@example.com']);
});

test('toRevokeCsv puts id and email where revoke-access splits for them', () => {
  const csv = toRevokeCsv(membersNotOnRoster(toMembers(rows), new Set()));
  const [header, ...lines] = csv.trim().split('\n');
  assert.equal(header, 'skilljar_id,email,name');
  // revoke-access.mjs splits on every comma; a comma in the name must not
  // move the first two columns.
  const third = lines.find((l) => l.startsWith('u3')).split(',');
  assert.equal(third[0], 'u3');
  assert.equal(third[1], 'left@example.com');
});
