import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALREADY_MEMBER_MARGIN_MS,
  alreadyMemberCutoff,
  chunk,
  classifyLookups,
  membershipBody,
  parseEmailList,
  readBatchResult
} from '#lib/groups/membership.mjs';
import { runMembership } from '#lib/groups/membership-run.mjs';

test('emails come from an email column in any position, or from a plain list', () => {
  const csv = 'Name,EMAIL,Company\n"Doe, Jane",Jane@Example.com,Acme\nBob,bob@example.com,"Acme, Inc"\n';
  assert.deepEqual(parseEmailList(csv).emails, ['jane@example.com', 'bob@example.com']);

  const plain = '\uFEFFa@example.com\r\n\r\n# a comment\nB@example.com\na@example.com\nnot-an-email\n';
  assert.deepEqual(parseEmailList(plain), { emails: ['a@example.com', 'b@example.com'], invalid: ['not-an-email'], repeated: 1 });

  assert.deepEqual(parseEmailList(''), { emails: [], invalid: [], repeated: 0 });
});

test('batches hold at most the given size and keep order', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 100), []);
  assert.deepEqual(membershipBody(['s1', 's2']), { data: [{ type: 'students', id: 's1' }, { type: 'students', id: 's2' }] });
});

test('lookups split into found, missing and ambiguous', () => {
  const student = (id, extra = {}) => ({ id, attributes: { first_name: 'A', last_name: 'B', is_inactive: false, ...extra } });
  const { found, missing, ambiguous } = classifyLookups([
    { email: 'one@example.com', matches: [student('s1')] },
    { email: 'none@example.com', matches: [] },
    { email: 'two@example.com', matches: [student('s2'), student('s3')] },
    { email: 'off@example.com', matches: [student('s4', { is_inactive: true })] }
  ]);
  assert.deepEqual(found, [
    { email: 'one@example.com', id: 's1', name: 'A B', inactive: false },
    { email: 'off@example.com', id: 's4', name: 'A B', inactive: true }
  ]);
  assert.deepEqual(missing, ['none@example.com']);
  assert.deepEqual(ambiguous, ['two@example.com']);
});

const sentAt = Date.parse('2026-10-30T12:00:00Z');
const sent = [
  { email: 'new@example.com', id: 's1' },
  { email: 'old@example.com', id: 's2' },
  { email: 'bad@example.com', id: 's3' },
  { email: 'lost@example.com', id: 's4' }
];

test('an add tells new members from existing ones by when the membership was created', () => {
  const body = {
    data: [
      { status: 'succeeded', id: 'm1', result: { type: 'memberships', id: 'm1', attributes: { student_id: 's1', is_manager: false, created_at: '2026-10-30T12:00:01Z' } } },
      { status: 'succeeded', id: 'm2', result: { type: 'memberships', id: 'm2', attributes: { student_id: 's2', is_manager: true, created_at: '2025-01-01T00:00:00Z' } } },
      { status: 'failed', id: null, error: { code: 'not_found', source: { pointer: '/data/2/id' }, detail: 'No such student' } }
    ],
    summary: { total: 4, succeeded: 2, failed: 1 }
  };
  const rows = readBatchResult('add', sent, body, alreadyMemberCutoff({ sentAt, receivedAt: sentAt }));
  assert.deepEqual(rows.map((r) => [r.email, r.result, r.before, r.after, r.is_manager]), [
    ['new@example.com', 'added', 'not_member', 'member', 'false'],
    ['old@example.com', 'already_member', 'member', 'member', 'true'],
    ['bad@example.com', 'failed', '', '', ''],
    ['lost@example.com', 'failed', '', '', '']
  ]);
  assert.equal(rows[2].error, 'not_found: No such student');
  assert.match(rows[3].error, /no result/);
});

const addedAt = (createdAt) => ({ data: [{ status: 'succeeded', result: { attributes: { student_id: 's1', is_manager: false, created_at: new Date(createdAt).toISOString() } } }] });

