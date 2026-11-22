import { beforeAll, describe, expect, it } from 'vitest';
import type { ItemMeta } from '@clipply/shared-schemas';

import { open, pad, seal, unpad } from './aead';
import { sodium } from './sodium';
import { fromUtf8, toB64, utf8 } from './encoding';
import {
  CryptoError, contentHash, createKeyring, deriveRecoveryKeys, enrollmentCode, extendsKeyring,
  formatRecoveryKey, generateDek, generateDeviceKeys, generateRecoveryKey, initCrypto, itemAad,
  openKeyringEnvelope, openMeta, openPart, openRecoveryEnvelope, parseKeyring, parseRecoveryKey,
  rotateKeyring, sealKeyringFor, sealMeta, sealPart, sealRecoveryEnvelope, serializeKeyring,
  unwrapDek, wrapDek,
} from './index';

beforeAll(initCrypto);

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const flip = (b: Uint8Array, i = b.length - 1): Uint8Array => {
  const c = b.slice();
  c[i]! ^= 1;
  return c;
};

const ID_A = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const ID_B = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const meta: ItemMeta = {
  kind: 'text', mime: 'text/plain', createdAt: 1_700_000_000_000, originDeviceId: ID_B, size: 5,
  contentHash: 'a'.repeat(64), favorite: false, pinned: true,
};

describe('aead', () => {
  it('matches the draft-irtf-cfrg-xchacha A.3.1 test vector', () => {
    const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const nonce = hex('404142434445464748494a4b4c4d4e4f5051525354555657');
    const aadBytes = hex('50515253c0c1c2c3c4c5c6c7');
    const pt = utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const expected =
      'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e' +
      'c0875924c1c7987947deafd8780acf49';
    // The vector's AAD is not UTF-8, so the primitive is checked directly...
    expect(toHex(sodium().crypto_aead_xchacha20poly1305_ietf_encrypt(pt, aadBytes, null, nonce, key))).toBe(expected);
    // ...and seal() is checked to be exactly nonce || that primitive's output.
    const sealed = seal(key, pt, 'clipply', nonce);
    expect(toHex(sealed.subarray(0, 24))).toBe(toHex(nonce));
    expect(toHex(sealed.subarray(24))).toBe(toHex(sodium().crypto_aead_xchacha20poly1305_ietf_encrypt(pt, utf8('clipply'), null, nonce, key)));
    expect(open(key, sealed, 'clipply')).toEqual(pt);
  });

  it('pads to size buckets and round-trips', () => {
    expect(pad(new Uint8Array(0)).length).toBe(256);
    expect(pad(new Uint8Array(255)).length).toBe(256);
    expect(pad(new Uint8Array(256)).length).toBe(512);
    expect(pad(new Uint8Array(5000)).length).toBe(8192);
    expect(pad(new Uint8Array(2 << 20)).length % 65536).toBe(0);
    const data = Uint8Array.from([1, 0, 0, 0x80, 0]);
    expect(unpad(pad(data))).toEqual(data);
    expect(() => unpad(new Uint8Array(16))).toThrow(CryptoError);
  });

  it('uses a fresh nonce per encryption', () => {
    const key = generateDek();
    expect(toHex(seal(key, utf8('x'), 'a'))).not.toBe(toHex(seal(key, utf8('x'), 'a')));
  });
});

