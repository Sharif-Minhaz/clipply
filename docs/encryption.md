# Encryption and key management

Status: **primitives implemented and tested in `packages/crypto` (Phase 1)**; the enrollment/recovery/rotation *protocols* (server endpoints, UI) land in Phase 4.

## 1. Goals

The server operator, database admin, hosting provider or anyone with a MongoDB or Cloudinary dump cannot read clipboard content, titles, flags or types. Google sign-in identifies the account only; it never grants vault access and is never key material.

## 2. Primitives (libsodium)

| Purpose | Primitive |
|---|---|
| Content + key wrapping | `crypto_aead_xchacha20poly1305_ietf` (256-bit key, 192-bit random nonce) |
| Keyring delivery to a device | `crypto_box_seal` (X25519 + XSalsa20-Poly1305) |
| Envelope / device-list signatures | `crypto_sign` detached (Ed25519) |
| Subkey derivation | `crypto_kdf_derive_from_key` (BLAKE2b) |
| Keyed content hash | `crypto_generichash` (BLAKE2b-256) keyed with a vault-derived subkey |
| Length hiding | ISO/IEC 7816-4 padding to buckets: 256 B below 4 KiB, 4 KiB below 1 MiB, 64 KiB above |
| Local passphrase (only when no OS keyring) | `crypto_pwhash` Argon2id — **not in the standard `libsodium-wrappers` build** (verified); the desktop app will use `libsodium-wrappers-sumo` for this one path |

XChaCha20 nonces are random (24 bytes), so collision risk is negligible without counters. No custom constructions.

## 3. Key hierarchy

```text
Recovery Key RK (256-bit, shown once to user)
  ├─ kdf(RK, "rec-wrap")  → RWK : encrypts the keyring on the server (recovery envelope)
  └─ kdf(RK, "rec-sign")  → Ed25519 seed : proves recovery enrollment to the server

Vault keyring = { epoch 1: VK1, epoch 2: VK2, ... }   (256-bit random each, generated on a trusted device)
  └─ VKe
      ├─ wraps per-item DEKs created while e is current
      └─ kdf(VKe, "hash")  → content-hash key (dedupe)

Item DEK (256-bit random, one per item)
  ├─ meta ciphertext
  └─ body / blob ciphertext

Device keys (per device, never leave OS storage)
  ├─ X25519 box keypair  : receives sealed keyrings
  └─ Ed25519 sign keypair: signs keyrings it hands out
```

Per-item DEKs mean key rotation and local-vault→account-vault migration re-wrap 72-byte DEKs instead of re-encrypting or re-uploading images.

## 4. Ciphertext format (encVersion 1)

Every ciphertext is `nonce(24) || aead_ciphertext`. AAD binds each part to its place, so the server cannot swap ciphertexts between items or fields:

```text
AAD = "clipply/v1/" + itemId + "/" + part     part ∈ {dek, meta, body, thumb}
dek  = AEAD(VKe,  DEK,                 AAD(dek))   ; keyEpoch e stored in clear
meta = AEAD(DEK,  pad(JSON(ItemMeta)), AAD(meta))
body = AEAD(DEK,  pad(content),        AAD(body))  ; or the Cloudinary blob for large content
thumb = AEAD(DEK,  pad(webp thumbnail), AAD(thumb)) ; images only
```

`userId` is deliberately not in the AAD: items are created before any account exists (local-only mode), and binding to the globally unique item id already prevents swaps; different users never share a vault key. The body uses the same `body` AAD whether it travels inline or as a Cloudinary blob.

The envelope signature covers `"clipply/v1/envelope/" + deviceId + "/" + epoch + "/" ‖ sealed`. The recovery envelope uses AAD `clipply/v1/recovery`. Recovery keys display as 55 Crockford base32 characters (key + 16-bit checksum) in groups of 5; parsing accepts lower case, spaces and I/L/O look-alikes.

