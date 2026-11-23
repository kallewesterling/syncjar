import test from 'node:test';
import assert from 'node:assert/strict';

import { normaliseDomains, planDomains, sameDomains, domainsBody } from '#lib/groups/domains.mjs';
import { SHORT_LIST, runDomains, studentsAtDomains } from '#lib/groups/domains-run.mjs';

test('domains are lowercased, trimmed, stripped of a leading @, and validated', () => {
  assert.deepEqual(normaliseDomains([' @Example.COM ', 'example.com', 'sub.example.co.uk', 'not a domain', 'x@y.com', 'nodot', '']), {
    domains: ['example.com', 'sub.example.co.uk'],
    invalid: ['not a domain', 'x@y.com', 'nodot']
  });
});

test('a plan keeps the existing order, appends new domains and reports no-ops', () => {
  assert.deepEqual(planDomains(['A.com', 'b.com', 'c.com'], { add: ['d.com', 'b.com'], remove: ['a.com', 'z.com'] }), {
    before: ['a.com', 'b.com', 'c.com'],
    after: ['b.com', 'c.com', 'd.com'],
    adding: ['d.com'],
    alreadyPresent: ['b.com'],
    removing: ['a.com'],
    notPresent: ['z.com']
  });
});

test('domain lists compare as case-insensitive sets', () => {
  assert.ok(sameDomains(['B.com', 'a.com'], ['a.com', 'b.com']));
  assert.ok(sameDomains(undefined, []));
  assert.ok(!sameDomains(['a.com'], ['a.com', 'b.com']));
});

test('the write sends only rule_email_domains', () => {
  assert.deepEqual(domainsBody('g1', ['a.com']), { data: [{ type: 'groups', id: 'g1', attributes: { rule_email_domains: ['a.com'] } }] });
});

function fakeGroup(attributes, { onPatch, beforeReread, students = [] } = {}) {
  const group = { id: 'g1', type: 'groups', attributes: { name: 'Partner: Example', send_course_enrollment_email: true, category_id: null, ...attributes } };
  const calls = [];
  let reads = 0;
  const clone = () => structuredClone(group);
  return {
    group,
    calls,
    async get(url, { params } = {}) {
      calls.push(['GET', url]);
      if (url === '/groups/') return { data: { data: params?.['filter[name]'] && group.attributes.name.toLowerCase().includes(params['filter[name]'].toLowerCase()) ? [clone()] : [], links: {} } };
      if (url === '/groups/g1') {
        reads += 1;
        if (reads === 2) beforeReread?.(group);
        return { data: { data: clone() } };
      }
      if (url === '/students/') {
        const email = params?.['filter[email]'];
        return { data: { data: email ? students.filter((s) => s.attributes.email === email) : students, links: {} } };
      }
      throw Object.assign(new Error('404'), { response: { status: 404, data: { errors: [{ detail: 'Not found.' }] } } });
    },
    async post(url, body) {
      calls.push(['POST', url, body]);
      return {
        data: {
          data: body.data.map(({ id }) => ({
            status: 'succeeded',
            result: { attributes: { student_id: id, is_manager: false, created_at: new Date(NOW).toISOString() } }
          }))
        }
      };
    },
    async patch(url, body) {
      calls.push(['PATCH', url, body]);
      if (onPatch) return onPatch(group, body);
      Object.assign(group.attributes, body.data[0].attributes);
      return { data: { data: [{ status: 'succeeded', id: 'g1', result: clone() }] } };
    }
  };
}

const NOW = Date.parse('2026-11-23T12:00:00Z');