describe('item encryption', () => {
  it('round-trips dek, meta, body and thumb', () => {
    const ring = createKeyring();
    const dek = generateDek();
    const wrapped = wrapDek(ring, ID_A, dek);
    expect(wrapped.keyEpoch).toBe(1);
    const dek2 = unwrapDek(ring, ID_A, wrapped);
    expect(dek2).toEqual(dek);
    expect(openMeta(dek2, ID_A, sealMeta(dek, ID_A, meta))).toEqual(meta);
    expect(fromUtf8(openPart(dek2, ID_A, 'body', sealPart(dek, ID_A, 'body', utf8('hello'))))).toBe('hello');
    expect(openPart(dek2, ID_A, 'thumb', sealPart(dek, ID_A, 'thumb', Uint8Array.of(9, 9)))).toEqual(Uint8Array.of(9, 9));
  });

  it('rejects tampering, swapped items, swapped parts and wrong vaults', () => {
    const ring = createKeyring();
    const dek = generateDek();
    const body = sealPart(dek, ID_A, 'body', utf8('secret'));
    expect(() => openPart(dek, ID_A, 'body', flip(body))).toThrow(CryptoError);
    expect(() => openPart(dek, ID_A, 'body', flip(body, 0))).toThrow(CryptoError);
    expect(() => openPart(dek, ID_B, 'body', body)).toThrow(CryptoError);
    expect(() => openPart(dek, ID_A, 'thumb', body)).toThrow(CryptoError);
    const wrapped = wrapDek(ring, ID_A, dek);
    expect(() => unwrapDek(createKeyring(), ID_A, wrapped)).toThrow(CryptoError);
    expect(() => unwrapDek(ring, ID_A, { ...wrapped, keyEpoch: 2 })).toThrow(/unknown key epoch/);
  });

  it('rejects decrypted metadata that fails validation', () => {
    const dek = generateDek();
    const bad = seal(dek, pad(utf8('{"kind":"virus"}')), itemAad(ID_A, 'meta'));
    expect(() => openMeta(dek, ID_A, bad)).toThrow(/validation/);
  });
});

