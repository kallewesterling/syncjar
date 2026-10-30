import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createSkilljarV2Client, listAllV2, nextCursor } from '#lib/skilljar/client-v2.mjs';
import { errorDetail } from '#lib/skilljar/client.mjs';

const CLIENT_ID = 'client-notreal';
const CLIENT_SECRET = 'secret-notarealsecret';

/**
 * A stand-in for api.skilljar.com/v2 on localhost. `routes` maps
 * "METHOD /path" to a handler returning `[status, body]`; every request is
 * recorded.
 */
async function fakeApi(routes) {
  const requests = [];
  let tokens = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
      let status = 404;
      let out = { errors: [{ status: '404', code: 'not_found', title: 'Not found', detail: 'No route' }] };
      if (req.method === 'POST' && url.pathname === '/v2/auth/token') {
        [status, out] = routes.token
          ? routes.token(body)
          : [200, { access_token: `jwt-${++tokens}`, expires_in: 3600, token_type: 'Bearer' }];
      } else {
        const handler = routes[`${req.method} ${url.pathname}`];
        if (handler) [status, out] = handler({ query: url.searchParams, headers: req.headers, body });
      }
      res.writeHead(status, { 'content-type': 'application/vnd.api+json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/v2`;
  return { baseURL, requests, close: () => new Promise((r) => server.close(r)) };
}

const env = { SKILLJAR_CLIENT_ID: CLIENT_ID, SKILLJAR_CLIENT_SECRET: CLIENT_SECRET };

test('the v2 client refuses to build without both OAuth credentials', () => {
  assert.throws(() => createSkilljarV2Client({ env: {} }), /SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET are not set/);
  assert.throws(() => createSkilljarV2Client({ env: { SKILLJAR_CLIENT_ID: 'x' } }), /not set/);
});

test('it exchanges the client credentials once and sends the token as a bearer', async (t) => {
  const api = await fakeApi({ 'GET /v2/groups/x': () => [200, { data: { id: 'x' } }] });
  t.after(api.close);
  const client = createSkilljarV2Client({ env, baseURL: api.baseURL });

  await Promise.all([client.get('/groups/x'), client.get('/groups/x'), client.get('/groups/x')]);

  const tokenCalls = api.requests.filter((r) => r.path === '/v2/auth/token');
  assert.equal(tokenCalls.length, 1);
  assert.deepEqual(tokenCalls[0].body, { grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  const reads = api.requests.filter((r) => r.path === '/v2/groups/x');
  assert.equal(reads.length, 3);
  for (const r of reads) {
    assert.equal(r.headers.authorization, 'Bearer jwt-1');
    assert.match(r.headers.accept, /application\/vnd\.api\+json/);
  }
});

test('a token near expiry is replaced before it is used', async (t) => {
  const api = await fakeApi({ 'GET /v2/groups/x': ({ headers }) => [200, { data: { auth: headers.authorization } }] });
  t.after(api.close);
  let clock = 0;
  const client = createSkilljarV2Client({ env, baseURL: api.baseURL, now: () => clock });

  assert.equal((await client.get('/groups/x')).data.data.auth, 'Bearer jwt-1');
  clock = 3600_000 - 30_000;
  assert.equal((await client.get('/groups/x')).data.data.auth, 'Bearer jwt-2');
});

test('a 401 fetches a new token and retries once, and only once', async (t) => {
  let calls = 0;
  const api = await fakeApi({
    'GET /v2/groups/x': ({ headers }) => (headers.authorization === 'Bearer jwt-1'
      ? [401, { errors: [{ status: '401', code: 'token_expired', title: 'Unauthorized', detail: 'expired' }] }]
      : [200, { data: { id: 'x' } }]),
    'GET /v2/groups/never': () => { calls += 1; return [401, { errors: [] }]; }
  });
  t.after(api.close);
  const client = createSkilljarV2Client({ env, baseURL: api.baseURL });

  assert.equal((await client.get('/groups/x')).status, 200);
  await assert.rejects(client.get('/groups/never'), (err) => err.response?.status === 401);
  assert.equal(calls, 2);
});

test('neither the client secret nor a token survives into a rejected error', async (t) => {
  const api = await fakeApi({
    token: () => [401, { error: 'invalid_client', error_description: 'Client authentication failed.' }]
  });
  t.after(api.close);
  const client = createSkilljarV2Client({ env, baseURL: api.baseURL });

  const err = await client.get('/groups/x').catch((e) => e);
  assert.equal(err.response?.status, 401);
  assert.equal(errorDetail(err), 'invalid_client: Client authentication failed.');
  assert.equal(err.config, undefined);
  assert.equal(err.request, undefined);
  const printable = JSON.stringify(err, Object.getOwnPropertyNames(err)) + String(err.stack);
  assert.doesNotMatch(printable, new RegExp(CLIENT_SECRET));

  const api2 = await fakeApi({ 'GET /v2/groups/x': () => [403, { errors: [{ status: '403', code: 'forbidden', title: 'Forbidden', detail: 'Missing scope student-groups:read' }] }] });
  t.after(api2.close);
  const err2 = await createSkilljarV2Client({ env, baseURL: api2.baseURL }).get('/groups/x').catch((e) => e);
  assert.equal(errorDetail(err2), 'Missing scope student-groups:read');
  assert.doesNotMatch(JSON.stringify(err2, Object.getOwnPropertyNames(err2)), /jwt-|Bearer/);
});

test('list reads follow the cursor in links.next until there is none', async (t) => {
  const pages = { '': ['a', 'b'], c1: ['c', 'd'], c2: ['e'] };
  const next = { '': '/v2/students/?page%5Bcursor%5D=c1&page%5Bsize%5D=100', c1: 'https://api.skilljar.com/v2/students/?page[cursor]=c2', c2: null };
  const api = await fakeApi({
    'GET /v2/students/': ({ query }) => {
      const cursor = query.get('page[cursor]') ?? '';
      assert.equal(query.get('page[size]'), '100');
      assert.equal(query.get('filter[is_inactive]'), 'false');
      return [200, { data: pages[cursor].map((id) => ({ id })), links: { next: next[cursor] } }];
    }
  });
  t.after(api.close);
  const client = createSkilljarV2Client({ env, baseURL: api.baseURL });

  const all = await listAllV2(client, '/students/', { 'filter[is_inactive]': false });
  assert.deepEqual(all.map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);
});

test('nextCursor reads relative and absolute links, and null means the last page', () => {
  assert.equal(nextCursor({ next: '/v2/groups/?page[cursor]=abc' }), 'abc');
  assert.equal(nextCursor({ next: 'https://api.skilljar.com/v2/groups/?page%5Bcursor%5D=x%3D' }), 'x=');
  assert.equal(nextCursor({ next: null }), null);
  assert.equal(nextCursor(undefined), null);
});