/** `answer` is the reply to every prompt, or a list of replies in order. */
function harness(argv, client, answer) {
  const lines = [];
  const prompts = [];
  const written = {};
  const replies = Array.isArray(answer) ? [...answer] : null;
  const deps = {
    client,
    log: (l) => lines.push(l),
    prompt: async (q) => { prompts.push(q); return replies ? replies.shift() : answer; },
    membershipDeps: { writeFile: async (p, text) => { written[p] = text; }, now: () => NOW }
  };
  const args = { add: [], remove: [], confirm: false, allowPublicDomain: false, checkExisting: false, auditDir: '/audit', ...argv };
  return { run: () => runDomains(args, deps), lines, prompts, written, out: () => lines.join('\n') };
}

const patches = (client) => client.calls.filter(([m]) => m === 'PATCH');

test('with no --add or --remove it only lists the domains', async () => {
  const client = fakeGroup({ rule_email_domains: ['example.com'] });
  const h = harness({ groupName: 'partner: example' }, client);
  assert.equal(await h.run(), 0);
  assert.deepEqual(patches(client), []);
  assert.match(h.out(), /Auto-add domains: example\.com/);
});

const manyDomains = Array.from({ length: SHORT_LIST + 1 }, (_, i) => `d${i}.example`);

test('a long list is counted, and --verbose lists it one per line', async () => {
  const client = fakeGroup({ rule_email_domains: manyDomains });
  const short = harness({ group: 'g1' }, client);
  assert.equal(await short.run(), 0);
  assert.match(short.out(), new RegExp(`Auto-add domains: ${SHORT_LIST + 1}\\n.*--verbose`));
  assert.doesNotMatch(short.out(), /d0\.example/);

  const verbose = harness({ group: 'g1', verbose: true }, client);
  assert.equal(await verbose.run(), 0);
  assert.match(verbose.out(), /Auto-add domains \(11\):\n {4}d0\.example\n {4}d1\.example/);
});

test('after writing to a long list it gives the old count, and a failure still prints the whole list', async () => {
  const ok = fakeGroup({ rule_email_domains: [...manyDomains] });
  const written = harness({ group: 'g1', add: ['new.example'], confirm: true }, ok, 'change 1');
  assert.equal(await written.run(), 0);
  assert.match(written.out(), /There were 11 before\./);
  assert.doesNotMatch(written.out(), /d0\.example/);

  const failing = fakeGroup({ rule_email_domains: [...manyDomains] }, {
    onPatch: () => ({ data: { data: [{ status: 'failed', id: 'g1', error: { code: 'invalid' } }] } })
  });
  const failed = harness({ group: 'g1', add: ['new.example'], confirm: true }, failing, 'change 1');
  assert.equal(await failed.run(), 1);
  assert.match(failed.out(), /The list was: d0\.example, d1\.example/);
});

test('a dry run shows before and after and writes nothing', async () => {
  const client = fakeGroup({ rule_email_domains: ['example.com'] });
  const h = harness({ group: 'g1', add: ['new.example'] }, client);
  assert.equal(await h.run(), 0);
  assert.deepEqual(patches(client), []);
  assert.deepEqual(h.prompts, []);
  assert.match(h.out(), /add {5}new\.example/);
  assert.match(h.out(), /1 domains before, 2 after/);
  assert.match(h.out(), /DRY RUN/);
});

test('a confirmed add writes the merged list and verifies it', async () => {
  const client = fakeGroup({ rule_email_domains: ['example.com'] });
  const h = harness({ group: 'g1', add: ['New.Example'], confirm: true }, client, 'change 1');
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.prompts, ['Type "change 1" to proceed: ']);
  assert.deepEqual(patches(client).map(([, url, body]) => [url, body]), [['/groups/', domainsBody('g1', ['example.com', 'new.example'])]]);
  assert.match(h.out(), /Updated: 1 added, 0 removed, 2 domains now\./);
  assert.match(h.out(), /They were: example\.com/);
});

test('a change with nothing to do asks nothing and writes nothing', async () => {
  const client = fakeGroup({ rule_email_domains: ['example.com'] });
  const h = harness({ group: 'g1', add: ['example.com'], remove: ['gone.example'], confirm: true }, client, 'change 0');
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(patches(client), []);
  assert.match(h.out(), /Nothing to change/);
});