describe('keyring', () => {
  it('rotates, keeps old epochs readable and serializes', () => {
    const ring = createKeyring();
    const dek = generateDek();
    const old = wrapDek(ring, ID_A, dek);
    const next = rotateKeyring(ring);
    expect(next.current).toBe(2);
    expect(wrapDek(next, ID_A, dek).keyEpoch).toBe(2);
    const restored = parseKeyring(serializeKeyring(next));
    expect(unwrapDek(restored, ID_A, old)).toEqual(dek);
    expect(extendsKeyring(next, ring)).toBe(true);
    expect(extendsKeyring(ring, next)).toBe(false);
    expect(extendsKeyring(rotateKeyring(createKeyring()), ring)).toBe(false);
  });

  it('rejects malformed keyrings', () => {
    expect(() => parseKeyring(utf8('nope'))).toThrow(CryptoError);
    expect(() => parseKeyring(utf8(JSON.stringify({ v: 1, current: 2, keys: { 1: toB64(new Uint8Array(32)) } })))).toThrow(/missing/);
    expect(() => parseKeyring(utf8(JSON.stringify({ v: 1, current: 1, keys: { 1: toB64(new Uint8Array(31)) } })))).toThrow(/missing/);
  });

  it('content hash is stable across rotation and differs between vaults', () => {
    const ring = createKeyring();
    const h = contentHash(ring, utf8('same'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(rotateKeyring(ring), utf8('same'))).toBe(h);
    expect(contentHash(createKeyring(), utf8('same'))).not.toBe(h);
  });
});

describe('device envelopes', () => {
  let ring: ReturnType<typeof createKeyring>;
  beforeAll(() => {
    ring = createKeyring();
  });

  it('delivers the keyring to the intended device only', () => {
    const approver = generateDeviceKeys();
    const target = generateDeviceKeys();
    const env = sealKeyringFor(ring, ID_A, target.box.publicKey, approver.sign.privateKey);
    const got = openKeyringEnvelope(env, ID_A, target.box, approver.sign.publicKey);
    expect(extendsKeyring(got, ring) && extendsKeyring(ring, got)).toBe(true);

    const other = generateDeviceKeys();
    expect(() => openKeyringEnvelope(env, ID_A, other.box, approver.sign.publicKey)).toThrow(/cannot be opened/);
    expect(() => openKeyringEnvelope(env, ID_B, target.box, approver.sign.publicKey)).toThrow(/signature/);
    expect(() => openKeyringEnvelope(env, ID_A, target.box, other.sign.publicKey)).toThrow(/signature/);
    expect(() => openKeyringEnvelope({ ...env, epoch: 2 }, ID_A, target.box, approver.sign.publicKey)).toThrow(/signature/);
  });

  it('rejects an envelope forged by a key the user never confirmed', () => {
    const attacker = generateDeviceKeys();
    const approver = generateDeviceKeys();
    const target = generateDeviceKeys();
    const forged = sealKeyringFor(createKeyring(), ID_A, target.box.publicKey, attacker.sign.privateKey);
    expect(() => openKeyringEnvelope(forged, ID_A, target.box, approver.sign.publicKey)).toThrow(/signature/);
  });

  it('enrollment code is symmetric for the same keys and changes if any key is swapped', () => {
    const n = generateDeviceKeys();
    const t = generateDeviceKeys();
    const pub = (k: typeof n) => ({ boxPublicKey: k.box.publicKey, signPublicKey: k.sign.publicKey });
    const code = enrollmentCode(pub(n), pub(t));
    expect(code).toMatch(/^\d{4} \d{4} \d{4}$/);
    expect(enrollmentCode(pub(n), pub(t))).toBe(code);
    expect(enrollmentCode(pub(n), pub(generateDeviceKeys()))).not.toBe(code);
    expect(enrollmentCode({ ...pub(n), boxPublicKey: generateDeviceKeys().box.publicKey }, pub(t))).not.toBe(code);
  });
});

describe('recovery', () => {
  it('formats, tolerates look-alikes and catches typos', () => {
    const rk = generateRecoveryKey();
    const text = formatRecoveryKey(rk);
    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(parseRecoveryKey(text.toLowerCase().replace(/-/g, ' '))).toEqual(rk);
    expect(parseRecoveryKey(text.replace(/1/g, 'l').replace(/0/g, 'O'))).toEqual(rk);
    const typo = (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
    expect(() => parseRecoveryKey(typo)).toThrow(CryptoError);
    expect(() => parseRecoveryKey(text.slice(0, 20))).toThrow(/length/);
  });

  it('derives deterministic keys and round-trips the recovery envelope', () => {
    const rk = generateRecoveryKey();
    const keys = deriveRecoveryKeys(rk);
    expect(deriveRecoveryKeys(rk.slice()).sign.publicKey).toEqual(keys.sign.publicKey);
    const ring = rotateKeyring(createKeyring());
    const env = sealRecoveryEnvelope(ring, keys);
    expect(extendsKeyring(openRecoveryEnvelope(env, keys), ring)).toBe(true);
    expect(() => openRecoveryEnvelope(env, deriveRecoveryKeys(generateRecoveryKey()))).toThrow(CryptoError);
  });
});

describe('cross-platform vectors', () => {
  it('pins the v1 item format (consumed by the Kotlin implementation)', async () => {
    const vk = hex('00'.repeat(31) + '01');
    const dek = hex('11'.repeat(32));
    const nonce = (b: string): Uint8Array => hex(b.repeat(24));
    const ring = { current: 1, keys: new Map([[1, vk]]) };
    const body = utf8('Hello, Clipply! 👋');
    const vector = {
      itemId: ID_A,
      vaultKeyEpoch1: toHex(vk),
      dek: toHex(dek),
      body: toHex(body),
      aad: { dek: itemAad(ID_A, 'dek'), body: itemAad(ID_A, 'body') },
      wrappedDek: toHex(seal(vk, dek, itemAad(ID_A, 'dek'), nonce('a1'))),
      bodyCiphertext: toHex(seal(dek, pad(body), itemAad(ID_A, 'body'), nonce('b2'))),
      contentHash: contentHash(ring, body),
    };
    expect(unwrapDek(ring, ID_A, { keyEpoch: 1, dek: hex(vector.wrappedDek) })).toEqual(dek);
    expect(openPart(dek, ID_A, 'body', hex(vector.bodyCiphertext))).toEqual(body);
    await expect(JSON.stringify(vector, null, 2) + '\n').toMatchFileSnapshot('../vectors/item-v1.json');
  });
});