test('without a Date header, a membership created within the skew margin counts as new', () => {
  const cutoff = alreadyMemberCutoff({ sentAt, receivedAt: sentAt + 500 });
  assert.equal(readBatchResult('add', sent.slice(0, 1), addedAt(sentAt - ALREADY_MEMBER_MARGIN_MS + 1000), cutoff)[0].result, 'added');
});

test('with a Date header, a membership made seconds earlier is an existing one, whatever the local clock says', () => {
  // This machine's clock is ten minutes slow; Skilljar's is right.
  const server = Date.parse('2026-10-30T19:00:52Z');
  const local = server - 10 * 60_000;
  const cutoff = alreadyMemberCutoff({ sentAt: local, receivedAt: local + 400, serverDate: new Date(server).toUTCString() });
  assert.equal(readBatchResult('add', sent.slice(0, 1), addedAt(server - 5_000), cutoff)[0].result, 'already_member');
  assert.equal(readBatchResult('add', sent.slice(0, 1), addedAt(server - 300), cutoff)[0].result, 'added');
});

test('a remove reports removed without claiming to know the prior state', () => {
  const body = { data: [{ status: 'deleted', id: 's2' }, { status: 'deleted', id: 's1' }] };
  const rows = readBatchResult('remove', sent.slice(0, 2), body, alreadyMemberCutoff({ sentAt, receivedAt: sentAt }));
  assert.deepEqual(rows.map((r) => [r.student_id, r.result, r.before, r.after]), [
    ['s1', 'removed', 'unknown', 'not_member'],
    ['s2', 'removed', 'unknown', 'not_member']
  ]);
});

/** A v2 client stand-in. Records every call; writes answer from `onWrite`. */
function fakeClient({ students, groups = [{ id: 'g1', attributes: { name: 'Partner: Example' } }], onWrite }) {
  const calls = [];
  return {
    calls,
    async get(url, { params } = {}) {
      calls.push(['GET', url, params]);
      if (url === '/groups/') {
        const q = params['filter[name]'].toLowerCase();
        return { data: { data: groups.filter((g) => g.attributes.name.toLowerCase().includes(q)), links: { next: null } } };
      }
      if (url.startsWith('/groups/')) {
        const g = groups.find((x) => `/groups/${x.id}` === url);
        if (!g) throw Object.assign(new Error('404'), { response: { status: 404, data: { errors: [{ detail: 'Not found.' }] } } });
        return { data: { data: g } };
      }
      if (url === '/students/') {
        const s = students[params['filter[email]']];
        return { data: { data: s ? [s] : [] } };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body) { calls.push(['POST', url, body]); return onWrite('add', body); },
    async delete(url, { data }) { calls.push(['DELETE', url, data]); return onWrite('remove', data); }
  };
}

const studentsFor = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [
  `p${i}@example.com`, { id: `s${i}`, attributes: { first_name: 'P', last_name: String(i), is_inactive: false } }
]));
const succeedAll = (action, body) => ({
  data: {
    data: body.data.map(({ id }) => (action === 'add'
      ? { status: 'succeeded', id: `m-${id}`, result: { attributes: { student_id: id, is_manager: false, created_at: new Date(NOW).toISOString() } } }
      : { status: 'deleted', id }))
  }
});
const NOW = Date.parse('2026-10-30T12:00:00Z');

function harness({ argv, students, answer, onWrite = succeedAll }) {
  const client = fakeClient({ students, onWrite });
  const lines = [];
  const written = {};
  const prompts = [];
  const deps = {
    client,
    log: (l) => lines.push(l),
    prompt: async (q) => { prompts.push(q); return answer; },
    readFile: async () => { throw new Error('no file'); },
    writeFile: async (p, text) => { written[p] = text; },
    now: () => NOW
  };
  const args = { email: [], confirm: false, auditDir: '/audit', ...argv };
  return { run: (action) => runMembership(action, args, deps), client, lines, written, prompts };
}

const writes = (client) => client.calls.filter(([m]) => m !== 'GET');

