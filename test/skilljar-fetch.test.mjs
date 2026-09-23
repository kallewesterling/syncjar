import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchCourses, fetchLessons, fetchContentItems } from '../scripts/skilljar-fetch.mjs';

// A stand-in for the axios client that records what it was asked for and
// replays canned pages.
function fakeClient(pages) {
  const calls = [];
  return {
    calls,
    async get(endpoint, config = {}) {
      calls.push({ endpoint, params: config.params });
      const key = `${endpoint}#${config.params?.page ?? 1}`;
      if (!(key in pages)) throw new Error(`unexpected request: ${key}`);
      return { data: pages[key] };
    }
  };
}

test('fetchCourses walks every page and concatenates results', async () => {
  const client = fakeClient({
    '/courses#1': { results: [{ id: 'a' }, { id: 'b' }], next: 'https://api.skilljar.com/v1/courses?page=2' },
    '/courses#2': { results: [{ id: 'c' }], next: null }
  });

  assert.deepEqual(await fetchCourses(client), [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(client.calls.map(c => c.params.page), [1, 2]);
});

// The cost here is the round trip, not the bytes, so every list read asks for
// Skilljar's maximum page size. Dropping to the default would quadruple the
// request count for the same data.
test('list reads request the largest page Skilljar allows', async () => {
  const client = fakeClient({ '/courses#1': { results: [], next: null } });
  await fetchCourses(client);
  assert.equal(client.calls[0].params.page_size, 100);
});

test('fetchCourses stops after one page when there is no next', async () => {
  const client = fakeClient({ '/courses#1': { results: [{ id: 'a' }], next: null } });
  await fetchCourses(client);
  assert.equal(client.calls.length, 1);
});

test('fetchLessons scopes the list to one course', async () => {
  const client = fakeClient({
    '/lessons#1': { results: [{ id: 'l1', title: 'One' }], next: null }
  });

  assert.deepEqual(await fetchLessons(client, 'course1'), [{ id: 'l1', title: 'One' }]);
  assert.equal(client.calls[0].params.course_id, 'course1');
});

test('fetchLessons paginates too', async () => {
  const client = fakeClient({
    '/lessons#1': { results: [{ id: 'l1' }], next: 'next' },
    '/lessons#2': { results: [{ id: 'l2' }], next: null }
  });
  assert.deepEqual(await fetchLessons(client, 'c'), [{ id: 'l1' }, { id: 'l2' }]);
});

// Without include_content this is just an index of ids, and the push would
// still need a GET per item — which is the whole thing being fixed.
test('fetchContentItems asks for the content, not just the index', async () => {
  const client = fakeClient({
    '/lessons/l1/content-items#1': { results: [{ id: 'i1', content_html: '<p>Hi</p>' }] }
  });

  const items = await fetchContentItems(client, 'l1');
  assert.deepEqual(items, [{ id: 'i1', content_html: '<p>Hi</p>' }]);
  assert.equal(client.calls[0].params.include_content, true);
});

test('fetchContentItems returns an empty list when a lesson has no items', async () => {
  const client = fakeClient({ '/lessons/l1/content-items#1': {} });
  assert.deepEqual(await fetchContentItems(client, 'l1'), []);
});

test('a page with no results array does not throw', async () => {
  const client = fakeClient({ '/courses#1': { next: null } });
  assert.deepEqual(await fetchCourses(client), []);
});