Cross-platform vectors: `packages/crypto/vectors/item-v1.json` (fixed keys and nonces → exact bytes). The Kotlin implementation must reproduce them. The XChaCha20-Poly1305 primitive is also checked against draft-irtf-cfrg-xchacha §A.3.1.

`encVersion` is in clear so the format can evolve; clients reject unknown versions.

## 5. Device enrollment

A new device generates its keys locally, signs in with Google, and registers (`status: pending`). Getting the keyring requires one of:

**A. Approval from a trusted device (SAS-verified)**
1. Trusted device T opens the pending request and posts its claim (its public keys).
2. Both devices show a 12-digit code (`1234 5678 9012`, ~40 bits) from `BLAKE2b("clipply/v1/sas/"‖pkN_box‖pkN_sign‖pkT_box‖pkT_sign)`.
3. User confirms the codes match **on both devices**. A server substituting either key makes them differ.
4. T posts `KeyEnvelope{ sealed = box_seal(keyring, pkN_box), signature = sign_T(deviceId‖epoch‖sealed) }`; the server marks N authorized only when an authorized device posts it.
5. N verifies the signature against the pkT it confirmed, opens the box, stores the keyring in OS storage.

**B. Recovery key**
1. User enters RK on N. N derives RWK and the recovery signing key.
2. N proves possession by signing a server challenge; the server checks it against the stored recovery public key and authorizes N.
3. N downloads and decrypts the recovery envelope (AEAD under RWK — the server cannot forge it), then seals the keyring to itself.

The first device of an account creates the keyring and RK, uploads its own envelope and the recovery envelope, and forces the user to save RK (shown once; confirmation by re-typing a group).

## 6. Revocation and rotation

1. An authorized device revokes D: server marks D revoked, deletes D's envelopes and refresh tokens; D's API calls fail immediately.
2. The revoking device generates VK(e+1), builds keyring {…, e+1}, seals it to every remaining authorized device (signed), and replaces the recovery envelope.
3. The server sets the account's `keyEpoch = e+1` and rejects new uploads under older epochs (`stale_epoch`), so offline devices must pick up the new keyring before writing.
4. Existing items stay under their epoch: D could already read them; re-encrypting gains nothing. New items use e+1, which D never receives.

Keyring continuity: a device accepts a new keyring only if it contains every epoch key it already holds, byte-identical, and is signed by a device it trusts. A server alone cannot produce such a keyring.

## 7. Recovery and total loss

- RK can be re-generated from any authorized device (new RK → new recovery envelope + recovery public key; old RK stops working).
- If every authorized device **and** RK are lost, the data is **unrecoverable by design**. The user can reset the vault, which deletes all server ciphertext and starts a new keyring. There is no server-side master key.

## 8. Threat model

Protected against: MongoDB or Cloudinary dump; curious or compromised server reading content; server swapping or replaying ciphertexts across items; server injecting its own vault key during enrollment (SAS + signatures); stolen refresh token on a revoked device; tampered ciphertext (AEAD fails, item shown as corrupt, never partially decrypted).

Not protected against (known limitations):
- A compromised unlocked device (malware with the user's privileges reads the keyring from libsecret / process memory).
- **Metadata**: the server sees account identity, device names/platforms, item counts, padded sizes, timing, IPs.
- **Rollback/withholding**: the server can withhold changes or replay an older revision of an item; clients detect `rev` regressions only for items they already have.
- **Revoked device + malicious server collusion**: until the signed device list (Phase 7) lands, a revoked device's still-valid signing key could be used by a colluding server to push a forged keyring to devices that have not yet seen the revocation.
- Android crypto in the WebView keeps keys in JS memory while the app is open.

## 9. Tests required (Phase 1 / 4)

Round-trip for every part; tamper (bit flip, swapped AAD, wrong epoch) fails; nonce uniqueness; TS ↔ Kotlin vectors (fixed keys + nonces → identical bytes); envelope signature + continuity rejection; recovery derivation vectors; "no plaintext on the wire" test that intercepts API requests in an end-to-end run.