test('a confirmation that does not match aborts before any write', async () => {
  const client = fakeGroup({ rule_email_domains: [] });
  const h = harness({ group: 'g1', add: ['a.example'], confirm: true }, client, 'yes');
  assert.equal(await h.run(), 1);
  assert.deepEqual(patches(client), []);
});

test('a list that changed after the plan was shown aborts the write', async () => {
  const client = fakeGroup({ rule_email_domains: ['example.com'] }, {
    beforeReread: (g) => { g.attributes.rule_email_domains = ['example.com', 'someone-else.example']; }
  });
  const h = harness({ group: 'g1', add: ['new.example'], confirm: true }, client, 'change 1');
  assert.equal(await h.run(), 1);
  assert.deepEqual(patches(client), []);
  assert.match(h.out(), /changed since this run read them: now example\.com, someone-else\.example/);
});

test('a 200 whose read-back does not show the change is a failure', async () => {
  const client = fakeGroup({ rule_email_domains: [] }, {
    onPatch: (g) => ({ data: { data: [{ status: 'succeeded', id: 'g1', result: structuredClone(g) }] } })
  });
  const h = harness({ group: 'g1', add: ['a.example'], confirm: true }, client, 'change 1');
  assert.equal(await h.run(), 1);
  assert.match(h.out(), /domains read back as \(none\)/);
});

test('any other field that moved in the write is a failure', async () => {
  const client = fakeGroup({ rule_email_domains: [] }, {
    onPatch: (g, body) => {
      Object.assign(g.attributes, body.data[0].attributes, { send_course_enrollment_email: false });
      return { data: { data: [{ status: 'succeeded', id: 'g1', result: structuredClone(g) }] } };
    }
  });
  const h = harness({ group: 'g1', add: ['a.example'], confirm: true }, client, 'change 1');
  assert.equal(await h.run(), 1);
  assert.match(h.out(), /send_course_enrollment_email moved from true to false/);
});

test('a failed batch item is reported with the list as it was', async () => {
  const client = fakeGroup({ rule_email_domains: ['example.com'] }, {
    onPatch: () => ({ data: { data: [{ status: 'failed', id: 'g1', error: { code: 'invalid', detail: 'Bad domain.' } }] } })
  });
  const h = harness({ group: 'g1', remove: ['example.com'], confirm: true }, client, 'change 1');
  assert.equal(await h.run(), 1);
  assert.match(h.out(), /not applied: invalid: Bad domain\./);
  assert.match(h.out(), /The list was: example\.com/);
});

test('free-mail domains are refused unless allowed, before any request', async () => {
  const client = fakeGroup({ rule_email_domains: [] });
  const refused = harness({ group: 'g1', add: ['Gmail.com'] }, client);
  assert.equal(await refused.run(), 1);
  assert.deepEqual(client.calls, []);
  assert.match(refused.out(), /gmail\.com is a free-mail domain/);

  const allowed = harness({ group: 'g1', add: ['gmail.com'], allowPublicDomain: true }, client);
  assert.equal(await allowed.run(), 0);
});

test('invalid domains, and a domain both added and removed, are refused before any request', async () => {
  const client = fakeGroup({ rule_email_domains: [] });
  assert.equal(await harness({ group: 'g1', add: ['someone@example.com'] }, client).run(), 1);
  assert.equal(await harness({ group: 'g1', add: ['a.example'], remove: ['A.example'] }, client).run(), 1);
  assert.deepEqual(client.calls, []);
});

const student = (id, email, extra = {}) => ({ id, type: 'students', attributes: { email, first_name: 'F', last_name: id, is_inactive: false, ...extra } });
const roster = [
  student('s1', 'b@new.example'),
  student('s2', 'a@New.Example'),
  student('s3', 'c@sub.new.example'),
  student('s4', 'd@other.example'),
  student('s5', 'e@new.example', { is_inactive: true })
];
const posts = (client) => client.calls.filter(([m]) => m === 'POST');