test('a dry run reads the group and every student, and writes nothing', async () => {
  const h = harness({ argv: { groupName: 'partner: example', email: ['P0@example.com', 'nobody@example.com'] }, students: studentsFor(1) });
  assert.equal(await h.run('add'), 0);
  assert.deepEqual(writes(h.client), []);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.written, {});
  const out = h.lines.join('\n');
  assert.match(out, /ADD {2}1 students to "Partner: Example"/);
  assert.match(out, /1 emails have no Skilljar account/);
  assert.match(out, /DRY RUN/);
});

test('a confirmation that does not match aborts before any write', async () => {
  const h = harness({ argv: { group: 'g1', email: ['p0@example.com'], confirm: true }, students: studentsFor(1), answer: 'add 2' });
  assert.equal(await h.run('add'), 1);
  assert.deepEqual(h.prompts, ['Type "add 1" to proceed: ']);
  assert.deepEqual(writes(h.client), []);
  assert.deepEqual(h.written, {});
});

test('a confirmed add sends batches of 100 and audits every email', async () => {
  const students = studentsFor(150);
  const h = harness({ argv: { group: 'g1', email: [...Object.keys(students), 'ghost@example.com'], confirm: true }, students, answer: 'add 150' });
  assert.equal(await h.run('add'), 0);

  const posts = writes(h.client);
  assert.deepEqual(posts.map(([m, url, body]) => [m, url, body.data.length]), [
    ['POST', '/groups/g1/relationships/students/', 100],
    ['POST', '/groups/g1/relationships/students/', 50]
  ]);
  const [[auditPath, csv]] = Object.entries(h.written);
  assert.match(auditPath, /^\/audit\/group-add-audit-2026-10-30T12-00-00-000Z\.csv$/);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 1 + 151);
  assert.match(lines[0], /"email","student_id","name","group_id","group_name","action","before","after","result"/);
  assert.match(csv, /"p0@example.com","s0","P 0","g1","Partner: Example","add","not_member","member","added"/);
  assert.match(csv, /"ghost@example.com",,,"g1","Partner: Example","add",,,"skipped_no_account"/);
});

test('a batch that fails as a whole stops the run, and the rest are not attempted', async () => {
  const students = studentsFor(150);
  let n = 0;
  const onWrite = (action, body) => {
    n += 1;
    if (n === 1) throw Object.assign(new Error('500'), { response: { status: 500, data: { errors: [{ detail: 'boom' }] } } });
    return succeedAll(action, body);
  };
  const h = harness({ argv: { group: 'g1', email: Object.keys(students), confirm: true }, students, answer: 'remove 150', onWrite });
  assert.equal(await h.run('remove'), 1);
  assert.equal(writes(h.client).length, 1);
  const csv = Object.values(h.written)[0];
  assert.equal((csv.match(/"failed"/g) ?? []).length, 100);
  assert.equal((csv.match(/"not_attempted"/g) ?? []).length, 50);
  assert.match(h.lines.join('\n'), /Stopped after a batch failed: HTTP 500 — boom/);
});

test('a group name must match exactly one group', async () => {
  const groups = [{ id: 'g1', attributes: { name: 'Partner: Example' } }, { id: 'g2', attributes: { name: 'Partner: Example EMEA' } }];
  const h = harness({ argv: { groupName: 'Partner', email: ['p0@example.com'] }, students: studentsFor(1) });
  h.client.get = fakeClient({ students: studentsFor(1), groups }).get;
  assert.equal(await h.run('add'), 1);
  assert.match(h.lines.join('\n'), /No group is named "Partner"\. Names containing it: "Partner: Example", "Partner: Example EMEA"/);
});

test('an unknown group id is reported through onApiError', async () => {
  const h = harness({ argv: { group: 'nope', email: ['p0@example.com'] }, students: studentsFor(1) });
  assert.equal(await h.run('add'), 1);
  assert.match(h.lines.join('\n'), /Could not read group nope: HTTP 404 — Not found\./);
});
