/**
 * keychain.mjs — Skilljar credentials from the macOS Keychain, so they need
 * not sit in a `.env` file.
 *
 * Each credential is a generic password whose service is `syncjar` and whose
 * account is the variable's name. `-w` last makes `security` prompt for the
 * value, so it never reaches the shell history:
 *
 *   security add-generic-password -U -s syncjar -a SKILLJAR_API_KEY -w
 *
 * The Keychain only fills variables that are not set already, so a variable
 * in the shell or a `.env` file still wins. Nothing is read on import:
 * `security` runs when a client is built, and only on macOS.
 */
import { execFileSync } from 'child_process';

export const KEYCHAIN_SERVICE = 'syncjar';
export const KEYCHAIN_NAMES = ['SKILLJAR_API_KEY', 'SKILLJAR_CLIENT_ID', 'SKILLJAR_CLIENT_SECRET'];

/** Set to anything to keep the Keychain out of it, as the tests do. */
export const KEYCHAIN_OPT_OUT = 'SYNCJAR_NO_KEYCHAIN';

// An absolute path, so a `security` earlier on PATH never sees the request.
const SECURITY = '/usr/bin/security';

/**
 * The value stored for `account`, or undefined when there is none, the
 * Keychain stayed locked, or this is not macOS. The value comes back over a
 * pipe and is never printed. `security`'s stderr is discarded as well.
 */
export function readKeychain(account, { service = KEYCHAIN_SERVICE, platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'darwin') return undefined;
  try {
    const out = run(SECURITY, ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000
    });
    return out.replace(/\r?\n$/, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fills each of `names` that `env` lacks from the Keychain, in place, and
 * returns `env`. Does nothing when SYNCJAR_NO_KEYCHAIN is set.
 */
export function withKeychain(env = process.env, { names = KEYCHAIN_NAMES, ...options } = {}) {
  if (env[KEYCHAIN_OPT_OUT]) return env;
  for (const name of names) {
    if (env[name]) continue;
    const value = readKeychain(name, options);
    if (value) env[name] = value;
  }
  return env;
}