test('existing students are matched on the exact domain, active only, sorted by email', () => {
  assert.deepEqual(studentsAtDomains(roster, ['new.example']).map((s) => [s.id, s.email]), [['s2', 'a@new.example'], ['s1', 'b@new.example']]);
});

test('a dry run with --check-existing lists the students it would offer, and asks and writes nothing', async () => {
  const client = fakeGroup({ rule_email_domains: [] }, { students: roster });
  const h = harness({ group: 'g1', add: ['new.example'], checkExisting: true }, client);
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(patches(client), []);
  assert.deepEqual(posts(client), []);
  assert.match(h.out(), /2 active students found/);
  assert.match(h.out(), /a@new\.example[\s\S]*b@new\.example/);
  assert.match(h.out(), /DRY RUN: nobody was added/);
});

test('a confirmed --check-existing writes the domain, then adds only the students said yes to', async () => {
  const client = fakeGroup({ rule_email_domains: [] }, { students: roster });
  const h = harness({ group: 'g1', add: ['new.example'], checkExisting: true, confirm: true }, client, ['change 1', 'n', 'y', 'add 1']);
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.prompts, [
    'Type "change 1" to proceed: ',
    'Add a@new.example (F s2) to "Partner: Example"? [y/N/a/q] ',
    'Add b@new.example (F s1) to "Partner: Example"? [y/N/a/q] ',
    'Type "add 1" to proceed: '
  ]);
  assert.equal(patches(client).length, 1);
  assert.deepEqual(posts(client).map(([, url, body]) => [url, body.data.map((d) => d.id)]), [['/groups/g1/relationships/students/', ['s1']]]);
  assert.equal(Object.keys(h.written).length, 1);
});

test('"a" picks every remaining student, and "q" stops with what was picked', async () => {
  const many = [student('s1', 'a@new.example'), student('s2', 'b@new.example'), student('s3', 'c@new.example')];
  const all = fakeGroup({ rule_email_domains: ['new.example'] }, { students: many });
  assert.equal(await harness({ group: 'g1', checkExisting: true, confirm: true }, all, ['n', 'a', 'add 2']).run(), 0);
  assert.deepEqual(posts(all)[0][2].data.map((d) => d.id), ['s2', 's3']);

  const quit = fakeGroup({ rule_email_domains: ['new.example'] }, { students: many });
  const h = harness({ group: 'g1', checkExisting: true, confirm: true }, quit, ['q']);
  assert.equal(await h.run(), 0);
  assert.deepEqual(posts(quit), []);
  assert.match(h.out(), /Nobody chosen/);
});

test('--check-existing runs on a domain that is already there, and without --add checks every domain', async () => {
  const client = fakeGroup({ rule_email_domains: ['new.example', 'other.example'] }, { students: roster });
  const already = harness({ group: 'g1', add: ['new.example'], checkExisting: true }, client);
  assert.equal(await already.run(), 0);
  assert.match(already.out(), /Nothing to change[\s\S]*2 active students found/);

  const every = harness({ group: 'g1', checkExisting: true }, client);
  assert.equal(await every.run(), 0);
  assert.match(every.out(), /at new\.example, other\.example[\s\S]*3 active students found/);

  const long = fakeGroup({ rule_email_domains: manyDomains }, { students: roster });
  const counted = harness({ group: 'g1', checkExisting: true }, long);
  assert.equal(await counted.run(), 0);
  assert.match(counted.out(), /Existing students at the group's 11 domains/);
});

test('a failed domain write stops before --check-existing reads any student', async () => {
  const client = fakeGroup({ rule_email_domains: [] }, { students: roster });
  const h = harness({ group: 'g1', add: ['new.example'], checkExisting: true, confirm: true }, client, 'no');
  assert.equal(await h.run(), 1);
  assert.ok(!client.calls.some(([, url]) => url === '/students/'));
});
