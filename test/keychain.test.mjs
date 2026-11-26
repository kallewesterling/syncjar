import test from 'node:test';
import assert from 'node:assert/strict';

import { KEYCHAIN_NAMES, readKeychain, withKeychain } from '#lib/keychain.mjs';

/** A stand-in for execFileSync that answers from `store`, recording each call. */
function fakeSecurity(store) {
  const calls = [];
  const run = (file, args) => {
    calls.push({ file, args });
    const account = args[args.indexOf('-a') + 1];
    if (!(account in store)) throw new Error('The specified item could not be found in the keychain.');
    return `${store[account]}\n`;
  };
  return { run, calls };
}

test('readKeychain asks /usr/bin/security for the syncjar item and trims the newline', () => {
  const { run, calls } = fakeSecurity({ SKILLJAR_API_KEY: 'k' });
  assert.equal(readKeychain('SKILLJAR_API_KEY', { platform: 'darwin', run }), 'k');
  assert.deepEqual(calls, [{
    file: '/usr/bin/security',
    args: ['find-generic-password', '-s', 'syncjar', '-a', 'SKILLJAR_API_KEY', '-w']
  }]);
});

test('readKeychain is undefined for a missing item, and never runs off macOS', () => {
  const { run, calls } = fakeSecurity({});
  assert.equal(readKeychain('SKILLJAR_API_KEY', { platform: 'darwin', run }), undefined);
  assert.equal(readKeychain('SKILLJAR_API_KEY', { platform: 'linux', run }), undefined);
  assert.equal(calls.length, 1);
});

test('withKeychain fills only what is unset, so the environment wins', () => {
  const { run, calls } = fakeSecurity({ SKILLJAR_API_KEY: 'from-keychain', SKILLJAR_CLIENT_ID: 'id' });
  const env = { SKILLJAR_API_KEY: 'from-shell' };
  assert.equal(withKeychain(env, { platform: 'darwin', run }), env);
  assert.deepEqual(env, { SKILLJAR_API_KEY: 'from-shell', SKILLJAR_CLIENT_ID: 'id' });
  assert.deepEqual(calls.map((c) => c.args[4]), KEYCHAIN_NAMES.filter((n) => n !== 'SKILLJAR_API_KEY'));
});

test('SYNCJAR_NO_KEYCHAIN keeps the Keychain out entirely', () => {
  const { run, calls } = fakeSecurity({ SKILLJAR_API_KEY: 'k' });
  const env = { SYNCJAR_NO_KEYCHAIN: '1' };
  withKeychain(env, { platform: 'darwin', run });
  assert.deepEqual(env, { SYNCJAR_NO_KEYCHAIN: '1' });
  assert.equal(calls.length, 0);
});
