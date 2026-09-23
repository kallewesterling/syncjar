import axios from 'axios';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

// How many times to retry a request that is throttled (HTTP 429) or hits a
// transient server error (5xx) before giving up.
const MAX_RETRIES = 6;

// Fallback backoff (ms) when the server does not send a Retry-After header.
// Exponential with a small jitter: ~1s, 2s, 4s, 8s, 16s, 32s (capped).
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Skilljar sends `Retry-After` as a number of seconds. Honour it when present,
// otherwise fall back to exponential backoff based on the attempt number.
function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers?.['retry-after'];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      // Add a 500ms cushion so we come back after the window has fully closed.
      return seconds * 1000 + 500;
    }
  }
  const expo = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = Math.floor(expo * 0.25 * Math.random());
  return expo + jitter;
}

function shouldRetry(error) {
  const status = error.response?.status;
  // 429 = throttled; 5xx = transient server error worth retrying.
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Rebuilds a rejected axios error without the parts that carry credentials.
 *
 * An axios error holds `config`, `request` and `response.headers`, and
 * `config.headers.Authorization` is `Basic <base64 of the API key>`. Node
 * prints the whole object for an unhandled rejection, so a single missing
 * try/catch — in a script, or in a throwaway `node -e` one-liner — puts the
 * key in a terminal, a log, or a CI transcript, and a key that gets that far
 * has to be treated as compromised and rotated.
 *
 * Callers are still expected to catch (see failCleanly below); this is the
 * backstop for when one doesn't, because "remember to wrap every call" is a
 * rule that only has to be forgotten once. What survives is what a human
 * needs in order to act: status, a short body, the method and URL, and the
 * original stack, none of which contain the key.
 */
export function redactError(error) {
  const safe = new Error(error.message);
  safe.stack = error.stack;
  if (error.code !== undefined) safe.code = error.code;
  safe.method = error.config?.method?.toUpperCase();
  safe.url = error.config?.url;
  if (error.response) {
    // Deliberately not response.headers: Skilljar does not echo the
    // Authorization header back, but nothing guarantees that, and no consumer
    // in this repo reads them.
    safe.response = {
      status: error.response.status,
      statusText: error.response.statusText,
      data: error.response.data
    };
  }
  return safe;
}

/**
 * Reports a failed Skilljar call and exits 1. **Does not return.**
 *
 * An unhandled axios rejection prints the whole request object — including the
 * Authorization header, which carries the API key in trivially recoverable
 * form. So no catch block may print the error itself: status and a short body
 * only. Every caller of this module's client is expected to route its failures
 * through here.
 */
export function failCleanly(err, context) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  console.error(chalk.red(`\n✗ ${context}`));
  if (status) console.error(chalk.red(`   HTTP ${status}`));
  if (typeof body === 'string' && body.length < 300) {
    console.error(chalk.red(`   ${body}`));
  } else if (body?.detail) {
    console.error(chalk.red(`   ${body.detail}`));
  } else if (!status) {
    console.error(chalk.red(`   ${err?.code || err?.message || 'unknown error'}`));
  }
  if (status === 401 || status === 403) {
    console.error(chalk.yellow('   Check SKILLJAR_API_KEY in .env, and that outbound'));
    console.error(chalk.yellow('   access to api.skilljar.com is permitted from here.'));
  }
  process.exit(1);
}

/**
 * Creates an axios client pre-configured for the Skilljar API with automatic
 * retry on rate limiting (429) and transient server errors, respecting the
 * server's Retry-After header.
 */
export function createSkilljarClient() {
  const apiKey = process.env.SKILLJAR_API_KEY;
  if (!apiKey) {
    throw new Error('SKILLJAR_API_KEY is not set. Add it to your .env file.');
  }

  const client = axios.create({
    baseURL: 'https://api.skilljar.com/v1',
    auth: { username: apiKey, password: '' }
  });

  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config;
      if (!config || !shouldRetry(error)) {
        return Promise.reject(redactError(error));
      }

      config._retryCount = config._retryCount ?? 0;
      if (config._retryCount >= MAX_RETRIES) {
        return Promise.reject(redactError(error));
      }

      const attempt = config._retryCount;
      config._retryCount += 1;
      const delay = retryDelayMs(error.response, attempt);
      const status = error.response?.status;
      const reason = status === 429 ? 'throttled' : `server error ${status}`;

      process.stderr.write(
        chalk.yellow(
          `\nSkilljar ${reason} on ${config.method?.toUpperCase()} ${config.url} — ` +
            `retrying in ${Math.round(delay / 1000)}s ` +
            `(attempt ${config._retryCount}/${MAX_RETRIES})\n`
        )
      );

      await sleep(delay);
      return client(config);
    }
  );

  return client;
}
