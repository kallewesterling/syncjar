/**
 * client-v2.mjs — the Skilljar API v2 (https://api.skilljar.com/v2/docs).
 *
 * v2 does not take the v1 API key. An OAuth client (SKILLJAR_CLIENT_ID and
 * SKILLJAR_CLIENT_SECRET) is exchanged at POST /v2/auth/token for a JWT that
 * lasts `expires_in` seconds, and each operation needs particular scopes on
 * that client. So a client can be issued for one job only: one holding just
 * `student-groups:read`, `student-groups:write` and `students:read` can
 * manage group membership and nothing else, where the v1 key can do anything,
 * including irreversible PII erasure.
 *
 * Paths are relative to `/v2`, as v1's are to `/v1`, and keep the spec's
 * trailing slashes: `client.get('/groups/')`, `client.get('/groups/{id}')`.
 */
import axios from 'axios';
import { attachRetries } from '#lib/skilljar/client.mjs';

export const V2_BASE_URL = 'https://api.skilljar.com/v2';

// Fetch a new token this long before the old one expires, so a request
// never leaves with a token that lapses in flight.
const TOKEN_MARGIN_MS = 60_000;

// The largest page[size] v2 list endpoints accept.
export const V2_PAGE_SIZE = 100;

/**
 * Builds an axios client for v2. Throws when the OAuth credentials are not
 * set, so call it inside a command's run, never at module scope.
 *
 * Every rejected error is redacted (see `redactError`), which matters twice
 * over here: the token request's body carries the client secret, and every
 * other request's Authorization header carries a live bearer token.
 */
export function createSkilljarV2Client({ env = process.env, baseURL = V2_BASE_URL, now = Date.now } = {}) {
  const clientId = env.SKILLJAR_CLIENT_ID;
  const clientSecret = env.SKILLJAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET are not set. Add them to your .env file.');
  }

  const auth = attachRetries(axios.create({ baseURL }));
  let token = null;
  let expiresAt = 0;
  let pending = null;

  function accessToken({ force = false } = {}) {
    if (!force && token && now() < expiresAt - TOKEN_MARGIN_MS) return Promise.resolve(token);
    pending ??= auth
      .post('/auth/token', { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
      .then(({ data }) => {
        token = data.access_token;
        expiresAt = now() + data.expires_in * 1000;
        return token;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  const client = axios.create({
    baseURL,
    headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/json' }
  });

  client.interceptors.request.use(async (config) => {
    config.headers.Authorization = `Bearer ${await accessToken()}`;
    return config;
  });

  // A token can be revoked or expire early. Fetch a new one and retry once.
  // Registered before attachRetries, which redacts, so this still sees the
  // raw error and its config.
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config;
      if (!config || error.response?.status !== 401 || config._tokenRefreshed) {
        return Promise.reject(error);
      }
      config._tokenRefreshed = true;
      await accessToken({ force: true });
      return client(config);
    }
  );

  return attachRetries(client);
}

/**
 * The cursor in a v2 `links.next`, or null on the last page. Read out of the
 * link rather than requesting the link itself, so that a link carrying the
 * `/v2` prefix cannot resolve to `/v2/v2/…` against the base URL.
 */
export function nextCursor(links) {
  if (!links?.next) return null;
  return new URL(links.next, V2_BASE_URL).searchParams.get('page[cursor]');
}

/**
 * Every record of a cursor-paginated v2 list, at the largest page size.
 */
export async function listAllV2(client, url, params = {}) {
  const records = [];
  let cursor = null;
  do {
    const { data } = await client.get(url, {
      params: { ...params, 'page[size]': V2_PAGE_SIZE, ...(cursor ? { 'page[cursor]': cursor } : {}) }
    });
    records.push(...(data.data ?? []));
    cursor = nextCursor(data.links);
  } while (cursor);
  return records;
}

/**
 * The lines failCleanly prints on a 401 or 403 from v2.
 */
export const V2_CREDENTIALS_HINT = [
  'Check SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET in .env.',
  'A 403 usually means the API client lacks a scope this command needs.'
];
