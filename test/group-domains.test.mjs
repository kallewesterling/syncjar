import test from 'node:test';
import assert from 'node:assert/strict';

import { normaliseDomains, planDomains, sameDomains, domainsBody } from '#lib/groups/domains.mjs';
import { runDomains } from '#lib/groups/domains-run.mjs';

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

function fakeGroup(attributes, { onPatch, beforeReread } = {}) {
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
      throw Object.assign(new Error('404'), { response: { status: 404, data: { errors: [{ detail: 'Not found.' }] } } });
    },
    async patch(url, body) {
      calls.push(['PATCH', url, body]);
      if (onPatch) return onPatch(group, body);
      Object.assign(group.attributes, body.data[0].attributes);
      return { data: { data: [{ status: 'succeeded', id: 'g1', result: clone() }] } };
    }
  };
}

function harness(argv, client, answer) {
  const lines = [];
  const prompts = [];
  const deps = { client, log: (l) => lines.push(l), prompt: async (q) => { prompts.push(q); return answer; } };
  const args = { add: [], remove: [], confirm: false, allowPublicDomain: false, ...argv };
  return { run: () => runDomains(args, deps), lines, prompts, out: () => lines.join('\n') };
}

const patches = (client) => client.calls.filter(([m]) => m === 'PATCH');

test('with no --add or --remove it only lists the domains', async () => {
  const client = fakeGroup({ rule_email_domains: ['example.com'] });
  const h = harness({ groupName: 'partner: example' }, client);
  assert.equal(await h.run(), 0);
  assert.deepEqual(patches(client), []);
  assert.match(h.out(), /Auto-add domains: example\.com/);
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
