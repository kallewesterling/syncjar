import test from 'node:test';
import assert from 'node:assert/strict';

import { redactError } from '../scripts/skilljar-client.mjs';

const API_KEY = 'sk-live-notarealkey';

// The shape axios rejects with: the request config (including the resolved
// Authorization header), a low-level request object, and the response.
function axiosErrorLike() {
  const err = new Error('Request failed with status code 404');
  err.code = 'ERR_BAD_REQUEST';
  err.isAxiosError = true;
  err.config = {
    method: 'get',
    url: '/domains/example.com/published-paths',
    auth: { username: API_KEY, password: '' },
    headers: {
      Authorization: `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`,
      Accept: 'application/json'
    }
  };
  err.request = { _header: `GET /v1/x HTTP/1.1\r\nAuthorization: Basic ${API_KEY}\r\n` };
  err.response = {
    status: 404,
    statusText: 'Not Found',
    data: 'Not found.',
    headers: { 'content-type': 'application/json' },
    config: err.config,
    request: err.request
  };
  return err;
}

// Everything a serializer might walk, since an unhandled rejection prints the
// object rather than just its message.
function everythingPrintable(value) {
  const seen = new WeakSet();
  const parts = [];
  (function walk(v) {
    if (v === null || v === undefined) return;
    if (typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      for (const [k, child] of Object.entries(v)) {
        parts.push(k);
        walk(child);
      }
      return;
    }
    parts.push(String(v));
  })(value);
  // Own enumerable properties miss Error.message/stack, which print anyway.
  if (value instanceof Error) parts.push(value.message, value.stack ?? '');
  return parts.join('\n');
}

test('a redacted error carries no credentials anywhere in it', () => {
  const printable = everythingPrintable(redactError(axiosErrorLike()));

  assert.ok(!printable.includes(API_KEY), 'the API key survived redaction');
  assert.ok(!printable.toLowerCase().includes('authorization'), 'an Authorization header survived redaction');
  assert.ok(!printable.includes('Basic '), 'a Basic credential survived redaction');
});

test('the unredacted error really does leak, so the test above means something', () => {
  // Guards against the assertions above passing for the wrong reason — a
  // typo'd key name, say, would make them vacuous.
  const printable = everythingPrintable(axiosErrorLike());
  assert.ok(printable.includes(API_KEY));
  assert.ok(printable.toLowerCase().includes('authorization'));
});

test('a redacted error keeps what a human needs to act on', () => {
  const safe = redactError(axiosErrorLike());

  assert.equal(safe.message, 'Request failed with status code 404');
  assert.equal(safe.code, 'ERR_BAD_REQUEST');
  assert.equal(safe.method, 'GET');
  assert.equal(safe.url, '/domains/example.com/published-paths');
  // failCleanly() reads both of these, as do sync-users and revoke-access.
  assert.equal(safe.response.status, 404);
  assert.equal(safe.response.data, 'Not found.');
  assert.equal(safe.response.statusText, 'Not Found');
  assert.ok(safe.stack, 'the original stack should survive for debugging');
});

test('a redacted error drops the containers that hold the key', () => {
  const safe = redactError(axiosErrorLike());

  assert.equal(safe.config, undefined);
  assert.equal(safe.request, undefined);
  assert.equal(safe.response.headers, undefined);
  assert.equal(safe.response.config, undefined);
  assert.equal(safe.response.request, undefined);
});

test('redaction survives an error with no response at all', () => {
  // A DNS failure or a dropped connection: no response, but config still
  // holds the header.
  const err = new Error('getaddrinfo ENOTFOUND api.skilljar.com');
  err.code = 'ENOTFOUND';
  err.config = { method: 'get', url: '/courses', headers: { Authorization: `Basic ${API_KEY}` } };

  const safe = redactError(err);
  assert.equal(safe.response, undefined);
  assert.equal(safe.code, 'ENOTFOUND');
  assert.equal(safe.method, 'GET');
  assert.ok(!everythingPrintable(safe).includes(API_KEY));
});

test('redaction survives an error with no config either', () => {
  const safe = redactError(new Error('something went wrong before the request'));
  assert.equal(safe.method, undefined);
  assert.equal(safe.url, undefined);
  assert.equal(safe.message, 'something went wrong before the request');
});
