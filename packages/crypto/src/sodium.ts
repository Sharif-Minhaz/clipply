import sodiumModule from 'libsodium-wrappers';

export type Sodium = typeof sodiumModule;

let ready = false;

/** Must resolve once before any other crypto call (loads libsodium's wasm). */
export async function initCrypto(): Promise<void> {
  await sodiumModule.ready;
  ready = true;
}

export function sodium(): Sodium {
  if (!ready) throw new Error('initCrypto() has not completed');
  return sodiumModule;
}

/** Thrown for every authentication/parse failure; never carries plaintext or key material. */
export class CryptoError extends Error {
  override name = 'CryptoError';
}
