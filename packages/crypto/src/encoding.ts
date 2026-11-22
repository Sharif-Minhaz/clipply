import { CryptoError, sodium } from './sodium';

/** Unpadded base64url — the wire encoding used by shared-schemas. */
export function toB64(bytes: Uint8Array): string {
  return sodium().to_base64(bytes, sodium().base64_variants.URLSAFE_NO_PADDING);
}

export function fromB64(text: string): Uint8Array {
  try {
    return sodium().from_base64(text, sodium().base64_variants.URLSAFE_NO_PADDING);
  } catch {
    throw new CryptoError('invalid base64url');
  }
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford base32: no I, L, O, U, so hand-typed recovery keys survive common misreads. */
export function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) throw new CryptoError('invalid base32 character');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}
