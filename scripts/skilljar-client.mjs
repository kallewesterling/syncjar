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
        return Promise.reject(error);
      }

      config._retryCount = config._retryCount ?? 0;
      if (config._retryCount >= MAX_RETRIES) {
        return Promise.reject(error);
      }

      const attempt = config._retryCount;
      config._retryCount += 1;
      const delay = retryDelayMs(error.response, attempt);
      const status = error.response?.status;
      const reason = status === 429 ? 'throttled' : `server error ${status}`;

      process.stderr.write(
        chalk.yellow(
          `\n⏳ Skilljar ${reason} on ${config.method?.toUpperCase()} ${config.url} — ` +
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
